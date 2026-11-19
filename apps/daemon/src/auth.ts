import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";

/**
 * Zugangsschutz für den Daemon.
 *
 * Was das Token leistet: Es hält Webseiten fern, die im Browser auf 127.0.0.1 zugreifen, und
 * es ist die Voraussetzung dafür, den Port überhaupt jemals über die Maschine hinaus zu
 * öffnen. Was es NICHT leistet: Schutz vor einem Programm, das ohnehin unter deinem Benutzer
 * läuft — das liest die Tokendatei genauso wie jeder erlaubte Client.
 *
 * Die zweite Hälfte ist die Prüfung des Host-Kopfs. Ohne sie könnte eine Domain, die auf
 * 127.0.0.1 zeigt (DNS-Rebinding), aus dem Browser heraus als gleiche Herkunft gelten und
 * den Schutz der Browser-Herkunftsregeln aushebeln.
 */

export function tokenPath(): string {
  return process.env.CREWPIP_TOKEN_FILE ?? path.join(os.homedir(), ".crewpip", "token");
}

/** Liest das Token oder legt es beim ersten Start an. Datei nur für den Eigentümer lesbar. */
export function loadOrCreateToken(): string {
  const fromEnv = process.env.CREWPIP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Noch keins vorhanden: unten anlegen.
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

export function readToken(): string | null {
  const fromEnv = process.env.CREWPIP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(tokenPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Zeitkonstanter Vergleich, damit die Antwortdauer nichts über das Token verrät. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function tokenFromRequest(req: Request): string | null {
  const header = req.get("x-crewpip-token");
  if (header) return header.trim();
  const auth = req.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/** Nur Anfragen an den Rechner selbst. Fremde Host-Köpfe deuten auf DNS-Rebinding. */
export function hostAllowed(host: string | undefined, extra: string[]): boolean {
  if (!host) return false;
  if (LOOPBACK_HOST.test(host)) return true;
  return extra.includes(host.toLowerCase());
}

export interface AuthOptions {
  token: string;
  /** true schaltet die Prüfung ab. Nur zur Fehlersuche. */
  disabled?: boolean;
  /** Zusätzlich erlaubte Host-Köpfe, etwa für den Zugriff über Tailscale. */
  allowedHosts?: string[];
  log?: (l: string) => void;
}

export function createAuth(opts: AuthOptions) {
  const allowedHosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase());

  return function auth(req: Request, res: Response, next: NextFunction): void {
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      opts.log?.(`[auth] Host abgelehnt: ${req.headers.host}`);
      res.status(421).json({ error: "Unerwarteter Host" });
      return;
    }
    // Eine fremde Herkunft heißt: die Anfrage kommt aus einer Webseite, nicht aus crewpip.
    const origin = req.get("origin");
    if (origin && !hostAllowed(new URL(origin).host, allowedHosts)) {
      opts.log?.(`[auth] Herkunft abgelehnt: ${origin}`);
      res.status(403).json({ error: "Unerlaubte Herkunft" });
      return;
    }
    if (opts.disabled) {
      next();
      return;
    }
    const given = tokenFromRequest(req);
    if (!given || !sameToken(given, opts.token)) {
      res.status(401).json({ error: "Token fehlt oder stimmt nicht. Es steht in ~/.crewpip/token." });
      return;
    }
    next();
  };
}

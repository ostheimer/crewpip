import os from "node:os";
import path from "node:path";

const env = process.env;

export const config = {
  host: env.CREWPIP_HOST ?? "127.0.0.1",
  port: Number(env.CREWPIP_PORT ?? 7357),
  dbPath: env.CREWPIP_DB ?? path.join(os.homedir(), ".crewpip", "crewpip.db"),
  /** Obergrenze für automatische Fortsetzungen am Turn-Ende, pro Agent, bis zum nächsten menschlichen Prompt. */
  maxStopContinuations: Number(env.CREWPIP_MAX_STOP_CONTINUATIONS ?? 10),
  /** Längste Wartezeit des MCP-Tools wait_for_message. Cursor bricht Tool-Aufrufe nach etwa 60 s ab. */
  maxWaitSeconds: Number(env.CREWPIP_MAX_WAIT_SECONDS ?? 50),
  defaultWaitSeconds: Number(env.CREWPIP_DEFAULT_WAIT_SECONDS ?? 25),
};

export function baseUrl(): string {
  return `http://${config.host}:${config.port}`;
}

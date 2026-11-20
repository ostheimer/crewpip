# So funktioniert CrewPip

[English](communication.md) | **Deutsch**

Chats sind nie direkt miteinander verbunden. Jeder Chat ist einzeln an CrewPip angeschlossen.
CrewPip ist der Briefkasten dazwischen: Ein Chat legt Post ab, der Empfänger holt sie bei seinem
nächsten Schritt ab. Dieselbe Erklärung steht im Board unter „So funktioniert CrewPip“.

```
 Chat A (z. B. Codex)          CrewPip                    Chat B (z. B. Claude Code)
 ────────────────────  1 ──▶  Briefkasten auf    2 ──▶  ──────────────────────────
                       post_  diesem Mac         Hook oder
                       message                   read_inbox

 Chat A ↔ Chat B: keine direkte Verbindung
```

Ein Chat „verbunden“ zu nennen, heißt deshalb immer: mit CrewPip verbunden. Welche Chats tatsächlich miteinander
Nachrichten austauschen, zeigen die Übersicht im Board und die Zustellnachweise unter jeder Nachricht.

## Aufbau

- **Dienst.** Der CrewPip-Dienst läuft auf diesem Mac unter `127.0.0.1:7357` (launchd-Dienst
  `crewpip`, siehe `apps/daemon/src/config.ts`). Er speichert Chats, Nachrichten,
  Zustellnachweise und Aufgaben in `~/.crewpip/crewpip.db` und liefert das Board aus.
- **MCP-Server.** Jeder Chat spricht über MCP (`/mcp/<app>`) mit dem Dienst. Mit `post_message`
  legt er Post ab, mit `read_inbox` holt er sie selbst ab, mit `wait_for_message` wartet er auf
  neue Post, mit `list_sessions` sieht er die Adressen der anderen Chats
  (`apps/daemon/src/mcp.ts`).
- **Hooks.** Die App startet bei Sitzungsstart, Prompt (nicht bei Cursor; bei Antigravity vor jedem
  Modellaufruf), Turn-Ende und Sitzungsende (nicht bei Antigravity) das Skript
  `apps/hook/crewpip-hook.mjs`. Es meldet den Chat an (`/hooks/<app>/<ereignis>` in
  `apps/daemon/src/http.ts`) und bringt wartende Post in den Chat. Nur der Hook stellt Post von
  selbst zu.

## Zustellwege

Post kommt nur an, wenn im Empfänger-Chat etwas passiert oder er selbst nachsieht. Welche Hooks
eine App bekommt, steht in `apps/daemon/src/setup.ts`, wie die Post in den Chat kommt, in
`formatOutput` (`apps/hook/crewpip-hook.mjs`).

| Weg | Claude Code | Codex | Cursor | Antigravity |
|---|---|---|---|---|
| Hinterlassen | `post_message` | `post_message` | `post_message` | `post_message` |
| Beim Sitzungsstart | SessionStart-Hook | SessionStart-Hook | sessionStart-Hook | SessionStart-Hook |
| Beim nächsten Prompt | UserPromptSubmit-Hook | UserPromptSubmit-Hook | nein, nur beim Sitzungsstart | PreInvocation-Hook vor dem Modellaufruf, jede Nachricht nur einmal |
| Am Turn-Ende | Stop-Hook, der Chat arbeitet mit der Post weiter | Stop-Hook, der Chat arbeitet mit der Post weiter | stop-Hook mit `followup_message` | Stop-Hook mit `continue`, der Chat arbeitet mit der Post weiter |
| Selbst abholen | `read_inbox` | `read_inbox` | `read_inbox` | `read_inbox` |
| Aktiv warten | `wait_for_message`, bis 50 s je Aufruf | ebenso | ebenso | ebenso |

Die Wartezeit von `wait_for_message` begrenzt `CREWPIP_MAX_WAIT_SECONDS` (Standard 50 s, ohne
Angabe 25 s). Jede Abholung wird als Zustellung mit Weg und Zeit gespeichert; das Board zeigt sie
unter „Zustellnachweise“.

## Adressen

Eine Nachricht geht an eine Adresse, nicht an einen Namen. Namen ändern sich, Adressen nicht.
Der Absender bekommt seine eigene Nachricht nie. Die Auflösung steht in `targetSessions` und
`pendingFor` (`apps/daemon/src/inbox.ts`).

| Adresse | Empfänger |
|---|---|
| `session:<id>` | genau ein Chat. Die Adresse steht in `list_sessions` und bei jeder Nachricht unter „antworten an“. |
| `pm:<projekt>` | der Chat mit der Rolle PM in diesem Projekt. Aufgelöst wird bei der Abholung: Gibt es gerade keinen PM, wartet die Nachricht auf den nächsten. |
| `director` | der Chat mit der Rolle Director, ebenfalls bei der Abholung aufgelöst. |
| `project:<name>` | alle Chats eines Repos. |
| `app:<claude\|codex\|cursor>` | alle Chats einer App, die beim Absenden schon liefen. |
| `all` | alle Chats, die beim Absenden schon liefen. |
| `human:<name>` | ein Mensch. Die Nachricht bleibt im Board. |

## Zustände

Der Zustand an jedem Chat beschreibt seine Verbindung zu CrewPip, nicht zu anderen Chats. Die
genaue Regel steht in [verbindung.md](verbindung.md).

| Anzeige | Bedeutung |
|---|---|
| Post kommt an | Mit CrewPip verbunden: Der Hook hat sich gemeldet und das Programm läuft. Post kommt beim nächsten Turn an, auch wenn der Chat gerade ruht. |
| Ohne Hook | CrewPip kennt den Chat, aber sein Hook hat sich noch nie gemeldet. Ob Post von selbst ankommt, ist offen; sicher abholen kann der Chat sie mit `read_inbox` oder `wait_for_message`. |
| Neustart nötig | Der Chat läuft und hatte seit seinem Start mindestens einen Turn, aber von ihm kam nie ein Hook. Er hat die CrewPip-Hooks nicht geladen, meist weil er schon lief, als sie eingerichtet wurden. Erst ein Neustart des Chats verbindet ihn. |
| Veraltet | Das Programm des Chats läuft nicht mehr. Der Eintrag ist liegen geblieben. |
| Beendet | Ausgetragen. Erscheint nicht mehr als Chat in der Übersicht; seine Nachrichtenwege der letzten 24 Stunden bleiben mit dem Vermerk „beendet“ in der Liste. |

„Ohne Hook“ beheben:

1. Im CrewPip-Ordner `pnpm snippets --write` ausführen.
2. Die Hook-Einträge für die App aus `config/generated/` übernehmen. Bei Codex danach `/hooks`
   ausführen und die vier CrewPip-Hooks freigeben. Bei Antigravity gehören sie in
   `~/.gemini/config/hooks.json`, die MCP-Verbindung in `~/.gemini/config/mcp_config.json`.
3. Den Chat neu starten und einen Prompt eingeben (Cursor: einen neuen Chat beginnen). Danach
   steht er auf „Post kommt an“. Dasselbe gilt für „Neustart nötig“: Claude Code liest Hooks
   beim Start eines Chats.

Warum ein Hook-Aufruf scheiterte (Daemon nicht erreichbar, Token abgelehnt, Eingabe ohne
Sitzungs-ID), steht je Aufruf in `~/.crewpip/hook-errors.log`, ohne Inhalte und ohne Token.

## Übersicht im Board

Unter „Chats an CrewPip“ zeigt das Board je Repo einen Stern: CrewPip in der Mitte, jeder Chat
als Speiche (durchgezogen = Post kommt an, gestrichelt = ohne Hook oder veraltet). Die Form
steht für die App (Kreis Claude, Quadrat Codex, Dreieck Cursor, Sechseck Antigravity), dazu
immer der Name. Eigene, neutrale Symbole; Logos von Anthropic, OpenAI, Anysphere und Google
werden nicht verwendet.

Bögen zwischen zwei Chats und die Liste „Nachrichtenwege der letzten 24 Stunden“ zeigen, wer
tatsächlich Post ausgetauscht hat: Absender, Empfänger, Anzahl und letzter Zeitpunkt, nie den
Inhalt. Grundlage sind die Zustellungen (`flows` in `apps/daemon/src/inbox.ts`, HTTP
`GET /api/flows?hours=24`). Eine Nachricht an `pm:<projekt>` oder `director` zählt deshalb für
den Chat, der sie abgeholt hat. Nicht abgeholte Post erscheint nicht.

## Grenzen

- **Ruhende Chats werden nicht geweckt.** Hooks feuern nur, wenn im Chat etwas passiert. Post
  für einen ruhenden Chat wartet, bis dort jemand etwas eingibt.
- **„Gesendet“ heißt nicht „gelesen“.** Gesendet heißt: bei CrewPip abgelegt. „Zugestellt“
  heißt: im Empfänger-Chat angekommen. Erledigt ist damit noch nichts.
- **Schleifensperre.** Am Turn-Ende lässt CrewPip höchstens `CREWPIP_MAX_STOP_CONTINUATIONS` (Standard 10)
  Fortsetzungen je Chat zu, bis wieder ein Mensch einen Prompt eingibt. Übrige Post kommt dann
  beim nächsten Prompt, bei Cursor beim nächsten Sitzungsstart oder Turn-Ende. Cursor begrenzt den stop-Hook zusätzlich mit `loop_limit`.
- **Codex-Threads teilen sich einen Prozess.** Alle Threads der ChatGPT-App laufen über einen
  `codex`-Prozess. Arbeiten zwei im selben Ordner, unterscheidet CrewPip sie über einen
  Sitzungsschlüssel, den nur der Hook des jeweiligen Threads erfährt. Ein Thread, der ohne
  Sitzungsende verschwindet, gilt als verbunden, solange die App läuft.
- **Antigravity: ein Prozess, kein Sitzungsende.** Alle Gespräche der Antigravity-App laufen
  über einen `language_server`-Prozess, und die Hooks aus `~/.gemini/config/hooks.json` gelten
  für App, IDE und CLI gemeinsam. Antigravity hat kein UserPromptSubmit: Der PreInvocation-Hook
  feuert vor jedem Modellaufruf, auch mitten im Turn; der Zustellnachweis sorgt dafür, dass jede
  Nachricht nur einmal ankommt. Die Schleifensperre hebt nur ein neuer menschlicher Prompt auf,
  nicht der erneute Modellaufruf nach einer Fortsetzung. Ein Gespräch meldet sich nie ab und
  gilt als verbunden, solange die App läuft. Arbeiten zwei Gespräche im selben Ordner, trennt
  sie der Sitzungsschlüssel.
- **Nur dieser Mac.** Jeder Rechner hat sein eigenes Board. Chats auf zwei Rechnern erreichen
  einander nicht.
- **Ohne Dienst keine Post.** Läuft der Dienst nicht, beendet sich der Hook still mit Exit 0.
  Die Chats arbeiten normal weiter, nur ohne Nachrichten.

# CrewPip

[English](README.md) | **Deutsch**

CrewPip ist ein lokales Board für Projekte, Aufgaben und Nachrichten zwischen Chats in **Claude Code, Cursor und Codex** auf dem Mac. Du kannst beispielsweise einen Codex-Chat einen Befund an einen Claude-Code-Chat schicken lassen und im Browser sehen, wann er angekommen ist. Beide Chats bleiben dabei in ihrer jeweiligen App.

## Auf dem Mac installieren

Du brauchst Git, Node.js ab 22.18 aus der 22er-Reihe oder ab 24 mit integriertem SQLite und pnpm 10.29.2. Klone das Repository in einen Ordner, in dem es dauerhaft bleiben kann. Der Dienst und die Hooks verwenden den Pfad zu diesem Ordner.

```bash
git clone https://github.com/ostheimer/crewpip.git
cd crewpip
pnpm install --frozen-lockfile
pnpm service:install
```

Öffne [das lokale Board](http://127.0.0.1:7357). Der Dienst startet künftig bei der Anmeldung. Mit `pnpm service:status` kannst du seinen Zustand prüfen.

### Bestehende Installation umstellen

Bewahre den bisherigen lauffähigen Checkout samt Abhängigkeiten bis zur erfolgreichen Dienstprüfung auf. Der Umzug verwendet das Python 3 der macOS Command Line Tools für den atomaren Austausch der Konfigurationsdateien. Führe im neuen Checkout `pnpm install --frozen-lockfile`, `pnpm build` und `pnpm service:migrate --check` aus. Sobald die aktiven Läufe beendet sind, starte `pnpm service:migrate`. Der Umzug sichert den Bestand unter `~/.crewpip-migration-backups/` und übernimmt Datenbank samt WAL, Token, Protokolle, Sicherungen und verwaltete Git-Worktrees. Ein laufender Login-Dienst startet unter `crewpip`. Einen zuvor gestoppten Dienst startest du mit `pnpm service:install`.

Der Umzug aktualisiert vorhandene globale MCP- und Hook-Einträge von Claude Code und Codex. Lade die MCP-Verbindungen neu und prüfe die vier geänderten Codex-Hooks unter `/hooks`. Für projektlokale Einstellungen und Cursor verwende die neuen Snippets. Nach einem unterbrochenen Umzug prüfst du die genannte Sicherung und führst `pnpm service:migrate --recover` aus. Bleibt der Altdienst nach einer Rücknahme gestoppt, stelle seinen bisherigen Checkout samt Build wieder her und führe dort `pnpm service:install` aus. Die Sicherung enthält auch den zwischenzeitlichen Datenstand eines bereits gestarteten neuen Dienstes.

## Den ersten Chat verbinden

Führe im CrewPip-Ordner `pnpm snippets --write` aus. Die Dateien in `config/generated/` enthalten die passenden Pfade und Zugangsdaten für diesen Mac. Übernimm die Einträge für deine App in die vorhandenen Einstellungen. Behalte andere Server und Hooks bei. Die erzeugten MCP-Dateien enthalten dein lokales Token.

| App | MCP-Verbindung | Hooks |
|---|---|---|
| Claude Code | `claudeMcp.json` in `~/.claude.json` übernehmen (oder in die `.mcp.json` des Projekts) | `claudeHooks.json` in `~/.claude/settings.json` übernehmen |
| Cursor | `cursorMcp.json` in `~/.cursor/mcp.json` übernehmen | `cursorHooks.json` in `~/.cursor/hooks.json` übernehmen |
| Codex | Beide Abschnitte aus `codexMcp.toml` in `~/.codex/config.toml` übernehmen | `codexHooks.json` in `~/.codex/hooks.json` übernehmen. In Codex die vier CrewPip-Hooks prüfen und freigeben (auch über `/hooks` möglich). |

Öffne einen neuen Chat in der eingerichteten App und bitte ihn um Folgendes: „Liste meine CrewPip-Chats mit dem MCP-Werkzeug `list_sessions` auf.“ Der eigene Chat ist mit einem Stern markiert. Bleibt die Liste leer oder fehlt der Stern, prüfe die Hook-Konfiguration und bei Codex die Freigabe. Weitere Einzelheiten stehen unter [Apps anbinden](#apps-anbinden).

## Die erste Nachricht zustellen

1. Öffne im Board die Nachrichtenansicht, erstelle eine Nachricht und wähle als Empfänger den gerade verbundenen Chat. Sende ihm einen kurzen Text, etwa „Der Testbericht liegt bereit.“
2. Gib im Empfänger-Chat etwas ein, zum Beispiel „Lies mein CrewPip-Postfach.“ Bei Claude Code und Codex kann der nächste Prompt die Nachricht bereits über den Hook abholen. Ein expliziter Aufruf von `read_inbox` holt wartende Nachrichten in jeder angebundenen App.
3. Öffne im Board den Zustellnachweis der Nachricht. Dort siehst du, welcher Chat sie erhalten hat und wann. Für eine Nachricht zwischen zwei Chats richte auch die zweite App ein und verwende die Zieladresse aus `list_sessions` mit `post_message`.

Eine Nachricht an einen ruhenden Chat wartet bis zum nächsten Kontakt. Die Zustellung bestätigt den Empfang. Ob der Chat einen Auftrag erledigt hat, prüfst du anhand des Ergebnisses.

## Aufbau

CrewPip verbindet die bestehenden Chats über einen MCP-Server und Hooks. Die [Architekturentscheidung zum Sidecar](docs/decisions/0001-sidecar-variante-a.md) erklärt diesen Aufbau.

```
apps/daemon   Node-Daemon: MCP-Server, Hook-Endpunkte, SQLite, WebSocket, liefert die Web-UI aus
apps/hook     Hook-Skript ohne Abhängigkeiten, übersetzt zwischen Daemon und App-Format
apps/web      React-UI (Vite): Agents, Nachrichtenstrom, Schreiben als Mensch
packages/shared  gemeinsame Typen
```

Das Subjekt in CrewPip ist die **Session**: ein Chat-Fenster in einer App, erkannt an
App, Projektordner und Session-ID. Angezeigt wird sie als `Claude · example-project / api-worker`.
Der Name ist frei wählbar (Web-UI, Stift-Symbol, oder `CREWPIP_SESSION_NAME` im Hook-Umfeld),
Standard ist die Startzeit.

Nachrichten gehen an eine Session (`session:<id>`), ein Projekt (`project:<name>`), eine App
(`app:claude|cursor|codex`), eine **Rolle** (`director`, `pm:<projekt>`), alle (`all`) oder
einen Menschen (`human:<name>`). Pro Session und
Nachricht hält der Daemon fest, ob und auf welchem Weg sie zugestellt wurde; die UI zeigt das
unter jeder Nachricht.

Für Claude Code liest der Daemon zusätzlich die **Session-Registry** unter
`~/.claude/sessions/*.json`. Daraus kommen Name (auch nach `/rename`), Arbeitsverzeichnis
und Prozess-ID. Folgen: Fenster erscheinen, ohne dass erst ein Hook feuern muss,
geschlossene Fenster verschwinden von selbst, und Worktrees unter
`<projekt>/.claude/worktrees/<name>` erscheinen beim richtigen Repository statt unter ihrem
eigenen Ordnernamen. Das Dateiformat ist nicht dokumentiert; fehlt es oder ändert es sich,
arbeitet CrewPip nur mit den Hooks weiter.

Beim Namen gilt: ein ausdrücklich gesetzter Name (CrewPip-UI oder `/rename` in Claude Code)
wird nie von einem automatisch abgeleiteten überschrieben.

Bei MCP-Aufrufen schickt keine der Apps eine Session-ID mit. Der Daemon fragt deshalb das
Betriebssystem, welcher Prozess die Verbindung hält (`lsof`, gemessen 0,05 s), und sucht
diesen Prozess:

1. als `pid` einer Claude-Session aus der Registry,
2. in der Prozesskette über dem Hook einer Session. Der Hook läuft als Kind des Agenten; beim
   Sitzungsstart merkt sich der Daemon die Prozesse darüber (Shells übersprungen), bei Claude
   z. B. `claude → disclaimer → Claude`. So wird auch Codex erkannt, das keine Registry hat.

Erst wenn kein Prozess passt, zählt das Arbeitsverzeichnis, das jedes Tool mitbringt. Passen
danach noch mehrere Sessions, lehnt das Tool ab, statt zu raten („kann nicht sicher erkennen,
welche Session du bist“).

**Sitzungsschlüssel, wenn der Prozess nicht reicht.** Codex führt alle Threads der ChatGPT-App
über **einen** Prozess, und die MCP-Anfrage trägt kein Thread-Merkmal (gemessen: nur accept,
content-length, content-type, host, mcp-protocol-version, user-agent und das Token; kein
`mcp-session-id`). Arbeiten dann zwei Chats im gleichen Verzeichnis, sind sie am Aufruf nicht
zu unterscheiden. Für genau diesen Fall erzeugt CrewPip je Chat einen Sitzungsschlüssel und
nennt ihn **nur über den Hook dieses Chats**. Alle Tools haben dafür das optionale Feld
`session_key`; er schlägt Prozess und Verzeichnis. Ein unbekannter Schlüssel wird abgelehnt und
fällt nicht auf das Verzeichnis zurück. Der Hinweis erscheint nur, solange die Mehrdeutigkeit
besteht — ein Chat allein im Verzeichnis bekommt keinen Schlüssel und braucht keinen. Nur `list_sessions` und `list_tasks` antworten trotzdem, ohne
Sternchen bzw. für das gemeinsame Projekt. Gibt es gar keine Session, legt der Daemon eine
„ohne Hook“ an.

## Zustellwege

Chats sind nie direkt miteinander verbunden: Jeder Chat ist an CrewPip angeschlossen, CrewPip ist der Briefkasten dazwischen. [So funktioniert CrewPip](docs/kommunikation.md) erklärt Aufbau, Zustellwege, Adressen, Zustände und Grenzen in einem Text.

| Weg | Claude Code | Cursor | Codex |
|---|---|---|---|
| Hinterlassen | MCP-Tool `post_message` | MCP-Tool `post_message` | MCP-Tool `post_message` |
| Beim nächsten Prompt | UserPromptSubmit-Hook | nur beim Sitzungsstart | UserPromptSubmit-Hook |
| Am Ende des Turns | Stop-Hook, Agent macht weiter | stop-Hook, `followup_message` | Stop-Hook, Agent macht weiter |
| Automatisch erkannt | ja, über die Session-Registry | nein, erst per Hook | nein, erst per Hook |
| Aktiv warten | `wait_for_message` (bis 50 s) | `wait_for_message` (bis 50 s) | `wait_for_message` (bis 50 s) |

Schleifensperre: Am Turn-Ende lässt der Daemon höchstens `CREWPIP_MAX_STOP_CONTINUATIONS`
(Standard 10) Fortsetzungen pro Agent zu, bis wieder ein menschlicher Prompt kommt. Liegen
gebliebene Nachrichten kommen dann beim nächsten Prompt.

Fällt der Daemon aus, beendet sich das Hook-Skript still mit Exit 0. Die Chats laufen
normal weiter, nur ohne Nachrichten.

**Ruhende Chats werden nicht geweckt.** Hooks feuern nur, wenn im Chat etwas passiert. Post
für einen ruhenden Chat wartet im Board, bis dort jemand etwas eingibt. Am 11.11.2026 wurde
für einen Claude-Chat gemessen, dass ein eigener Hintergrundbefehl ihn wecken kann; für Codex
fand sich kein sicherer Weg. Entscheidung: nicht einbauen.

## Auf einem weiteren Rechner

CrewPip läuft nur auf macOS (launchd für den Dienst, `lsof` und `ps` für die Erkennung des
Aufrufers). Einrichten: Repository klonen, „Starten“ und „Apps anbinden“ durchgehen. Die
Hook-Einträge enthalten den absoluten Pfad zum Repository und werden deshalb je Rechner mit
`pnpm snippets` neu erzeugt; Token und Datenbank entstehen je Rechner neu unter `~/.crewpip`.

Jeder Rechner hat damit sein **eigenes Board**. Nachrichten und Aufgaben werden nicht
abgeglichen, und Chats auf zwei Rechnern erreichen einander über CrewPip nicht.

## Starten

Als launchd-Dienst (empfohlen, startet nach dem Login und nach Abstürzen neu):

```bash
pnpm install
pnpm service:install
```

Weitere Befehle: `pnpm service:status`, `pnpm service:restart` (baut vorher neu),
`pnpm service:uninstall`. Der Dienst heißt `crewpip`, die Plist liegt unter
`~/Library/LaunchAgents/`, das Log unter `~/.crewpip/daemon.log`.

Von Hand: `pnpm build && node apps/daemon/dist/index.js`. Entwicklung: `pnpm dev` startet
Daemon (tsx watch) und Vite (Port 5173, proxyt auf den Daemon); vorher den Dienst stoppen,
sonst ist der Port belegt.

Daemon läuft auf `http://127.0.0.1:7357`, die Web-UI liegt unter derselben Adresse.

Datenbank: `~/.crewpip/crewpip.db` (SQLite über `node:sqlite`, Node 22 ab 22.18 oder Node ab 24).

## Zugangsschutz

Der Daemon verlangt ein Token. Es steht in `~/.crewpip/token` (nur für dich lesbar) und wird
beim ersten Start erzeugt.

**Was das Token leistet und was nicht.** Es hält Webseiten fern, die im Browser auf
`127.0.0.1` zugreifen, und es ist die Voraussetzung dafür, den Port jemals über die Maschine
hinaus zu öffnen. Es schützt **nicht** vor einem Programm, das ohnehin unter deinem Benutzer
läuft — das liest die Tokendatei genauso wie jeder erlaubte Client.

Dazu kommen zwei Prüfungen, die auch ohne Token greifen:

- **Host-Kopf**: Nur `127.0.0.1`, `localhost` und `[::1]` werden bedient. Ohne das könnte
  eine Domain, die auf `127.0.0.1` zeigt (DNS-Rebinding), aus dem Browser heraus als gleiche
  Herkunft gelten. Weitere Hosts über `CREWPIP_ALLOWED_HOSTS`.
- **Herkunft**: Anfragen mit fremdem `Origin` werden abgewiesen, auch mit gültigem Token.

Wer das Token woher bekommt:

| Client | Weg |
|---|---|
| Weboberfläche | Der Daemon setzt es beim Ausliefern der Startseite ein; die Seite schickt es als Kopfzeile `x-crewpip-token`, der WebSocket über die Adresse. |
| Hook-Skript | Liest `~/.crewpip/token` selbst. **Die Hook-Konfiguration ändert sich dadurch nicht** — wichtig bei Codex, wo jede Änderung eine neue `/hooks`-Freigabe erzwingen würde. |
| MCP-Clients | Kopfzeile `x-crewpip-token` in der Serverkonfiguration; `pnpm snippets` erzeugt sie mit dem Token. |
| Eigene Aufrufe | `curl -H "x-crewpip-token: $(cat ~/.crewpip/token)" …` |

`CREWPIP_AUTH=off` schaltet den Schutz ab. Das ist zur Fehlersuche gedacht, nicht für den
Betrieb: ohne Token kann jede Webseite Agents in deinen Worktrees starten.

## Datenbank-Umzüge

Schemaänderungen laufen über eine nummerierte Kette in
[apps/daemon/src/migrations.ts](apps/daemon/src/migrations.ts). Der Daemon wendet beim Start
an, was noch fehlt, und hält es in `schema_migrations` fest.

- **Vor dem ersten offenen Umzug wird gesichert**, mit `VACUUM INTO` in
  `~/.crewpip/backups/`. Das ergibt einen in sich stimmigen Stand, anders als ein Kopieren
  der Datei bei eingeschaltetem WAL. Die letzten zehn Sicherungen bleiben liegen.
- **Scheitert die Sicherung, wird nicht umgezogen.**
- **Jeder Umzug läuft in einer eigenen Transaktion** und wird erst danach eingetragen. Bricht
  einer ab, bleibt der Stand von vorher, und der Daemon startet nicht mit halbfertigem Schema.
- Der erste Eintrag ist wiederholbar geschrieben und dient als gemeinsamer Ausgangspunkt für
  frische Datenbanken und für die, die vor Einführung der Kette entstanden sind. Ab dem
  zweiten Eintrag verhindert das Verzeichnis die doppelte Anwendung.

```bash
pnpm db:status    # angewandte und offene Umzüge (Exit 1, wenn etwas offen ist)
pnpm db:migrate   # offene anwenden, ohne den Daemon zu starten
pnpm db:backup    # nur sichern
```

`GET /api/health` nennt den Schemastand mit. Einen neuen Umzug legt man als weiteren Eintrag
in `MIGRATIONS` an; die Kennung wird nach dem Anlegen nie mehr geändert.

## Apps anbinden

`pnpm snippets` druckt die Konfigurationsschnipsel mit absoluten Pfaden, `pnpm snippets --write`
legt sie unter `config/generated/` ab. Globale Konfigurationsdateien werden **nie automatisch**
verändert.

**Claude Code, Mac-App und CLI**

Die Mac-App (Code-Tab) liest dieselben Dateien wie das CLI: MCP-Server aus
`~/.claude.json` und `.mcp.json`, Hooks aus `~/.claude/settings.json`. Eine Konfiguration
gilt also für beide. Belegt am 2026-09-01: ein PreToolUse-Hook aus `~/.claude/settings.json`
hat in einer Mac-App-Session gegriffen.

```bash
claude mcp add -s user --transport http \
  --header "x-crewpip-token: $(cat ~/.crewpip/token)" \
  crewpip "http://127.0.0.1:7357/mcp/claude?app=claude"
```

Ohne die Kopfzeile lehnt der Daemon jeden Aufruf mit 401 ab (siehe Zugangsschutz).

Hooks aus `config/generated/claudeHooks.json` in `~/.claude/settings.json` einfügen
(SessionStart, UserPromptSubmit, Stop, SessionEnd). Nachrichten kommen an der nächsten
Turn-Grenze an: beim Sitzungsstart, bei der nächsten Eingabe und am Ende eines Turns. Eine
Sofortzustellung mitten im Turn gibt es nicht mehr (siehe „Warum es keine Sofortzustellung
gibt“).

**Cursor**

`config/generated/cursorMcp.json` nach `~/.cursor/mcp.json`, `cursorHooks.json` nach
`~/.cursor/hooks.json`. Cursor liefert Nachrichten nur am Turn-Ende (`stop`-Hook) und beim
Sitzungsstart; dafür ist dort `loop_limit` auf 10 gesetzt.

**Codex** (ChatGPT-App, CLI und IDE-Erweiterung teilen sich diese Konfiguration)

```bash
codex mcp add crewpip --url "http://127.0.0.1:7357/mcp/codex?app=codex"
```

Danach das Token als Kopfzeile in `~/.codex/config.toml` eintragen; den fertigen Block mit
`[mcp_servers.crewpip.http_headers]` druckt `pnpm snippets`. Ohne ihn antwortet der Daemon
mit 401.

Hooks aus `config/generated/codexHooks.json` in `~/.codex/hooks.json` einfügen. **Danach in
einer interaktiven Codex-Sitzung `/hooks` ausführen und die vier CrewPip-Hooks freigeben.**
Ohne Freigabe liest Codex die Datei zwar, führt die Hooks aber stillschweigend nicht aus.
Das Vertrauen hängt an der Prüfsumme: Jede spätere Änderung an `hooks.json` macht eine neue
Freigabe nötig. Für Automatisierung gibt es `--dangerously-bypass-hook-trust`.

`SessionEnd` lässt Codex höchstens 3 Sekunden zu und kürzt größere Werte mit einer Warnung.

**Mehrere Sessions im selben Ordner:** Der Daemon unterscheidet sie über die Session-ID aus
dem Hook und bei MCP-Aufrufen über den Prozess (siehe oben). Früher entschied beim MCP-Aufruf
die zuletzt aktive Session im Ordner — Director und Worker im selben Repo schrieben dadurch
still unter dem Namen des jeweils anderen (Aufgabe #13).

## MCP-Tools

Alle Tools brauchen `cwd`, das absolute Arbeitsverzeichnis der aufrufenden Session. Es dient nur als Rückfall, wenn der Prozess nicht erkannt wird. Dazu kommt überall das optionale `session_key` (siehe oben).

| Tool | Zweck |
|---|---|
| `post_message(cwd, to, text)` | Nachricht an `session:<id>`, `project:<name>`, `app:<app>`, `all` oder `human:<name>` |
| `read_inbox(cwd)` | Ausstehende Nachrichten holen, gilt danach als zugestellt |
| `wait_for_message(cwd, timeout_seconds?)` | Bis zu 50 s auf eine neue Nachricht warten |
| `list_sessions(cwd)` | Aktive Sessions nach Projekt mit ihren Zieladressen |
| `list_tasks(cwd, status?, all_projects?)` | Aufgaben des Projekts |
| `create_task(cwd, title, body?)` | Aufgabe anlegen |
| `claim_task(cwd, id)` | Aufgabe übernehmen, scheitert bei fremder Zuweisung |
| `update_task(cwd, id, status?, note?)` | Status setzen, Notiz anhängen |
| `start_run(cwd, prompt, task_id?, app?, mode?)` | Agent starten; Standard `read-only` |
| `list_runs(cwd, task_id?, mine_only?)` | Läufe mit Zustand und Ergebnis |
| `stop_run(cwd, id)` | eigenen Lauf abbrechen |

Jede zugestellte Nachricht nennt ihre Antwortadresse (`antworten an: session:…` oder `human:…`).

## HTTP-API

| Route | Zweck |
|---|---|
| `POST /mcp/:app` | MCP Streamable HTTP, zustandslos |
| `POST /hooks/:app/:event` | `session-start`, `prompt`, `stop`, `session-end`, `turn-complete` |
| `GET /api/sessions?all=1` | Aktive Sessions, mit `all=1` auch beendete |
| `GET /api/projects` | Projekte mit Session- und Aufgabenzahl |
| `GET /api/projects/:id/worktrees` | alle git-Worktrees, auch fremde |
| `GET/POST /api/tasks`, `PATCH /api/tasks/:id` | Aufgaben lesen, anlegen, ändern |
| `POST/DELETE /api/tasks/:id/worktree` | Worktree anlegen und entfernen (`?force=1`) |
| `PATCH /api/sessions/:id` `{name}` | Session umbenennen |
| `GET /api/messages` | Nachrichten mit Zustellprotokoll |
| `POST /api/messages` `{from,to,text}` | Nachricht als Mensch |
| `GET /api/runner/apps` | welche Werkzeuge startbar sind |
| `GET/POST /api/runs`, `GET /api/runs/:id/items` | Läufe lesen und starten |
| `POST /api/runs/:id/stop` | Lauf abbrechen |
| `WS /ws` | Live-Ereignisse `message`, `sessions`, `delivery`, `tasks`, `projects`, `runs`, `run-item` |

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `CREWPIP_HOST` | `127.0.0.1` | Nur lokal lauschen. Wer das öffnet, braucht zuerst Auth. |
| `CREWPIP_PORT` | `7357` | Port |
| `CREWPIP_DB` | `~/.crewpip/crewpip.db` | SQLite-Datei |
| `CREWPIP_MAX_STOP_CONTINUATIONS` | `10` | Schleifensperre am Turn-Ende |
| `CREWPIP_MAX_WAIT_SECONDS` | `50` | Obergrenze für `wait_for_message` |
| `CREWPIP_URL` (Hook, Vite) | `http://127.0.0.1:7357` | Daemon-Adresse |
| `CREWPIP_SESSION_NAME` (Hook) | Startzeit | Anzeigename der Session |
| `CREWPIP_CLAUDE_SESSIONS` | `~/.claude/sessions` | Session-Registry von Claude Code |
| `CREWPIP_RUN_TIMEOUT_MS` | `1800000` | Zeitlimit je Agent-Lauf |
| `CREWPIP_CLAUDE_MAX_TURNS` | `40` | Zugrunde gelegte Höchstzahl an Zügen |
| `CREWPIP_CODEX_BYPASS_HOOK_TRUST` | aus | umgeht die Hook-Freigabe für gestartete Läufe |
| `CREWPIP_RUNS_PER_HOUR` | `20` | Läufe je Session und Stunde |
| `CREWPIP_TOKEN` / `CREWPIP_TOKEN_FILE` | `~/.crewpip/token` | Zugangstoken |
| `CREWPIP_ALLOWED_HOSTS` | leer | zusätzlich erlaubte Host-Köpfe, kommagetrennt |
| `CREWPIP_AUTH` | an | `off` schaltet den Zugangsschutz ab |

## Tests

```bash
pnpm typecheck && pnpm test
```

## Rollen

[docs/rollen.md](docs/rollen.md) beschreibt die Arbeitsteilung: ein **Director** quer über
alle Projekte, ein **PM** je Repository, **Worker** für die Umsetzung. CrewPip kennt diese
Rollen als Feld an der Session.

- Die Rolle ergibt sich aus dem Sitzungsnamen: `Director`, `PM <repo>`, `Worker <repo>`.
  Wer die Namenskonvention einhält, muss nichts weiter tun. Von Hand geht es in der
  Seitenleiste oder über `PATCH /api/sessions/:id` mit `{"role": "pm"}`.
- Es gibt höchstens einen Director und höchstens einen PM je Projekt. Eine neue Vergabe
  nimmt der bisherigen aktiven Session die Rolle ab, statt zu scheitern.
- `director` und `pm:<projekt>` adressieren die **Rolle, nicht die Sitzung**. Eine Nachricht
  an den PM eines Projekts wartet, bis es dort einen gibt, und übersteht dessen Neustart.
  Das ist der Unterschied zu `session:<id>`, das an ein bestimmtes Fenster geht.

## Projekte, Aufgaben und Worktrees

**Projekte** entstehen von selbst. Meldet sich eine Session, bestimmt der Daemon mit
`git rev-parse --git-common-dir` das Haupt-Repository; ein Worktree gehört damit zum
Repository, nicht zu sich selbst. Ohne git dient das Verzeichnis selbst als Projekt.

**Aufgaben** gehören zu einem Projekt und laufen durch fünf Zustände: `offen`, `in Arbeit`,
`zu prüfen`, `erledigt`, `verworfen`. Nur sinnvolle Wechsel sind erlaubt; eine erledigte
Aufgabe springt nicht ohne Umweg zurück in die Prüfung. Auf `offen` zurückgesetzt verliert eine Aufgabe ihre Zuweisung; erledigt und verworfen
behalten sie, damit sichtbar bleibt, wer sie bearbeitet hat. Wird eine Aufgabe einer Session
zugewiesen, bekommt diese Session eine Nachricht über den normalen Weg, also an ihrer nächsten
Turn-Grenze.

**Worktrees** legt CrewPip auf Knopfdruck an, unter
`<projekt>/.crewpip/worktrees/<id>-<titel>` mit dem Branch `crewpip/<id>-<titel>`,
abgezweigt von `main` oder `master`. Beim Entfernen gilt:

- Nicht committete Änderungen oder Commits, die nicht in `main` sind, blockieren das
  Entfernen. Die Oberfläche fragt dann, ob trotzdem entfernt werden soll.
- Ein Branch ohne eigene Commits wird mitgelöscht, ein Branch mit eigenen Commits bleibt
  stehen, damit nichts verloren geht.

CrewPip startet keine Chat-Fenster. Es bereitet den Worktree vor; das Fenster öffnest du
dort selbst. Die Session, die in einem Worktree läuft, wird der Aufgabe automatisch
zugeordnet und in der Seitenleiste mit ihr angezeigt.

Nur lesende git-Befehle laufen ungefragt. Geschrieben wird ausschließlich mit
`worktree add`, `worktree remove` und `branch -d`; es gibt keinen Aufruf, der Commits oder
fremde Branches anfassen kann.

## Agents aus CrewPip starten

Über den Knopf **Agent starten** an einer Aufgabe, oder über das MCP-Werkzeug `start_run`,
startet CrewPip ein Coding-Werkzeug als eigenen Prozess, liest seine Ausgabe mit und zeigt sie live. Ist der Lauf fertig, wandert die
Aufgabe von „in Arbeit" auf „zu prüfen"; entschieden wird von dir, nicht vom Agent.

**Rechte.** Es gibt genau zwei Stufen, sichtbar bei jedem Lauf gespeichert. Welche Befehle
ein schreibender Lauf ausführen darf, steht unter „Befehle in schreibenden Läufen" weiter unten.

| Stufe | Codex | Claude Code | Bedeutung |
|---|---|---|---|
| nur lesen | `--sandbox read-only` | `--permission-mode plan` | darf lesen und antworten, nichts ändern |
| im Worktree schreiben | `--sandbox workspace-write` | `--permission-mode acceptEdits` | darf Dateien im Arbeitsverzeichnis ändern |

Eine Stufe ohne Sandbox und ohne Rückfragen bietet CrewPip **nicht** an. Wer das braucht,
startet den Agent selbst im Terminal.

Stößt eine Session einen Lauf an, bekommt sie eine Nachricht, sobald er fertig ist — über
denselben Zustellweg wie alles andere. Aktives Warten ist unnötig.

**Grenzen, die der Daemon durchsetzt:**

- Schreibende Läufe verlangen einen Worktree. Der Haupt-Checkout ist nur mit ausdrücklichem
  `allowProjectRoot` erreichbar, das die Oberfläche nicht anbietet.
- Ein Lauf kann das Projektverzeichnis nicht verlassen.
- Höchstens vier Läufe gleichzeitig, danach wird abgelehnt.
- Zeitlimit je Lauf, Standard 30 Minuten (`CREWPIP_RUN_TIMEOUT_MS`).
- Abbrechen jederzeit über die Oberfläche.
- **Ein Lauf startet keine Läufe.** Eine Session, die aus einem Lauf hervorgegangen ist, wird
  beim Startversuch abgewiesen. Damit bleibt die Tiefe bei eins, und die Zahl gleichzeitiger
  Agents kann sich nicht mit jeder Stufe vervielfachen.
- **Obergrenze je Stunde** für Läufe, die eine Session anstößt (`CREWPIP_RUNS_PER_HOUR`,
  Standard 20). Aus der Oberfläche gilt sie nicht.
- **Jeder Lauf trägt, wer ihn angestoßen hat**, in der Oberfläche und in `list_runs`.
  Abbrechen darf nur, wer ihn gestartet hat.
- Jeder Lauf wird vollständig unter `~/.crewpip/runs/<id>.jsonl` mitgeschrieben.

**Anmeldung.** Die Oberfläche zeigt je Werkzeug, ob es gefunden und angemeldet ist; ein nicht
angemeldetes Werkzeug lässt sich gar nicht erst starten.

- **Codex** funktioniert sofort, weil sein CLI die Anmeldung der ChatGPT-App aus `~/.codex`
  liest.
- **Claude Code** braucht eine eigene Anmeldung. Die Desktop-App reicht ihre Anmeldung nur an
  Sitzungen durch, die sie selbst startet, weder über die Umgebung noch über den
  Schlüsselbund. Das eigenständige CLI muss separat installiert und angemeldet sein; einmal

  ```bash
  claude auth login
  ```

  in einem Terminal ausführen. `claude auth status` zeigt den Stand.

Der Dienst braucht `/opt/homebrew/bin` im Suchpfad, sonst findet er global installierte
Programme nicht. `pnpm service:install` schreibt das mit in die Plist.

Damit ein gestarteter Agent auch Nachrichten empfängt, muss er die CrewPip-Hooks ausführen.
Bei Codex heißt das: einmal `/hooks` freigeben. Ohne Freigabe läuft der Agent normal, bekommt
aber keine Postfach-Zustellung. `CREWPIP_CODEX_BYPASS_HOOK_TRUST=1` umgeht die Freigabe für
gestartete Läufe; standardmäßig ist das aus.

## Warum es keine Sofortzustellung gibt

CrewPip hat Nachrichten früher zusätzlich direkt in den Inbox-Socket einer Claude-Code-Sitzung
geschrieben. Dieser Weg ist entfernt, weil er nicht funktioniert und trotzdem als zugestellt
verbucht wurde.

Claude Code stellt eine Socket-Nachricht ohne Rückfrage nur zu, wenn sie von einem **eigenen
Kindprozess** der Sitzung stammt. Der Daemon ist ein launchd-Dienst und damit für keine
Sitzung ein Kind. Fehlt diese Bestätigung, entscheidet der Berechtigungsmodus des Empfängers:
Bei übersprungenen Rückfragen hält Claude Code die Nachricht zurück und verwirft sie nach fünf
Minuten. Der Schreibvorgang auf den Socket gelingt dabei, deshalb sah es nach Erfolg aus.

Belegt am 05.09.2026 mit zwei Proben (#11 an den Director, #12 an die eigene Sitzung): beide
als zugestellt verbucht, keine erschienen. Am 01.09. hatte derselbe Weg funktioniert — damals
lief die Sitzung im `auto`-Modus, der als fragend zählt.

Zustellung läuft deshalb **ausschließlich über die Hooks**, also an der nächsten Turn-Grenze.
Das Zustellprotokoll zeigt das jetzt so an, statt „sofort" zu behaupten. Ältere Einträge mit
`push` bleiben lesbar und sind als unbestätigt gekennzeichnet.

Wer die Sofortzustellung zurückhaben will, müsste `crossSessionInbound` auf `accept` setzen.
Das erlaubt jedem lokalen Programm, ohne Bestätigung Text in laufende Sitzungen zu schreiben —
bewusst nicht die Voreinstellung, und nichts, was CrewPip selbst ändert.

## Befehle in schreibenden Läufen

Ein Lauf im Modus „im Worktree schreiben" bekommt einen festen Grundstock an Befehlen,
unabhängig von der Freigabeliste des Projekts (entschieden am 18.09.2026):

| Erlaubt | Nicht erlaubt |
|---|---|
| `git add`, `git commit`, `git status`, `git diff`, `git log` | **jeder `git push`** — den übernimmt CrewPip |
| `pnpm install`, `test`, `typecheck`, `lint`, `format`, `format:check`, auch mit `--filter` | `pnpm run`, `pnpm exec`, `pnpm dlx`: das wären beliebige Skripte |

**Warum der Agent nicht selbst pusht.** Befehlsmuster lassen sich umgehen. Belegt am 18.09.2026
mit einem echten Lauf: `git push origin crewpip/x:main` ging trotz Verbotsregel durch und
schrieb auf `main`. Deshalb darf der Agent gar nicht pushen, und CrewPip pusht nach einem
erfolgreichen Lauf selbst — genau den Branch der Aufgabe, mit fester Argumentliste und ohne
Shell. Auf `main` oder fremde Branches kommt dieser Weg nicht.

Beim Push läuft der **pre-push-Hook** des Projekts mit. Ist er rot, gilt der Lauf als
gescheitert: Die Arbeit bleibt als Commit im Worktree, im Protokoll steht der Grund. Hat der Lauf
nichts committet, wird nichts gepusht. Das Push-Ergebnis steht am Lauf.

**Bootstrap je Projekt.** Ein frischer Worktree hat kein `node_modules`; ohne das laufen weder
Tests noch Hooks. Am Projekt lässt sich ein Befehl hinterlegen, der nach dem Anlegen im Worktree
läuft, etwa `pnpm install --frozen-lockfile`. Er wird in CrewPip gepflegt und nicht aus dem
Repository gelesen, damit kein Repository bestimmt, was der Daemon ausführt.

**Codex** hat keine Befehlsliste, sondern eine Sandbox, die nur im Worktree schreiben lässt.
Das gemeinsame Git-Verzeichnis liegt aber außerhalb, deshalb gibt CrewPip genau die vier
Stellen frei, die ein Commit schreibt (gemessen): `objects`, der eigene Branch unter
`refs/heads` und `logs/refs/heads`, und das Verwaltungsverzeichnis des Worktrees. `config` und
`hooks` bleiben gesperrt, sonst könnte der Agent die Hooks abschalten. Netzwerk bleibt aus.
**Ungeprüft im Betrieb:** Am 18.09.2026 war das Codex-Kontingent erschöpft; der erste
schreibende Codex-Lauf danach ist der Beleg.

## Was eine Nachricht bewirkt, und was nicht

Zugestellte Nachrichten sind **Kontext, kein Befehl**. Codex lehnt es ausdrücklich ab, auf
eine Anweisung aus eingespeistem Kontext hin zu handeln, solange der Mensch das nicht in
seinem eigenen Prompt deckt. Claude Code behandelt fremde Nachrichten
ebenso: Sie können keine Berechtigung erteilen und keine Rückfrage beantworten.

Praktisch heißt das:

- Nachrichten eignen sich, um eine Session zu **informieren** („Migration 0042 ist auf main").
- Soll eine Session **handeln**, muss der Mensch das im eigenen Prompt sagen, etwa
  „erledige, was in meinem CrewPip-Postfach steht". Genau so funktioniert es zuverlässig.

## Noch offen

- Cursor ist auf diesem Mac nicht installiert; die Cursor-Pfade sind nur gegen die Doku
  geprüft, nicht im Betrieb.
- Codex `turn/steer` über den App-Server für Threads, die CrewPip selbst startet (Variante B).
- Claude Code Channels, sobald sie aus der Research Preview sind.
- Aufgaben über Projektgrenzen hinweg verknüpfen (Abhängigkeiten, Reihenfolge).
- Läufe fortsetzen statt neu starten (Codex `turn/steer`, Claude `--resume`).
- Cursor als startbares Werkzeug, sobald es hier installiert ist.

## Bedienung der Oberfläche

Der Einstieg ist der Überblick unter `http://127.0.0.1:7357`. „Director schreiben“ adressiert die Koordination, „Aufgabe planen“ legt einen Auftrag im gewählten Projekt an. Nachrichten werden beim nächsten Kontakt des Empfänger-Chats zugestellt; das Board startet damit keinen Chat automatisch. Details und Abnahmen: [Oberfläche und Abnahme](docs/ui-abnahme.md).

## Beispiele und Prüfberichte

Projekt- und Personennamen in Beispielen und Tests sind fiktiv. Historische Prüfberichte sind für die Weitergabe anonymisiert. Die lokale Installation wird mit `pnpm service:status` geprüft.

# ADR 0001: Sidecar statt eigener Agent-Laufzeit („Variante A“)

Datum: 2026-09-01 · Status: angenommen, durch spätere Implementierung ergänzt

Historische Entscheidung: Socket-Push wurde inzwischen entfernt, launchd und
Token-Schutz sind implementiert. Für aktuelle Einrichtung und Grenzen gilt die README.

## Kontext

CrewPip soll Chats in Claude Code, Cursor und Codex auf demselben Mac miteinander reden
lassen. Zwei Bauweisen standen zur Wahl:

- **A, Sidecar:** Die Chats bleiben in ihren Apps. CrewPip ist ein MCP-Server plus ein
  Hook-Skript, das die Apps aufrufen.
- **B, eigene Laufzeit:** CrewPip startet und steuert die Sessions selbst (Claude Agent SDK,
  Cursor CLI/ACP, Codex App-Server).

Historischer Recherchestand vom 2026-09-01: Alle drei Apps unterstützen MCP über
Streamable HTTP. Zustellung in laufende Sessions geht bei Claude Code und Codex über
UserPromptSubmit- und Stop-Hooks, bei Cursor nur über den stop-Hook (`followup_message`)
und beim Sitzungsstart. Echten Push in ein offenes Chat-Fenster gibt es nur bei Claude Code
über den Inbox-Socket der Session.

## Entscheidung

Variante A. Ein Daemon auf `127.0.0.1:7357` mit

1. zustandslosem MCP-Endpunkt pro Agent-Name (`/mcp/<name>`), Tools `post_message`,
   `read_inbox`, `wait_for_message`, `list_agents`;
2. Hook-Endpunkten (`/hooks/<name>/<event>`), die ein einziges Skript für alle drei Apps
   bedient und das die Antwort in das App-Format übersetzt;
3. Push über den Claude-Code-Inbox-Socket, wenn eine Session ihn beim Start gemeldet hat;
4. SQLite (`node:sqlite`) und WebSocket für die Web-UI.

Ergänzung 2026-09-02: Die Identität ist die Session (App, Projektordner, Session-ID aus dem
Hook), nicht ein Name pro App. Die erste Fassung mit einem Namen pro App machte acht Claude-
Fenster ununterscheidbar. Bei MCP-Aufrufen ohne Session-ID ordnet der Daemon über das
Arbeitsverzeichnis zu, das jedes Tool als Pflichtfeld mitbringt.

## Begründung

- Erreicht die Chat-Fenster, die Anwender tatsächlich benutzen, auch den Cursor-Editor und
  die Codex-Desktop-App, die Variante B nicht ansprechen kann.
- Baut nur auf Mechanismen, die in allen drei Apps stabil dokumentiert sind. Claude Code
  Channels (Preview), `codex mcp-server` (abgekündigt) und der Codex App-Server („may change
  without notice“) bleiben außen vor.
- Variante B lässt sich später für Agents ergänzen, die CrewPip selbst startet.

Ergänzung 2026-09-02 (Namen): Der Daemon liest zusätzlich die Session-Registry von Claude
Code (`~/.claude/sessions/<pid>.json`). Die Existenz dieser Dateien ist dokumentiert
("Each session registers itself in files on disk"), ihr Inhalt nicht; die Felder sind von
Version 2.1.255 abgelesen. Der Zugriff ist lesend, fehlertolerant und optional: ohne
Registry bleiben Hooks und MCP unverändert nutzbar. Der Gewinn rechtfertigt die Abhängigkeit,
weil nur so Namen aus `/rename`, Fenster ohne Hooks und beendete Sessions ohne Zutun
stimmen.

Ergänzung 2026-09-03 (Variante B): CrewPip startet Agents jetzt auch selbst, ohne die
Sidecar-Variante abzulösen. Beides steht nebeneinander: von der App gestartete Fenster
bleiben über Hooks und MCP angebunden, von CrewPip gestartete Läufe kommen dazu. Belegt am
2026-09-03, dass Codex in sauberer Umgebung startet und Claude Code nicht, weil dessen
Desktop-App die Anmeldung nur an eigene Kindprozesse durchreicht.

Ergänzung 2026-09-18 (Befehle in schreibenden Läufen): Der Agent committet, CrewPip pusht.
Befehlsmuster auf Shell-Zeilen lassen sich nicht zuverlässig gegen Refspec-Tricks absichern;
belegt mit einem echten Lauf, der trotz Verbotsregel auf main schrieb. Die Grenze „nicht auf
main" ist deshalb baulich gezogen: Nur CrewPip ruft `git push` auf, mit fester Argumentliste
für genau den Branch der Aufgabe.

## Folgen und Risiken

- Nachrichten kommen bei Cursor und Codex erst an Turn-Grenzen an. Wer eine Antwort
  erwartet, ruft `wait_for_message` auf.
- Stop-Hook-Fortsetzungen können Schleifen bilden. Der Daemon begrenzt sie pro Agent
  (Standard 10) bis zum nächsten menschlichen Prompt; Cursor hat zusätzlich `loop_limit`.
- Der Daemon muss laufen. Das Hook-Skript endet bei Fehlern still mit Exit 0, damit die
  Chats nie hängen. Ein launchd-Dienst fehlt noch.
- Der Socket-Protokollteil (`{"type":"user","message":{…}}`) stammt aus dem Debug-Hinweis
  des Claude-Code-Binaries 2.1.255, nicht aus der Doku. Er kann sich ändern; dann fällt
  die Zustellung auf die Hooks zurück.
- Nur `127.0.0.1`. Wer den Daemon ins Netz öffnet, braucht zuerst eine Authentifizierung.
- Ein gestarteter Agent führt Befehle aus. Die Gegenmittel sind: zwei Rechtestufen statt
  freier Wahl, Worktree-Pflicht beim Schreiben, Projektgrenze, Höchstzahl paralleler Läufe,
  Zeitlimit, Abbruchknopf und vollständiges Protokoll. Ein Modus ohne Sandbox wird nicht
  angeboten, und kein MCP-Werkzeug kann Läufe starten.
- Das Registry-Format kann sich mit jeder Claude-Code-Version ändern. Dann fallen Sessions
  ohne Hooks und die automatische Bereinigung weg, der Rest läuft weiter.

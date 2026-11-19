# Changelog

## [Unreleased]

- Dashboard im Retro-Terminal-Stil (Issue #12) statt Steampunk: grüne Monochrom-Schrift auf dunklem Grund, Systemschrift Monospace, Bernstein für Warnungen, Auswahl System/Dunkel/Hell (Standard Dunkel). Fließtext mindestens 15 px, Glühen nur auf Rahmen und Überschriften, keine Animationen; Zustände zusätzlich über Symbole. Steampunk-Schriften entfernt. Keine Funktionsänderung.
- (abgelöst durch Issue #12) Dashboard im dezenten Retro-Steampunk-Design (Issue #9): zentrale Farb- und Schrift-Tokens in `apps/web/src/theme.css` (hell und dunkel, WCAG AA per Test geprüft), Überschriftschrift Alegreya SC (SIL OFL, lokal unter `apps/web/public/fonts`), Ornamente nur als CSS/SVG. Verbindungsstatus bleibt zusätzlich über Form, Rahmen und Text erkennbar. Keine Funktionsänderung.
- Umbenennung von mngboard in CrewPip. `pnpm service:migrate` sichert und übernimmt bestehende Installationen unter der neuen Dienstkennung.

### Neutraler Weitergabe-Stand

- Persönliche Standardabsender durch „Mensch“ ersetzt; selbst gespeicherte Namen bleiben erhalten.
- Kundenbezüge in Tests und Beispielen durch fiktive Namen ersetzt. Historische Prüfberichte
  ohne persönliche Chat-IDs und Projektpfade zusammengefasst.
- Alte Git-Versionen sind von dieser Inhaltsbereinigung nicht erfasst. Für eine Veröffentlichung
  ist ein separater Stand ohne private Historie vorgesehen.

### Docs

- **README: veraltete Aussagen zur Sofortzustellung entfernt, Einrichtung vervollständigt.** Der
  Abschnitt „Apps anbinden“ behauptete noch, der SessionStart-Hook melde den Inbox-Socket an und
  Nachrichten kämen „sofort an, auch mitten im Turn“. Dieser Weg ist seit September entfernt;
  ein fremder Agent hätte sich darauf verlassen. Außerdem fehlte in den Befehlen zum Anbinden
  die Token-Kopfzeile, ohne die der Daemon mit 401 antwortet. Neu: ein Abschnitt zum Betrieb
  auf einem weiteren Rechner (nur macOS, eigenes Board je Rechner, kein Abgleich) und der
  Hinweis, dass ruhende Chats nicht geweckt werden.
- **AGENTS.md: Anleitung für Agenten.** Bisher standen dort nur die PR-Regeln. Jetzt steht kurz,
  wie man sich über CrewPip abstimmt: Identität prüfen und bei Unklarheit nicht raten, an
  Adressen statt Namen schreiben, „gesendet“ von „gelesen“ unterscheiden, eine Nachricht nicht
  als Freigabe behandeln, keine Schleifen, am Dienst nur mit Auftrag arbeiten.
- **Prüfprotokoll des Aufwecktests vom 11.11.2026 abgelegt** (`docs/wecktest-2026-11-11.md`,
  für die Weitergabe anonymisiert). Es hält die Messungen fest, auf denen der
  README-Hinweis „Ruhende Chats werden nicht geweckt“ beruht. Die im Protokoll genannten
  „nächsten Schritte“ sind überholt: Es wurde am selben Tag entschieden, das Aufwecken nicht
  weiterzuverfolgen. Maßgeblich ist das README.
- **Protokoll der Feldprüfung zu Aufgabe 19 abgelegt** (`docs/abnahmen/2026-11-11-aufgabe-19.md`,
  für die Weitergabe anonymisiert). Stand laut Protokoll: **nicht abgenommen**. Der Freigabetest mit der
  Claude-CLI scheiterte an einer abgelaufenen Anmeldung, bevor ein Befehl lief; belegt ist nur
  der Pre-Push-Hook von demo-project im Probelauf (Exit 0, 23,8 s). Die Rohprotokolle lagen in einem
  temporären Ordner und sind nicht Teil des Repos.

### Fixed

- **Zwei Tests fielen auf jedem Rechner, auf dem die Codex-Programmdatei nicht im PATH liegt.**
  `apps/daemon/test/http.test.ts` erwartete für einen Lauf ohne Task und ohne Projekt die Meldung
  „Weder Task noch Projekt angegeben“, bekam aber „codex ist auf diesem Rechner nicht gefunden
  worden“ — auf diesem Mac steckt Codex in
  `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` und
  nicht im PATH. Der zweite Fehlschlag war ein Folgefehler desselben Abbruchs: Weil der erste Test
  vor dem Start seines Laufs stehenblieb, bekam der Lauf des zweiten Tests die Nummer 1 — und der
  dort auf `id: 1` festgenagelte „fremde“ Lauf war damit der eigene, den man sehr wohl abbrechen
  darf. Keine Regression aus #46: Gegen den unveränderten Stand `2c3c01e` fielen beide genauso.

  Ursache war die Reihenfolge in `Runner.validate` (`apps/daemon/src/runner/index.ts`): Die Prüfung,
  ob das Werkzeug auf diesem Rechner überhaupt installiert ist, stand vor allen Prüfungen des
  Auftrags. Sie steht jetzt beim letzten Schritt, neben der Anmeldeprüfung, deren Kommentar diese
  Reihenfolge schon vorher begründete. Fachlich gehört sie dorthin: Eine fehlende Angabe ist ein
  Fehler des Aufrufers und kann von ihm abgestellt werden, eine fehlende Installation nicht. Die
  Prüfung selbst bleibt unverändert — stimmt der Auftrag, ist das fehlende Programm weiterhin ein
  Grund, nicht zu starten.

  Dazu ist der zweite Test nicht mehr auf den Lauf eines anderen Tests angewiesen: Er legt den
  fremden Lauf selbst über `POST /api/runs` an (also ohne Session, damit ohne Eigentümer) und
  prüft dessen Nummer. Das ist strenger als vorher, weil jetzt belegt ist, dass der Lauf wirklich
  einer fremden Herkunft ist, und nicht bloß, dass es eine Nummer 1 gab.

  Belegt: Rot-Grün nach AGENTS.md, maschinenunabhängig. Neuer Test
  `apps/daemon/test/runner.test.ts`, „Fehlt die Angabe und fehlt das Programm, wird die Angabe
  gemeldet“: Er stellt die Umgebung gezielt auf „kein Programm vorhanden“ (`bin()` liefert `null`)
  und verlangt für eine fehlende Angabe die Meldung über die Angabe, für einen vollständigen
  Auftrag dagegen weiterhin „nicht gefunden worden“. Befehl in `apps/daemon`:
  `npx tsx --test test/runner.test.ts`. Gegenprobe gegen den unveränderten Stand — nur die Quelle
  zurückgenommen, die Tests belassen (`git checkout -- apps/daemon/src/runner/index.ts` auf
  `258ada1`) — 23 von 24 grün, rot genau der neue Test mit `'codex ist auf diesem Rechner nicht
  gefunden worden.'` statt `/Weder Task noch Projekt/`; mit dem Fix 24 von 24. `test/http.test.ts`
  vorher 13 von 15 mit den beiden oben beschriebenen Fehlschlägen, nachher 15 von 15. Alle acht
  Testdateien einzeln gelaufen (`auth`, `board`, `http`, `inbox`, `migrations`, `peer`, `registry`,
  `runner`): 85 Tests, kein Fehlschlag. `pnpm typecheck` über alle Projekte grün.

  Abgewogen: Die Tests hätten sich auch dadurch reparieren lassen, dass sie die Programmdatei
  vorab stellen — das hätte aber die eine Prüfung verdeckt, die hier wirklich falsch stand, und
  der nächste Rechner ohne Codex im PATH wäre erneut über die Reihenfolge gestolpert. Der Preis
  der neuen Reihenfolge: Laufen schon vier Agents **und** fehlt das Programm, meldet CrewPip
  jetzt zuerst die vier Agents. Beides sind Umstände der Umgebung, keine Angaben des Aufrufers;
  die Rangfolge unter ihnen ist beliebig. Nebeneffekt zugunsten des Aufrufers: Der Anmeldestatus
  wird erst abgefragt, wenn der Auftrag stimmt — ein fehlerhafter Aufruf startet dafür keinen
  Prozess mehr.

- **Codex konnte über CrewPip nicht mehr schreiben, sobald zwei seiner Chats im selben Ordner
  liefen (Aufgabe #46).** `post_message` und `read_inbox` aus dem demo-project-PM-Thread wurden von der
  Identitätssperre aus #13 abgelehnt. Gemeldet vom Codex-PM demo-project.

  Ursache, gemessen statt vermutet: Alle Codex-Threads der ChatGPT-App hängen an **einem**
  Prozess — die echten Aufrufe kamen mit `peer=6665/codex`, und alle Hook-Prozessketten in der
  Datenbank zeigen denselben Prozess unter ChatGPT 6593. Die Anfrage selbst trägt kein
  Thread-Merkmal: Kopfzeilen waren nur accept, content-length, content-type, host,
  mcp-protocol-version, user-agent und das Token, kein `mcp-session-id`, und jeder Aufruf
  benutzt einen frischen TCP-Port. Die Prozesserkennung aus #13 kann Codex-Threads deshalb
  grundsätzlich nicht trennen, und der Rückfall auf das Verzeichnis ist mehrdeutig.

  Behoben mit einem **Sitzungsschlüssel je Chat** (Migration `0010-sitzungsschluessel`):
  CrewPip erzeugt ihn und nennt ihn ausschließlich über den Hook dieses Chats; alle Tools
  haben dafür das optionale Feld `session_key`, das Prozess und Verzeichnis schlägt. Der
  Hinweis erscheint nur, solange ein anderer lebender Chat derselben App denselben Prozess und
  dasselbe Verzeichnis hat — allein im Ordner bleibt der Kontext unverändert. Ein unbekannter
  Schlüssel wird abgelehnt und fällt nicht auf das Verzeichnis zurück; ohne Schlüssel bleibt
  die Sperre aus #13 unverändert.

  Nachtrag aus der Feldabnahme: Bei Codex feuert in der Praxis nur der **Stop**-Hook (Befund des
  Codex-PM; auch die Zustellung von Nachrichten läuft darüber). Der Schlüssel reist deshalb auch
  bei `stop` mit — aber nur, wenn in derselben Antwort ohnehin Post zugestellt wird und der Turn
  damit schon blockiert würde. Ein Stop allein für den Schlüssel bleibt ausgeschlossen, sonst
  entstünde eine Schleife; die Sperre sitzt doppelt, im Daemon und im Hook-Skript, damit auch
  ein künftiger Daemon keinen leeren Stop blockieren kann.

  Abgewogen: Eine bloß behauptete Session-ID im Werkzeugaufruf wäre keine Identität, weil jeder
  Aufrufer sie setzen kann — der Schlüssel ist dagegen an den Hook gebunden, der nur in diesem
  Chat läuft. „Der Chat, der gerade einen Turn hat“ wäre geraten und bricht, sobald zwei Chats
  im selben Ordner gleichzeitig arbeiten; genau das war der gemeldete Fall. Der Preis: Der
  Schlüssel steht im Kontext des Chats, ein Chat kann ihn also preisgeben. Er erlaubt nur, als
  diese Session zu sprechen und deren Post zu lesen — weniger, als das CrewPip-Token kann, das
  in der Codex-Konfiguration ohnehin steht. Zweiter Preis: Wird ein zweiter Chat mitten im Turn
  eines älteren geöffnet, wird der ältere für diesen Turn abgelehnt; den Schlüssel bekommt er
  mit dem nächsten Turn.

  Belegt: Rot-Grün nach AGENTS.md. Der Test (`apps/daemon/test/http.test.ts`, „Aufgabe #46“)
  stellt zwei Codex-Sessions mit gemeinsamem Prozess und gleichem Verzeichnis nach; gegen den
  unveränderten Stand fällt er („Hook liefert einen Sitzungsschlüssel“), mit dem Fix ist er
  grün. Befehl: `npx tsx --test --test-name-pattern="Aufgabe #46" test/http.test.ts` in
  `apps/daemon`, Gegenprobe mit `git stash push -- apps/daemon/src packages/shared/src
  apps/hook/crewpip-hook.mjs`. Dazu geprüft: fremder Schlüssel, Schlüssel einer anderen App,
  Schlüssel einer beendeten Session — alle drei werden abgelehnt. Im Feld war die Lage vor dem
  Fix ebenfalls rot (PM- und Marketing-Thread ohne Sternchen, `read_inbox` abgelehnt).

  Feldabnahme mit zwei echten Codex-Threads in demo-project, jeder nur mit dem Schlüssel aus seinem
  eigenen Stop-Hook: Der PM-Thread wird in `list_sessions` als Session 17:26 markiert, ohne
  Warnhinweis, und seine Nachricht #297 ist als 17:26 verbucht; der Marketing-Thread markiert
  mit demselben Aufruf seine eigene Session 15:52 und ist in Nachricht #300 als 15:52 verbucht,
  während 17:26 gleichzeitig ohne Sternchen gelistet bleibt. Die Zustellung von #295 und #296
  ist als `hook-stop` protokolliert — der Stop-Weg trägt den Schlüssel also im Betrieb.

  Nachtrag aus dem Review von PR #5: Die Probe „Schlüssel einer anderen App gilt hier nicht“ war
  wirkungslos. Sie legte eine einzelne Claude-Session im selben Verzeichnis an — und weil
  `needsSessionKey()` nur Chats **derselben** App zählt, bekam diese Session gar keinen Schlüssel.
  Der Aufruf ging also ohne `session_key` hinaus und wurde von der Sperre aus #13 abgelehnt, nicht
  an der App-Grenze. Gemessen: Entfernt man `AND app = ?` aus der Schlüsselabfrage in
  `Inbox.identify`, bleibt die alte Probe grün. Jetzt legt der Test zwei Claude-Sessions an einem
  gemeinsamen Prozess an, prüft, dass der Hook einen echten Schlüssel herausgibt (≥ 22 Zeichen),
  und schickt diesen. Gegen dieselbe entfernte App-Grenze fällt er damit — an genau der
  Zusicherung „Schlüssel einer Claude-Session gilt nicht für Codex“. Mit der App-Grenze grün.
  Im selben Zug nachgezogen: Beide Ablehnungen prüfen nun den Satz „gehört zu keiner laufenden
  Session“, der nur zur Schlüsselablehnung gehört. Das bloße Wort „Sitzungsschlüssel“ steht auch
  in der Meldung zur Mehrdeutigkeit und konnte die beiden Wege nicht auseinanderhalten.

  Negativproben im Feld, vom Codex-PM bestätigt (#302): `read_inbox` **ohne** Schlüssel wird bei
  beiden Chats weiterhin abgelehnt, und ein erfundener Kontrollschlüssel wird ausdrücklich
  abgelehnt, ohne Rückfall auf das Verzeichnis. Die Sperre aus #13 ist also unverändert wirksam.
  Ohne Schlüssel aus der Datenbank, ohne simuliertes Hook-Ereignis, ohne Neustart der App und
  ohne Ersatzidentität.

### Known issues

- **MCP-Aufrufe liefen unter fremdem Namen, sobald zwei Sessions im selben Ordner arbeiteten
  (Aufgabe #13).** Der Daemon wählte beim MCP-Aufruf die zuletzt aktive Session des
  Verzeichnisses. Director und Worker im CrewPip-Repo schrieben dadurch abwechselnd unter dem
  Namen des anderen, und der Fehler pflanzte sich fort: Die Nachricht des Directors an
  PM smartguardai trug die Antwortadresse des Workers, die Antwort des PM landete beim Worker.
  Auch Aufgaben bekamen den falschen „angelegt von“. Gemeldet vom Director.

  Jetzt erkennt der Daemon den Aufrufer am Prozess: Er fragt per `lsof`, wer das andere Ende
  der Verbindung hält, und sucht diesen Prozess in der Claude-Registry (`pid`) oder in der
  Prozesskette, die er sich beim Sitzungsstart über dem Hook merkt (Migration
  `0009-prozesskette`). Das Verzeichnis zählt nur noch als Rückfall. Passen danach mehrere
  Sessions, lehnen die Werkzeuge ab, statt zu raten; nur `list_sessions` und `list_tasks`
  antworten trotzdem.

  Abgewogen: Eine Session-ID als Werkzeugfeld, die der Hook dem Modell in den Kontext gibt, wäre
  plattformunabhängig, hinge aber am Modell (vergessen, nach dem Zusammenfassen verwechseln).
  Eine Bindung pro MCP-Verbindung scheidet aus: Der Transport ist zustandslos, zwischen zwei
  Aufrufen besteht gemessen keine Verbindung. Der Preis des gewählten Wegs: macOS/Linux-
  Werkzeuge (`lsof`, `ps`), rund 0,05 s je MCP-Aufruf und einmal je Sitzungsstart im Hook.
  Ablehnen statt Markieren, weil ein als „unsicher“ markierter Absender trotzdem eine falsche
  Antwortadresse trüge und `read_inbox` fremde Post als zugestellt verbuchen würde.

  Belegt: echter `lsof`-Test gegen einen Kindprozess; Abnahme mit Attrappe (vier Nachrichten
  abwechselnd, jeweils nachdem die andere Session zuletzt aktiv war; Gegenprobe ohne
  Prozesserkennung scheitert); live: `list_sessions` mit dem Verzeichnis von demo-project erkannte den
  Worker CrewPip, und der Hook des Directors trug die Kette `claude 51628 → disclaimer →
  Claude` ein, deren erstes Glied die Registry-pid ist. Für Codex ist der Weg über die
  Prozesskette gebaut, aber noch nicht im Betrieb geprüft.

- **Der Auftrag an Claude Code wäre als Werkzeugmuster verschluckt worden.** `--allowedTools`
  nimmt beliebig viele Werte; ein dahinter angehängter Auftrag landet in der Liste. Der Auftrag
  geht jetzt über stdin. Aufgefallen beim ersten echten Test.
- **Das Laufzeitlimit hätte mitten im Push zuschlagen können.** Es gilt jetzt nur dem
  Agent-Prozess; der anschließende Push hat ein eigenes Limit, und ein Lauf wird nur einmal
  abgeschlossen.

- **Ein fehlgeschlagener Bootstrap hätte als erfolgreich gegolten.** Bei mit `;` verketteten
  Befehlen liefert die Shell den Status des letzten; ein gescheitertes `pnpm install` in der
  Mitte wäre durchgerutscht. Der Bootstrap läuft jetzt mit `set -e`. Gefunden vom eigenen Test,
  nicht im Betrieb.

- **Eine erledigte Aufgabe verlor ihren Bearbeiter.** `PATCH /api/tasks/:id` mit
  `{"status":"done"}` setzte die Zuweisung auf null, obwohl das Feld nicht mitgeschickt wurde;
  damit ging verloren, wer die Aufgabe bearbeitet hat. Jetzt wird die Zuweisung nur noch bei
  `open` gelöscht — zurück in den Topf heißt frei, erledigt und verworfen behalten sie.
  Gemeldet vom Director.

- **Push galt als zugestellt, ohne das Modell zu erreichen.** Der Inbox-Socket von Claude Code
  nimmt eine Nachricht nur mit dem aktuellen Token der Session an. Das Token gehört zum
  Prozess, die Session-Kennung überlebt einen Neustart — CrewPip erneuerte über die Registry
  Socket-Pfad und Prozessnummer, das Token aber nicht, weil es dort nicht steht. Danach schrieb
  der Daemon mit einem veralteten Token auf einen frischen Socket, verbuchte das als
  `push` und die Nachricht war weg.
  Belegt an der Director-Session: CrewPip führte sie seit 04.09. 11:41, der Prozess lief seit
  05.09. 08:00. Gegenprobe am eigenen Socket: mit richtigem Token kam die Nachricht an, mit
  falschem und ganz ohne nicht.
  Behoben: Ein wechselnder Socket-Pfad verwirft das Token, und ohne Token wird nicht gepusht —
  die Nachricht bleibt liegen und geht über die Hooks raus. Umzug
  `0005-socket-token-zuruecksetzen` verwirft die vorhandenen Token einmalig; sie kommen beim
  nächsten Hook-Aufruf zurück. `pushable` in der Oberfläche behauptet keinen Kanal mehr, den
  es nicht gibt.

- **WebSocket-Prüfung ließ Verbindungen hängen.** Die Token-Prüfung rief eine
  Express-Methode auf einem rohen Node-Request auf; der Fehler blieb unsichtbar, die
  Verbindung antwortete nie. Aufgefallen an einem Testlauf, der nach zwei Minuten abbrach
  statt zu scheitern.

- **Absender „Du" für Nachrichten, die nicht von dir kamen.** Meldungen von CrewPip selbst
  trugen dasselbe Kennzeichen wie deine eigenen; jetzt steht dort „System", solange der Name
  nicht deiner ist.

- **Eine beendete Session, die sich zurückmeldete, blieb als „beendet" stehen.** Der
  Registry-Abgleich setzte `ended_at` zurück, den Status aber nicht. Sie empfing Nachrichten,
  sah in der Oberfläche aber tot aus — aufgefallen an einer Meldung an den Director, die bei
  einer scheinbar beendeten Sitzung wartete.

- **Der Dienst fand global installierte Programme nicht.** Die Plist trug nur das
  Cellar-Verzeichnis von node im Suchpfad, nicht `/opt/homebrew/bin`; ein dort installiertes
  `claude` wäre unsichtbar geblieben.

- **Seitenleiste sprengte das Fenster.** Grid- und Flex-Kinder haben `min-height: auto`,
  deshalb wuchs die Sessionliste über die Fensterhöhe hinaus und schob die ganze Seite weg,
  statt selbst zu scrollen. Mit 15 Sessions war die Oberfläche dadurch leer. Behoben mit
  `min-height: 0` auf Seitenleiste, Hauptbereich und Nachrichtenliste.

### Changed

- **Der Push-Weg über den Inbox-Socket ist entfernt.** Er hat nicht funktioniert und wurde
  trotzdem als Zustellung verbucht: Claude Code stellt eine Socket-Nachricht ohne Rückfrage
  nur von einem eigenen Kindprozess der Sitzung zu. Der Daemon ist ein launchd-Dienst und
  damit für keine Sitzung ein Kind; bei übersprungenen Rückfragen wird die Nachricht
  zurückgehalten und nach fünf Minuten verworfen, während der Socket-Schreibvorgang gelingt.
  Belegt mit zwei Proben an zwei verschiedene Sitzungen, beide als zugestellt verbucht, keine
  erschienen. Zustellung läuft jetzt ausschließlich über die Hooks; das Protokoll zeigt
  „wartet" statt „sofort". Ältere `push`-Einträge bleiben lesbar und heißen jetzt
  „über den Socket (unbestätigt)".
  Nebeneffekt, der die Änderung zusätzlich rechtfertigt: CrewPip speichert damit keine
  Messaging-Token fremder Sitzungen mehr. Das Hook-Skript schickt sie nicht mehr mit, Umzug
  `0006-socket-spalten-entfernen` löscht die beiden Spalten. Netto 179 Zeilen weniger Code.

- **Sessions statt Agent-Namen.** Absender und Empfänger sind jetzt einzelne Chat-Fenster
  (App, Projektordner, Session-ID, frei wählbarer Name), angezeigt als
  `Claude · example-project / api-worker`. Vorher hieß jede Claude-Session „claude“, acht
  Fenster aus acht Projekten waren nicht unterscheidbar. Ziele: `session:`, `project:`,
  `app:`, `all`, `human:`. Pro Session und Nachricht wird die Zustellung mit Weg und
  Zeit verbucht (`deliveries`), die UI zeigt sie unter jeder Nachricht.
- MCP-Tools bekommen ein Pflichtfeld `cwd`; darüber ordnet der Daemon den Aufruf einer per
  Hook gemeldeten Session zu. `list_agents` heißt jetzt `list_sessions`.
- Web-UI: Sidebar nach Projekt gruppiert, Status pro Session (arbeitet, idle seit,
  beendet), Push-Kennzeichen, Umbenennen, Empfängerwahl nach Session, Projekt oder App.
- Hook-Skript: `CREWPIP_AGENT` entfällt, `CREWPIP_SESSION_NAME` setzt den Anzeigenamen.
  Die installierten Hook- und MCP-URLs bleiben gültig.
- Datenbankschema neu; ohne Migration, die alte Datei wird gelöscht (enthielt nur Testdaten).

### Added

- **Fester Grundstock an Befehlen für schreibende Läufe** (Option A, entschieden 18.09.2026).
  Claude-Code-Läufe bekommen `git add/commit/status/diff/log` und
  `pnpm install/test/typecheck/lint/format` erlaubt, auch mit `--filter`; ausdrücklich verboten
  ist jeder `git push`, und Verbote gehen auch vor den Freigaben des Projekts. Keine Freigabe
  für `pnpm run/exec/dlx`.
  **Abweichung vom Wortlaut der Entscheidung, begründet:** Die Entscheidung nannte `git push` in
  der Freigabe und versprach zugleich „nicht auf main". Beides zusammen ist mit Befehlsmustern
  nicht zu halten — ein echter Lauf hat `git push origin crewpip/x:main` trotz Verbotsregel
  durchgebracht und auf main geschrieben. Deshalb pusht jetzt CrewPip selbst, nach einem
  erfolgreichen Lauf, genau den Branch der Aufgabe, mit fester Argumentliste. Das Ziel der
  Entscheidung ist damit erreicht, der Weg ist ein anderer.
- **Push durch CrewPip nach dem Lauf**, mit pre-push-Hook des Projekts. Ein roter Hook macht den
  Lauf zum Fehlschlag, die Arbeit bleibt als Commit erhalten; das Ergebnis steht am Lauf
  (`push_log`, Umzug `0008-lauf-push`). Ohne Commit wird nichts gepusht.
- **Codex:** Die Sandbox bekommt genau die vier Stellen im Git-Verzeichnis frei, die ein Commit
  im Worktree schreibt (gemessen), nicht `config` und `hooks`. Im Betrieb ungeprüft, weil das
  Codex-Kontingent am 18.09. erschöpft war.
- Belegt mit einem echten Claude-Code-Lauf durch den Daemon, in einem Wegwerf-Repository mit
  lokalem Remote: Commit erlaubt, `git push origin HEAD:main` abgelehnt, Branch von CrewPip
  gepusht, pre-push-Hook lief, `main` unverändert.

- **Bootstrap je Projekt.** Ein frisch angelegter Worktree hat kein `node_modules`; damit
  läuft dort weder ein Test noch ein Git-Hook. Projekte haben jetzt ein Feld `bootstrap`
  (etwa `pnpm install --frozen-lockfile`), das nach `git worktree add` im Worktree ausgeführt
  wird; Ausgabe und Ergebnis stehen am Task und in der Oberfläche. Ein Fehlschlag lässt den
  Worktree stehen und nennt den Grund, statt erst beim ersten Commit aufzuschlagen.
  Der Befehl wird **in CrewPip gepflegt, nicht aus dem Repository gelesen** — sonst würde
  ein Repository bestimmen, was der Daemon ausführt. Belegt an CrewPip selbst: Worktree
  angelegt, `pnpm install` gelaufen, Typecheck darin grün.

- **Zugangsschutz für den Daemon.** Token in `~/.crewpip/token` (Modus 0600, beim ersten
  Start erzeugt), verlangt als Kopfzeile `x-crewpip-token` oder `Authorization: Bearer` für
  `/api`, `/mcp`, `/hooks` und den WebSocket. Dazu Prüfung des Host-Kopfs gegen DNS-Rebinding
  und Abweisung fremder Herkünfte, beides auch bei gültigem Token. Die Weboberfläche bekommt
  das Token beim Ausliefern der Startseite eingesetzt; eine fremde Herkunft bekommt die Seite
  gar nicht erst. Das Hook-Skript liest das Token aus der Datei, deshalb bleibt die
  Hook-Konfiguration unverändert und die Codex-Freigabe gültig.
  Grenze, die dabei bewusst offen bleibt: Ein Programm, das unter demselben Benutzer läuft,
  liest die Tokendatei mit. Der Schutz zielt auf Webseiten im Browser und auf den Fall, dass
  der Port einmal über die Maschine hinaus geöffnet wird.

- **Agents dürfen Agents starten** — mit Schranken, damit daraus kein Selbstläufer wird.
  Neue MCP-Werkzeuge `start_run`, `list_runs`, `stop_run`. Voreinstellung ist `read-only`;
  schreibend geht weiterhin nur im Worktree einer Aufgabe, den Haupt-Checkout erreicht dieser
  Weg gar nicht.
  - **Tiefenbegrenzung:** Eine Session, die aus einem Lauf stammt, darf keine Läufe starten.
    Dazu merkt sich CrewPip über die Umgebungsvariable `CREWPIP_RUN` und den Hook, aus
    welchem Lauf eine Session hervorgegangen ist.
  - **Obergrenze je Stunde** (`CREWPIP_RUNS_PER_HOUR`, Standard 20) je anstoßender Session.
  - **Herkunft** wird gespeichert und angezeigt; abbrechen darf nur, wer gestartet hat.
  - Ist ein Lauf fertig, bekommt die anstoßende Session eine Nachricht mit dem Ergebnis.
    Berichtet wird von der Session des Laufs selbst, falls sie sich angemeldet hat.
- Umzug `0004-lauf-herkunft` für die beiden Herkunftsfelder.

- **Rollen aus [docs/rollen.md](docs/rollen.md) im Datenmodell.** Jede Session trägt
  optional `director`, `pm` oder `worker`; die Rolle wird aus dem Sitzungsnamen abgeleitet
  (`Director`, `PM <repo>`, `Worker <repo>`), lässt sich aber auch setzen. Höchstens ein
  Director und ein PM je Projekt: eine neue Vergabe löst die bisherige ab.
- **Adressierung nach Rolle**: `director` und `pm:<projekt>` als Ziele für Nachrichten.
  Sie werden erst bei der Zustellung aufgelöst und erreichen deshalb auch den, der die
  Rolle später übernimmt — anders als `session:<id>`, das an ein bestimmtes Fenster geht.
  Damit übersteht eine Meldung an den Director dessen Neustart.
- Umzug `0003-rollen` trägt die Rollen aus den vorhandenen Namen nach.
- Seitenleiste zeigt die Rolle als Kennzeichen und erlaubt, sie zu ändern; die
  Empfängerauswahl kennt „an den Director" und „an den PM von <Projekt>".

- **Datenbank-Umzüge.** Nummerierte Kette in `migrations.ts`, festgehalten in
  `schema_migrations`. Vor dem ersten offenen Umzug wird mit `VACUUM INTO` nach
  `~/.crewpip/backups/` gesichert (WAL-sicher, letzte zehn bleiben liegen); scheitert die
  Sicherung, wird nicht umgezogen. Jeder Umzug läuft in einer eigenen Transaktion und wird
  erst nach Erfolg eingetragen, ein Abbruch lässt den Stand unverändert. `pnpm db:status`,
  `pnpm db:migrate` und `pnpm db:backup` arbeiten auch ohne laufenden Daemon;
  `GET /api/health` nennt den Schemastand.
  Bisher hieß eine Schemaänderung: Datei löschen. Auf der vorhandenen Datenbank angewandt,
  mit 14 Projekten, 2 Aufgaben, 4 Läufen, 128 Sessions und 2 Nachrichten, alles erhalten.
- `0002-indizes` ergänzt Indizes für Sessions je Projekt, laufende Läufe und Zustellungen.

- **Anmeldestatus je Werkzeug.** `GET /api/runner/apps` meldet jetzt neben dem Programmpfad
  auch, ob es angemeldet ist (`codex login status` schreibt nach stderr, `claude auth status`
  gibt JSON auf stdout; beide Kanäle werden gelesen, Ergebnis 30 s gepuffert,
  `?refresh=1` verwirft den Puffer). Ein nicht angemeldetes Werkzeug lässt sich in der
  Oberfläche nicht auswählen, und der Daemon lehnt den Start mit dem passenden Hinweis ab.

- **Variante B: Agents aus CrewPip starten.** Ein Runner startet Codex oder Claude Code als
  eigenen Prozess in einer Aufgabe, liest die Ausgabe zeilenweise mit, zeigt Nachrichten,
  Befehle und Werkzeugaufrufe live und verbucht das Ergebnis. Ein fertiger Lauf setzt seine
  Aufgabe auf „zu prüfen".
  - Genau zwei Rechtestufen, „nur lesen" und „im Worktree schreiben"; eine Stufe ohne Sandbox
    gibt es bewusst nicht. Schreibende Läufe verlangen einen Worktree, ein Lauf kann das
    Projektverzeichnis nicht verlassen, höchstens vier gleichzeitig, Zeitlimit 30 Minuten,
    jederzeit abbrechbar, vollständiges Protokoll unter `~/.crewpip/runs/`.
  - **Kein MCP-Werkzeug startet Läufe**: Agents können keine Agents starten.
  - Codex läuft sofort. Claude Code nicht: Die Desktop-App reicht ihre Anmeldung nur an
    selbst gestartete Sitzungen durch, weder über die Umgebung noch über den Schlüsselbund.
    Ein solcher Lauf endet deshalb mit dem Hinweis, das eigenständige CLI zu installieren
    und anzumelden, statt mit einer kryptischen Meldung.

- **Orchestrator: Projekte, Aufgaben, Worktrees.**
  - Projekte entstehen automatisch aus der Repository-Wurzel (`git rev-parse
    --git-common-dir`), womit Worktrees beim Haupt-Repository landen statt bei sich selbst.
    Ohne git greift eine Pfad-Heuristik, damit die Zuordnung nicht ganz verloren geht.
  - Aufgaben mit fünf Zuständen und geprüften Übergängen, Zuweisung an eine Session,
    Notizen. Eine Zuweisung aus der Oberfläche erzeugt eine Nachricht an die Session, läuft
    also über denselben Zustellweg wie alles andere.
  - Worktrees unter `<projekt>/.crewpip/worktrees/<id>-<titel>` mit eigenem Branch.
    Entfernen ist gesperrt, solange nicht committete Änderungen oder eigene Commits
    vorliegen; ein Branch ohne eigene Commits wird mitgelöscht, einer mit Commits bleibt.
  - Vier neue MCP-Werkzeuge: `list_tasks`, `create_task`, `claim_task`, `update_task`.
    Eine bereits vergebene Aufgabe kann keine zweite Session übernehmen.
  - Oberfläche mit Reitern für Nachrichten und Aufgaben; die Seitenleiste zeigt offene
    Aufgaben je Projekt und die Aufgabe, an der eine Session arbeitet.
  - Alle schreibenden git-Aufrufe laufen asynchron, damit ein langsames Repository den
    Daemon nicht blockiert.

- **Codex im Betrieb geprüft** (CLI 0.153.0-alpha.5, ChatGPT-App). Belegt: MCP-Tools
  `read_inbox` und `post_message` funktionieren mit dem Pflichtfeld `cwd`; alle vier Hooks
  feuern und melden die Session mit Projekt und Namen an. Gefunden dabei: Codex führt Hooks
  erst nach einer Freigabe per `/hooks` aus (Vertrauen hängt an der Prüfsumme der Datei),
  und `SessionEnd` erlaubt höchstens 3 s Timeout — der erzeugte Schnipsel setzt jetzt 3.
- **`CREWPIP_HOOK_DEBUG=<datei>`** schreibt Eingabe, Anfrage und Antwort jedes Hook-Aufrufs
  als JSON-Zeilen mit. Damit war überhaupt erst nachweisbar, dass Codex die Hooks nicht
  ausführte, statt dass CrewPip sie falsch beantwortete.
- Ein per Hook angemeldetes Chat-Fenster löst den MCP-Platzhalter („ohne Hook") desselben
  Arbeitsverzeichnisses ab, statt doppelt in der Liste zu stehen.

- **Session-Registry von Claude Code wird gelesen** (`~/.claude/sessions/*.json`, Pfad über
  `CREWPIP_CLAUDE_SESSIONS`). Der Daemon übernimmt Name, Arbeitsverzeichnis, Inbox-Socket
  und Prozess-ID; ein Beobachter (fs.watch plus Abgleich alle 20 s) trägt geschlossene
  Fenster aus. Damit erscheinen Claude-Code-Sessions auch ohne eingerichtete Hooks, ein
  `/rename` schlägt bis in CrewPip durch, und veraltete Einträge verschwinden von selbst.
  Das Dateiformat ist von Version 2.1.255 abgelesen, nicht dokumentiert; fällt es weg,
  arbeitet CrewPip nur mit den Hooks weiter.
- **Namensvorrang** `user` > `registry` > `auto`: ein ausdrücklich gesetzter Name (UI oder
  `/rename`) wird nie von einem abgeleiteten überschrieben.
- **Worktrees werden ihrem Repository zugeordnet.** Ein Fenster in
  `<projekt>/.claude/worktrees/<name>` erschien vorher als eigenes Projekt mit
  Zufallsnamen; jetzt steht es unter dem Repository, mit Worktree-Kennzeichnung, und
  Nachrichten an `project:<repo>` erreichen es mit.
- Die Seitenleiste kürzt abgeleitete Namen um den redundanten Ordnerpräfix
  (`example-org-94` → `94`) und zeigt die Startzeit; der volle Name steht im Tooltip.

- **Grundgerüst „Variante A“ (Sidecar).** Node-Daemon mit zustandslosem MCP-Endpunkt pro
  Agent-Name (`post_message`, `read_inbox`, `wait_for_message`, `list_agents`),
  Hook-Endpunkten für Sitzungsstart, Prompt, Turn-Ende und Sitzungsende, SQLite-Ablage
  über `node:sqlite`, WebSocket-Ereignisse und Auslieferung der Web-UI.
- **Hook-Skript** `apps/hook/crewpip-hook.mjs` ohne Abhängigkeiten. Ein Skript für Claude
  Code, Cursor und Codex; übersetzt die Daemon-Antwort in `hookSpecificOutput`
  (Claude Code, Codex) bzw. `followup_message` / `additional_context` (Cursor). Endet bei
  jedem Fehler still mit Exit 0.
- **Push in laufende Claude-Code-Sessions** über den Inbox-Socket, den der
  SessionStart-Hook meldet. Nachricht kommt zwischen zwei Tool-Aufrufen an oder startet
  einen neuen Turn.
- **Schleifensperre** für Stop-Hook-Fortsetzungen (`CREWPIP_MAX_STOP_CONTINUATIONS`,
  Standard 10), zurückgesetzt durch jeden menschlichen Prompt.
- **Web-UI** (Vite + React): Agents mit Ungelesen-Zähler, Nachrichtenstrom, Schreiben als
  Mensch, Live-Updates.
- **`pnpm snippets`** druckt die Konfigurationsschnipsel für alle drei Apps, `--write` legt sie
  unter `config/generated/` ab. Globale Konfigurationen werden nie automatisch verändert.
- **launchd-Dienst** `crewpip` über `pnpm service:install|status|restart|uninstall`
  (`scripts/service.mjs`): RunAtLoad, KeepAlive, Log unter `~/.crewpip/daemon.log`.
- ADR 0001 mit der Abwägung Sidecar gegen eigene Agent-Laufzeit.

### Trade-offs

- Agent-Identität ist ein Name in der URL, keine Session-ID. Einfach zu adressieren, aber
  zwei Sessions mit demselben Namen teilen sich den Lesecursor.
- Cursor erhält Nachrichten nur am Turn-Ende und beim Sitzungsstart, weil
  `beforeSubmitPrompt` keinen Kontext einspeisen kann.
- Das Socket-Protokoll für den Push ist aus dem Claude-Code-Binary abgelesen, nicht aus
  der Doku. Fällt es aus, greifen die Hooks.

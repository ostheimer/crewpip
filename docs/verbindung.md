# Wann ein Chat als verbunden gilt

Das Dashboard zeigt unter „Chats an CrewPip“ je Repo jeden eingetragenen Chat mit einem von
sieben Zuständen. Die Regel steht in `connectionOf` (`apps/daemon/src/inbox.ts`) und ist in
`apps/daemon/test/connection.test.ts` getestet. Das MCP-Werkzeug `list_sessions` nennt
denselben Zustand als `verbindung=…`.

| Zustand | Bedingung | Bedeutung |
| --- | --- | --- |
| Post kommt an (`connected`) | nicht ausgetragen, der Hook hat sich mindestens einmal gemeldet, der Agent-Prozess läuft | Post kommt beim nächsten Turn an, auch wenn der Chat gerade ruht. |
| Ohne Hook (`no-hook`) | eingetragen, aber nie über den Hook gemeldet (nur Claude-Registry oder nur MCP-Aufruf) | CrewPip kennt den Chat, aber ob Post von selbst ankommt, ist offen. Meldet sich der Hook auch nach dem nächsten Turn nicht, Chat neu starten oder Einrichtung prüfen. |
| Neustart nötig (`restart-needed`) | Claude: der Prozess läuft, hat seit seinem Start mindestens einen Turn beendet (Registry `status` = `idle`, letzte Statusänderung mindestens 10 s nach dem Start und mindestens 10 s her), aber kein Hook kam aus diesem Prozess | Der Chat hat die CrewPip-Hooks nicht geladen. Nur ein Neustart des Chats hilft (siehe unten). |
| Unbestätigt (`unconfirmed`) | Archivstatus der laufenden App nicht überprüfbar | Ein gemeinsamer Prozess allein belegt keine Zustellung an dieses Gespräch. |
| Archiviert (`archived`) | der Suchindex der Antigravity-App kennzeichnet das Gespräch als archiviert | Post bleibt für den nächsten Kontakt liegen. |
| Veraltet (`stale`) | der Agent-Prozess läuft nicht mehr, der Eintrag ist aber offen | Liegen gebliebener Eintrag. |
| Beendet (`ended`) | ausgetragen (SessionEnd, Claude-Registry, Platzhalter abgelöst oder von Hand) | erscheint nicht in der Übersicht. |

## Signale

- **Hook gemeldet:** Bei jedem Hook-Aufruf ermittelt der Daemon die Prozesskette über dem Hook
  und speichert sie (`proc_chain`), solange keine lebende bekannt ist. Eine gespeicherte Kette
  gibt es nur über den Hook-Weg.
- **Hook aus dem laufenden Prozess:** Bei Claude zählt die Kette nur, wenn sie die PID aus der
  Registry enthält. Die Desktop-App setzt eine Session nach einem Neustart mit derselben ID in
  einem neuen Prozess fort; eine Kette des alten Prozesses belegt dann keine Verbindung mehr,
  und der nächste Hook ermittelt sie neu.
- **Turn ohne Hook:** Die Registry nennt je Prozess `status` (`busy` im Turn, sonst `idle`) und
  `statusUpdatedAt`. Ein geladener Stop-Hook meldet sich am Ende jedes Turns; ist ein Turn seit
  mindestens 10 s vorbei und kam trotzdem nie ein Hook aus dem Prozess, hat er die Hooks nicht
  geladen. Fehlen die Felder
  (ältere Claude-Version), bleibt es bei „Ohne Hook“.
- **Prozess lebt:** Für Claude Code die PID aus der Registry `~/.claude/sessions`, sonst der
  Agent an der Spitze der Prozesskette (bei Codex der gemeinsame `codex`-Prozess der
  ChatGPT-App, bei Antigravity der gemeinsame `language_server` der App). Geprüft mit
  `kill(pid, 0)`.
- **Letzter Kontakt:** `last_seen_at`, gesetzt bei jedem Hook- und MCP-Kontakt. Er wird
  angezeigt, entscheidet aber nicht über den Zustand.

## Warum kein Zeitfenster

Ein ruhender Chat darf nicht als getrennt erscheinen. Am Stand vom 19.11.2026 hatten offene,
erreichbare Chats ihren letzten Kontakt teils über einen Tag zurück; ein Zeitfenster hätte
sie fälschlich getrennt gezeigt. Beendete Chats tragen Claude (Registry) und Codex (Hook
`SessionEnd`) bereits selbst aus, und alle Codex-Threads teilen sich einen Prozess. Der
Prozesszustand ist deshalb das tragfähigere Signal.

Grenze: Ein Codex-Thread, der ohne `SessionEnd` verschwindet, bleibt verbunden, solange die
ChatGPT-App läuft. Der letzte Kontakt steht deshalb an jedem Chat dabei.

Antigravity (gemessen mit 2.33 am 20.11.2026): Der Hook läuft direkt unter dem
`language_server` der App, Kette `language_server` → `Antigravity`. Alle Gespräche teilen diesen
Prozess. Antigravity kennt kein `SessionEnd`. Seit App-Version 2.34 ist eine zusätzliche
Quelle geprüft: `~/.gemini/antigravity/conversation_summaries.db` (Suchschema 3). CrewPip
liest beim Start und alle 30 Sekunden den App-Eintrag (`app_data_dir = antigravity`), seinen
Suchindex-Kopf (`chunk_index = -1`) und die kleine `annotations/<ID>.pbtxt` für registrierte
App-Gespräche. Ein Archivkennzeichen in einer der beiden Quellen ergibt „Archiviert“.
Widersprechen die Quellen einander, gilt zunächst der Archivnachweis. Sind die Daten
unlesbar, fehlt der App-Eintrag oder ist das Indexschema unbekannt, bleibt ein bereits
bestätigtes Archiv im laufenden Dienst erhalten. Sonst erscheint ein lebender App-Prozess
mit ungeklärtem Gesprächszustand als „Unbestätigt“. Wieder lesbare Metadaten können die
reguläre Prozessanzeige herstellen. Ein fehlender Eintrag allein belegt kein Löschen. Archivierung ändert weder Zustellung
noch Rollen. Die Hooks in `~/.gemini/config/hooks.json` gelten laut Doku auch für Antigravity-IDE und -CLI;
geprüft ist bisher nur die App.

Das Dashboard holt die Sitzungen zusätzlich alle 30 Sekunden neu, weil das Ende eines
Prozesses kein Ereignis auslöst.

## Warum ein Neustart nötig sein kann (#21)

Claude Code liest die Hook-Liste beim Start eines Chat-Prozesses. Ändert sich
`~/.claude/settings.json` später, übernehmen laufende Prozesse das nicht verlässlich. Belegt am
19./20.11.2026: Die CrewPip-Hooks kamen am 19.11. gegen 13:55 UTC in die Einstellungen (die
Sicherung der Einrichtung von 14:18 Ortszeit hat noch keinen `hooks`-Block). In den
Transkripten zeigt die Stop-Hook-Zusammenfassung (`stop_hook_summary`) vorher bei allen Chats
5 Hooks, danach bei neu gestarteten 6. Von 21 Chats, die schon liefen, hatten 11 den
CrewPip-Hook später (einige erst nach einem Neustart ihres Prozesses), 10 nie, darunter Director, PM CMM und PM firmenwebseiten.at. Diese Chats
hatten Turns, aber CrewPip hat nie einen Hook-Aufruf von ihnen bekommen. Erst ein neuer Prozess
(Chat schließen und wieder öffnen) lädt die Hooks.

CrewPip kann einem laufenden Prozess keine Hooks nachreichen. Das Dashboard zeigt solche Chats
deshalb als „Neustart nötig“.

Grenzen der Erkennung: Ein Hook, der ankommt, verhindert „Neustart nötig“ für den laufenden
Prozess auch dann, wenn sich seine Prozesskette nicht ermitteln ließ; diese Merkung lebt nur im
Speicher des Daemons. Ob Claude Code den Registry-Status auch bei lokalen Befehlen ohne Stop-Hook
(etwa `/compact`) wechselt, ist nicht geprüft; ein solcher Wechsel allein könnte einen Chat
fälschlich als „Neustart nötig“ zeigen, bis der nächste Turn einen Hook schickt.

## Fehlgeschlagene Hook-Aufrufe

Das Hook-Skript schreibt jeden fehlgeschlagenen Aufruf als eine Zeile nach
`~/.crewpip/hook-errors.log` (änderbar über `CREWPIP_HOOK_ERROR_LOG`): Zeit, App, Ereignis,
Sitzungs-ID, Verzeichnis und Grund (z. B. `fetch failed (ECONNREFUSED)`, `Daemon antwortete 401`,
`Zeitlimit überschritten`, `Eingabe ohne Sitzungs-ID`). Prompts, Antworten und das Token stehen
nie darin. Ab 256 KB wird die Datei nach `hook-errors.log.1` verschoben. Der Daemon protokolliert
zusätzlich in `~/.crewpip/daemon.log`, wenn er einen Hook-Aufruf wegen fehlendem oder falschem
Token ablehnt oder ihn ohne Sitzungs-ID oder Verzeichnis verwirft.

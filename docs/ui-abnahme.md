# Oberfläche und Abnahme – 08.10.2026

Die Startseite ist der Überblick. Aufgaben und Nachrichten bleiben eigene Bereiche.

## Bedienung

- **Director schreiben:** ein Ziel projektübergreifend adressieren. Rollenpost wird beim nächsten Hook oder Postfachabruf zugestellt. Das Board weckt den Chat nicht automatisch.
- **Aufgabe planen:** Projekt bewusst wählen, Ergebnis beschreiben und speichern. Es startet noch kein Agent. Aufgaben können zugewiesen und über „zu prüfen“ abgenommen werden.
- **Nachrichten:** neueste zuerst, durchsuchbar, Markdown aufklappbar. „Antworten“ übernimmt die tatsächliche Antwortadresse. Zustellung und Erledigung sind unterschiedliche Zustände.
- **Projekt auswählen:** filtert Überblick, Aufgaben und Nachrichten. Ohne aktuelle Aktivität ausgeblendete Projekte bleiben per Suche und „Alle Projekte“ zugänglich. Mobil steht die Auswahl in der Kopfzeile.
- **Technik:** Worktrees, Bootstrap und neue Agentenläufe stehen hinter expliziten Details. Bootstrap speichert nur nach Klick.
- **Kosten:** die Anzeige startet keinen Modelllauf. Die Laufzahl zählt ausschließlich vom Board gestartete Agenten, nicht fremde Chats oder Automationen.

Die Projektmeldungen sind datierte Berichte der jeweiligen Chats. Die Oberfläche behauptet keine unabhängige Live-Prüfung und berechnet keine vermeintliche KI-Zusammenfassung.

## Verifikation

- `pnpm test`: 82 Daemon-Tests und 6 Hook-Tests grün.
- `pnpm typecheck` und `pnpm build` erfolgreich.
- Browserprobe auf Port 7358 mit SQLite-Sicherung als separater Vorschau-Datenbank: Projektpflicht vor Anlegen, Aufgabe korrekt gespeichert, gezielte Director-Nachricht und Suche, Projektwechsel, mobile Ansicht (390 × 844), dunkle Darstellung.
- Vorschauaktionen erzeugen keine Testaufgaben im produktiven Board.
- Die endgültige Oberfläche wird unter dem vorhandenen lokalen Port 7357 ausgeliefert.

## Aufgabe #19

Schreibende Claude-Läufe erhalten lesende Git-Befehle mit und ohne Argumente. Der Push bleibt bei CrewPip. Git Trace2 belegt den tatsächlichen Pre-Push-Unterprozess, einschließlich Zeitpunkten, Exit-Code und Dauer. Fehlende oder unterbrochene Hook-Nachweise werden ausdrücklich als solche bezeichnet. Interne Turbo-/Test-Cache-Treffer sind kein Beleg gegen einen tatsächlichen Hook-Aufruf.

Die Integrationstests führen echte Git-Pushes zu einem temporären lokalen Bare-Remote aus (grüner, roter und fehlender Hook). Verschachtelte Git-Prozesse werden nach Session- und Child-ID getrennt. Ein neuer kostenpflichtiger Claude-Lauf im fremden Projekt wird nicht als erfolgt behauptet; diese ursprüngliche Feldabnahme bleibt getrennt zu bestätigen.

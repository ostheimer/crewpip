# Wann ein Chat als verbunden gilt

Das Dashboard zeigt unter „Verbundene Chats“ je Repo jeden eingetragenen Chat mit einem von
vier Zuständen. Die Regel steht in `connectionOf` (`apps/daemon/src/inbox.ts`) und ist in
`apps/daemon/test/connection.test.ts` getestet. Das MCP-Werkzeug `list_sessions` nennt
denselben Zustand als `verbindung=…`.

| Zustand | Bedingung | Bedeutung |
| --- | --- | --- |
| Verbunden (`connected`) | nicht ausgetragen, der Hook hat sich mindestens einmal gemeldet, der Agent-Prozess läuft | Post kommt beim nächsten Turn an, auch wenn der Chat gerade ruht. |
| Ohne Hook (`no-hook`) | eingetragen, aber nie über den Hook gemeldet (nur Claude-Registry oder nur MCP-Aufruf) | CrewPip kennt den Chat, aber ob Post von selbst ankommt, ist offen. Meldet sich der Hook auch nach dem nächsten Turn nicht, Chat neu starten oder Einrichtung prüfen. |
| Veraltet (`stale`) | der Agent-Prozess läuft nicht mehr, der Eintrag ist aber offen | Liegen gebliebener Eintrag. |
| Beendet (`ended`) | ausgetragen (SessionEnd, Claude-Registry, Platzhalter abgelöst oder von Hand) | erscheint nicht in der Übersicht. |

## Signale

- **Hook gemeldet:** Bei jedem Hook-Aufruf ermittelt der Daemon die Prozesskette über dem Hook
  und speichert sie (`proc_chain`), solange keine lebende bekannt ist. Eine gespeicherte Kette
  gibt es nur über den Hook-Weg.
- **Prozess lebt:** Für Claude Code die PID aus der Registry `~/.claude/sessions`, sonst der
  Agent an der Spitze der Prozesskette (bei Codex der gemeinsame `codex`-Prozess der
  ChatGPT-App). Geprüft mit `kill(pid, 0)`.
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

Das Dashboard holt die Sitzungen zusätzlich alle 30 Sekunden neu, weil das Ende eines
Prozesses kein Ereignis auslöst.

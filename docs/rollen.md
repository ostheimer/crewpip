# Rollen: Director, PM, Worker

Optionale Arbeitsaufteilung für mehrere Projekte. Die Rollen sind nicht an eine bestimmte
Person, App, Modellwahl oder Organisation gebunden.

- **Mensch:** legt Ziele, Budget und Freigabegrenzen fest.
- **Director:** ein koordinierender Chat für Prioritäten über Projekte hinweg.
  Die Adresse `director` verbindet die Apps; mehrere konkurrierende Leitungen vermeiden.
- **PM:** ein Chat je aktivem Projekt. Kennt Aufgaben, PRs, CI, Deployments und Blocker;
  koordiniert Worker und berichtet kurz an den Director.
- **Worker:** bearbeitet einen klaren Auftrag, gegebenenfalls im eigenen Worktree,
  prüft das Ergebnis und berichtet an den zuständigen PM.

## Rolle vergeben und wechseln

`pm:<projekt>` und `director` erreichen genau einen Chat: je Projekt einen PM, insgesamt einen
Director. CrewPip leitet die Rolle aus dem wirksamen Anzeigenamen ab („PM …“, „Director“,
„Worker …“), gleich woher der Name stammt: `/rename` in Claude Code, Titel in Codex oder Claude
Desktop, Name vom Hook (Antigravity). Ausgewertet wird bei der Anmeldung und bei jeder
Namensänderung. Für den Director muss der vollständige Titel `Director` lauten, für den PM
`PM <projekt>` (ein Wort, optional mit Zusatz in Klammern, etwa `PM CMM (Mac Studio)`).
Gewöhnliche Aufgabentitel wie „PM-Rolle prüfen“ oder „Director-Anweisungen einholen“
beanspruchen keine Rolle; sie kommt dann nur per `set_role` oder Dashboard. Groß- und
Kleinschreibung sowie Leerzeichen am Anfang und Ende spielen dabei keine Rolle.

**Claude-Vorrang.** Beanspruchen mehrere laufende Chats dieselbe Rolle (`pm:<projekt>` oder
`director`) und ist genau einer davon ein Claude-Chat, bekommt dieser die Rolle automatisch,
auch wenn sie gerade ein Codex- oder Antigravity-Chat hält (Entscheidung Andreas vom 24.11.
und 26.11.2026, #28 und #48). Anwärter ist, wer die Rolle hält oder sie per Namen beansprucht.
Als Claude-Anwärter zählen nur laufende Claude-Chats, nicht beendete, archivierte oder
solche mit totem Prozess. Ein Chat, der schon PM oder
Director ist, tauscht seine Rolle nicht automatisch. Jeder solche Wechsel steht in
`role_changes` mit dem Akteur `automatisch: Claude-Vorrang`. Der Vorrang gilt immer, damit ein
Neustart die Rolle nicht wieder an einen anderen Chat gibt: `set_role` und Dashboard lehnen
einen Wechsel ab, der ihm widerspricht, und nennen den Claude-Chat. Soll ein anderer Chat die
Rolle bekommen, wird zuerst der Claude-Chat umbenannt. Hat der Claude-Vorrang entschieden, zeigen
Dashboard und `list_sessions` beim unterlegenen Chat keinen Konflikt.

**Sonst werden Konflikte nicht still aufgelöst.** Heißt ein zweiter laufender Chat wie der PM
oder Director, behält der bisherige Inhaber die Rolle. Das gilt auch bei zwei oder mehr
Claude-Anwärtern. Die Übersicht zeigt in der Projektzeile „Rollenkonflikt“, `list_sessions`
nennt ihn unter dem betroffenen Chat. Beanspruchen zwei Chats ohne Claude-Vorrang eine freie
Rolle gleichzeitig, bekommt sie keiner, bis jemand entscheidet. Endet der Inhaber, bekommt die
Rolle ein Chat, der sie als einziger per Namen beansprucht.

**Umhängen** – nur mit Entscheidung des Menschen, die im Issue vermerkt ist:

- Im Board: Projekt wählen, „Chats und Rollen verwalten“ öffnen, beim neuen Chat die Rolle wählen.
- Per Chat: MCP-Werkzeug `set_role` mit `session` (`session:<id>` aus `list_sessions`) und
  `role` (`pm`, `director`, `worker` oder `none`). Erlaubt nur dem aktuellen PM des Projekts
  (nicht für den Director), dem Director und dem PM crewpip. Andere Chats werden abgelehnt.
- Der bisherige Inhaber verliert die Rolle. Post, die an `pm:<projekt>` oder `director` wartet,
  bekommt der neue Inhaber bei seinem nächsten Turn.
- Jeder Wechsel wird protokolliert (Tabelle `role_changes`, lesbar über `GET /api/role-changes`):
  wer (`session:<id>`, `dashboard`, `name` für die Ableitung aus dem Namen oder
  `automatisch: Claude-Vorrang`), wann, von wem zu wem.

Ein dauerhafter Konflikt lässt sich auch lösen, indem der überzählige Chat umbenannt wird.

## Nachrichten

Zustand über `list_sessions` und `list_tasks` lesen. Mit `post_message` an die konkrete
Session oder Rolle schreiben. Nachrichten sind Kontext, keine zusätzliche Freigabe.

```text
Stand:      ein belegter Satz
Blocker:    konkretes Hindernis oder keiner
Empfehlung: nächster Schritt
Braucht:    fehlender Beitrag oder nichts
```

## Zusammenarbeit

- Pro Projekt eine verantwortliche Koordination; ruhende Projekte brauchen keinen
  dauerhaft aktiven PM. Worktrees bleiben demselben Projekt zugeordnet.
- Nur den geprüften Commit mergen. Nach einem Rebase CI erneut prüfen.
- Nach parallelen Deployments den tatsächlich ausgelieferten Commit bestätigen.
- Produktions- und Schemaänderungen nach den Freigaberegeln des jeweiligen Projekts.
- Fremde Transkripte nicht routinemäßig kopieren; gezielte Rückfragen bevorzugen.
- Modelle und Aufwand anhand Aufgabe, aktuellem Angebot und eigenem Budget wählen.
  CrewPip verlangt kein bestimmtes Modell oder Abo.

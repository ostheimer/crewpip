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
Namensänderung.

**Konflikte werden nicht still aufgelöst.** Heißt ein zweiter laufender Chat wie der PM oder
Director, behält der bisherige Inhaber die Rolle. Die Übersicht zeigt in der Projektzeile
„Rollenkonflikt“, `list_sessions` nennt ihn unter dem betroffenen Chat. Beanspruchen zwei Chats
eine freie Rolle gleichzeitig, bekommt sie keiner, bis jemand entscheidet. Bestehende Rollen
ändert CrewPip von sich aus nicht; endet der Inhaber, bekommt sie ein Chat, der sie als einziger
per Namen beansprucht.

**Umhängen** – nur mit Entscheidung des Menschen, die im Issue vermerkt ist:

- Im Board: Projekt wählen, „Chats und Rollen verwalten“ öffnen, beim neuen Chat die Rolle wählen.
- Per Chat: MCP-Werkzeug `set_role` mit `session` (`session:<id>` aus `list_sessions`) und
  `role` (`pm`, `director`, `worker` oder `none`). Erlaubt nur dem aktuellen PM des Projekts
  (nicht für den Director), dem Director und dem PM crewpip. Andere Chats werden abgelehnt.
- Der bisherige Inhaber verliert die Rolle. Post, die an `pm:<projekt>` oder `director` wartet,
  bekommt der neue Inhaber bei seinem nächsten Turn.
- Jeder Wechsel wird protokolliert (Tabelle `role_changes`, lesbar über `GET /api/role-changes`):
  wer (`session:<id>`, `dashboard` oder `name` für die Ableitung aus dem Namen), wann, von wem zu wem.

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

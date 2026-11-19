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

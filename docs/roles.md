# Roles: Director, PM, Worker

[Deutsch](rollen.md)

Optional division of work across several projects. Roles are not tied to a person, app, model
or organisation.

- **Human:** sets goals, budget and approval limits.
- **Director:** one coordinating chat for priorities across projects. The address `director`
  connects the apps; avoid competing leads.
- **PM:** one chat per active project. Knows tasks, PRs, CI, deployments and blockers;
  coordinates workers and reports briefly to the director.
- **Worker:** works on a clear assignment, in its own worktree if needed, checks the result
  and reports to the responsible PM.

## Assigning and changing a role

`pm:<project>` and `director` reach exactly one chat: one PM per project, one director overall.
CrewPip derives the role from the effective display name (“PM …”, “Director”, “Worker …”),
wherever the name comes from: `/rename` in Claude Code, the title in Codex or Claude Desktop,
or the name sent by the hook (Antigravity). It is evaluated at registration and on every rename.
For the director role, the full title must be `Director`. The match ignores case and surrounding
whitespace.

**Conflicts are never resolved silently.** If a second running chat is named like the PM or
director, the current holder keeps the role. The overview shows “Role conflict” in the project
row and `list_sessions` lists it under the affected chat. If two chats claim a free role at the
same time, neither gets it until someone decides. CrewPip does not change existing roles on its
own; when the holder ends, a chat that is the only one claiming the role by name takes it over.

**Changing the holder** – only with the human's decision, recorded in the issue:

- On the board: select the project, open “Manage chats and roles”, pick the role for the new chat.
- From a chat: MCP tool `set_role` with `session` (`session:<id>` from `list_sessions`) and
  `role` (`pm`, `director`, `worker` or `none`). Allowed only for the project's current PM (not
  for director), the director and the PM crewpip. Other chats are refused.
- The previous holder loses the role. Messages waiting for `pm:<project>` or `director` reach
  the new holder on its next turn.
- Every change is logged (table `role_changes`, readable via `GET /api/role-changes`): who
  (`session:<id>`, `dashboard`, or `name` when derived from the name), when, from whom to whom.

A lasting conflict can also be resolved by renaming the surplus chat.

## Messages

Read the state with `list_sessions` and `list_tasks`. Write to the specific session or role
with `post_message`. Messages are context, not an additional approval.

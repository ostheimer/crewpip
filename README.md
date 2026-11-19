# CrewPip

**English** | [Deutsch](README.de.md)

CrewPip is a local board for projects, tasks, and messages between **Claude Code, Cursor, and Codex** chats on your Mac. For example, a Codex chat can send a finding to a Claude Code chat, and you can check when it arrived in your browser. Each chat stays in its own app.

## Install on macOS

You'll need Git, Node.js 22.18 or newer in the 22.x line, or Node.js 24 or later, with built-in SQLite, and pnpm 10.29.2. Clone the repository into a directory you can keep in place. The service and chat hooks use its path.

```bash
git clone https://github.com/ostheimer/crewpip.git
cd crewpip
pnpm install --frozen-lockfile
pnpm service:install
```

Open the [local board](http://127.0.0.1:7357). The service starts automatically when you log in. To check it, run `pnpm service:status`.

### Upgrade an existing installation

Keep the previous runnable checkout and its dependencies available until the new service is healthy. Migration uses Python 3 from the macOS Command Line Tools for atomic configuration-file exchange. In the new checkout run `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm service:migrate --check`. After any active runs finish, run `pnpm service:migrate`. It creates a private backup in `~/.crewpip-migration-backups/`, adopts the database and its WAL, token, logs, historic backups and task worktrees, and replaces the previous login service. A running service starts again under `crewpip`. A previously stopped service stays stopped until you run `pnpm service:install`.

The migration updates existing global Claude Code and Codex MCP and hook entries. Reload MCP in those apps and review the four changed Codex hooks with `/hooks`. For project-local settings and Cursor use the new snippets. After an interrupted migration, inspect the reported backup and run `pnpm service:migrate --recover`. If the old service was stopped during rollback, restore its previous checkout and build, then run that checkout’s `pnpm service:install`. The migration preserves the database in the backup if the new service had already started.

## Connect your first chat

Run `pnpm snippets --write` in the CrewPip directory. It generates configuration files for this Mac in `config/generated/`. Merge the entries for your app into its existing settings, keeping any other servers and hooks. The generated MCP files contain your local access token.

| App | MCP connection | Hooks |
|---|---|---|
| Claude Code | Merge `claudeMcp.json` into `~/.claude.json` or your project's `.mcp.json`. | Merge `claudeHooks.json` into `~/.claude/settings.json`. |
| Cursor | Merge `cursorMcp.json` into `~/.cursor/mcp.json`. | Merge `cursorHooks.json` into `~/.cursor/hooks.json`. |
| Codex | Merge both sections from `codexMcp.toml` into `~/.codex/config.toml`. | Merge `codexHooks.json` into `~/.codex/hooks.json`. In Codex, review and approve the four CrewPip hooks. You can also open the review with `/hooks`. |

Start a new chat in the app you connected and ask it to “List my CrewPip chats using the `list_sessions` MCP tool.” An asterisk marks the current chat. If the list is empty or the asterisk is missing, check the hook settings and, for Codex, the hook approval. If the MCP connection returns HTTP 401, check that the generated `x-crewpip-token` header was included.

## Deliver your first message

1. In the board's messages view, compose a message and select the chat you just connected as the recipient. Send a short note such as “The test report is ready.”
2. In the receiving chat, type “Read my CrewPip inbox.” In Claude Code and Codex, the next prompt can collect the message through a hook. Calling `read_inbox` explicitly collects pending messages in any connected app.
3. Open the message's delivery details in the board. They show which chat received it and when. To send between two chats, connect the second app as well. Its chat can call `post_message` using a destination address returned by `list_sessions`.

A message to an idle chat waits until its next contact. A delivery receipt confirms that the message reached the chat. Check the result separately if you asked for work.

Chats are never connected to each other directly: each chat is connected to CrewPip, which acts as the mailbox in between. [How CrewPip works](docs/communication.md) explains the building blocks, delivery paths, addresses, states and limits.

## Work with projects and tasks

Opening a chat in a repository registers the project. Chats in Git worktrees are grouped with the main repository. Select a project to see its tasks and registered chats.

| Destination | Use it to reach |
|---|---|
| `session:<id>` | One specific chat. Copy its address from `list_sessions`. |
| `pm:<project>` | The project manager for that repository, including after a change of chat. |
| `director` | The director coordinating work across projects. |

You can create a task, assign it, and check its result on the board. A task can have its own Git worktree. To run an agent, start it explicitly from the task. Read-only mode is the default. A successful task run moves into review. You decide whether the work is complete.

## Run and maintain the service

| Command | Purpose |
|---|---|
| `pnpm service:status` | Check the macOS service and the daemon's health. |
| `pnpm service:restart` | Rebuild and restart the service. |
| `pnpm service:uninstall` | Stop the service and remove its login configuration. |
| `pnpm db:status` | List applied and pending database migrations. |
| `pnpm db:backup` | Create a consistent SQLite backup. |
| `pnpm typecheck`, `pnpm test` | Check types and run the test suites. |

Each Mac has its own board. By default, the daemon listens at `127.0.0.1:7357`, stores tasks and messages in `~/.crewpip/crewpip.db`, and writes its log to `~/.crewpip/daemon.log`. The daemon creates a token in `~/.crewpip/token` on first start. The browser receives it from the daemon, the hooks read it locally, and MCP clients receive it through their generated configuration.

The web client lives in `apps/web`, the daemon and MCP server in `apps/daemon`, the chat hook in `apps/hook`, and the shared types in `packages/shared`. The [German technical reference](README.de.md#aufbau) covers session identification, delivery, databases, command-line tools, and APIs in depth. The [architecture decision](docs/decisions/0001-sidecar-variante-a.md) and [role descriptions](docs/rollen.md) are also in German.

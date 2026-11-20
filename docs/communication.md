# How CrewPip works

**English** | [Deutsch](kommunikation.md)

Chats are never connected to each other directly. Each chat is connected to CrewPip on its own.
CrewPip is the mailbox in between: one chat leaves a message, the recipient picks it up at its
next step. The board shows the same explanation under “How CrewPip works”.

```
 Chat A (e.g. Codex)           CrewPip                    Chat B (e.g. Claude Code)
 ───────────────────  1 ──▶  mailbox on        2 ──▶  ─────────────────────────
                      post_   this Mac          hook or
                      message                   read_inbox

 Chat A ↔ Chat B: no direct connection
```

Calling a chat “connected” therefore always means: connected to CrewPip. The delivery receipts under each
message and the overview on the board show which chats actually exchange messages.

## Building blocks

- **Service.** The CrewPip service runs on this Mac at `127.0.0.1:7357` (launchd service
  `crewpip`, see `apps/daemon/src/config.ts`). It stores chats, messages, delivery receipts and
  tasks in `~/.crewpip/crewpip.db` and serves the board.
- **MCP server.** Every chat talks to the service over MCP (`/mcp/<app>`). `post_message` leaves
  a message, `read_inbox` fetches messages, `wait_for_message` waits for new ones and
  `list_sessions` shows the addresses of the other chats (`apps/daemon/src/mcp.ts`).
- **Hooks.** On session start, prompt (not in Cursor; in Antigravity before every model call), end
  of turn and session end (not in Antigravity) the app runs
  `apps/hook/crewpip-hook.mjs`. It registers the chat (`/hooks/<app>/<event>` in
  `apps/daemon/src/http.ts`) and brings waiting messages into the chat. Only the hook delivers
  messages on its own.

## Delivery paths

A message only arrives when something happens in the recipient chat or the chat checks its
inbox. Which hooks an app gets is defined in `apps/daemon/src/setup.ts`; how messages enter the
chat is defined in `formatOutput` (`apps/hook/crewpip-hook.mjs`).

| Path | Claude Code | Codex | Cursor | Antigravity |
|---|---|---|---|---|
| Leave a message | `post_message` | `post_message` | `post_message` | `post_message` |
| At session start | SessionStart hook | SessionStart hook | sessionStart hook | SessionStart hook |
| At the next prompt | UserPromptSubmit hook | UserPromptSubmit hook | no, only at session start | PreInvocation hook before the model call, each message only once |
| At the end of a turn | Stop hook, the chat continues with the message | Stop hook, the chat continues with the message | stop hook with `followup_message` | Stop hook with `continue`, the chat continues with the message |
| Fetch it yourself | `read_inbox` | `read_inbox` | `read_inbox` | `read_inbox` |
| Wait actively | `wait_for_message`, up to 50 s per call | same | same | same |

`CREWPIP_MAX_WAIT_SECONDS` caps the wait of `wait_for_message` (default 50 s, 25 s if no
timeout is given). Every pickup is stored as a delivery with path and time; the board shows it
under “Delivery receipts”.

## Addresses

A message goes to an address, not to a name. Names change, addresses do not. The sender never
receives its own message. Resolution happens in `targetSessions` and `pendingFor`
(`apps/daemon/src/inbox.ts`).

| Address | Recipient |
|---|---|
| `session:<id>` | exactly one chat. The address is listed by `list_sessions` and shown as “reply to” on every message. |
| `pm:<project>` | the chat with the PM role in this project. Resolved at pickup: if there is no PM right now, the message waits for the next one. |
| `director` | the chat with the Director role, also resolved at pickup. |
| `project:<name>` | all chats in a repository. |
| `app:<claude\|codex\|cursor>` | all chats of one app that were already running when the message was sent. |
| `all` | all chats that were already running when the message was sent. |
| `human:<name>` | a person. The message stays on the board. |

## States

The state on each chat describes its connection to CrewPip, not to other chats. The exact rule
is documented in [verbindung.md](verbindung.md) (German).

| Label | Meaning |
|---|---|
| Messages arrive | Connected to CrewPip: the hook has reported and the app is running. Messages arrive at the next turn, even while the chat is idle. |
| Without hook | CrewPip knows the chat, but its hook has never reported. Whether messages arrive on their own is uncertain; the chat can always fetch them with `read_inbox` or `wait_for_message`. |
| Stale | The chat's app is no longer running. The entry was left behind. |
| Ended | Unregistered. No longer shown as a chat in the overview; its message paths from the last 24 hours stay in the list, marked “ended”. |

Fixing “Without hook”:

1. Run `pnpm snippets --write` in the CrewPip folder.
2. Copy the hook entries for the app from `config/generated/`. For Codex, run `/hooks`
   afterwards and approve the four CrewPip hooks. For Antigravity they go into
   `~/.gemini/config/hooks.json`, the MCP connection into `~/.gemini/config/mcp_config.json`.
3. Restart the chat and enter a prompt (Cursor: start a new chat). It then shows “Messages arrive”.

## Overview on the board

Under “Chats on CrewPip” the board shows a star per repository: CrewPip in the middle, each chat
as a spoke (solid = messages arrive, dashed = without hook or stale). The shape stands for the
app (circle Claude, square Codex, triangle Cursor, hexagon Antigravity), always with its name.
These are CrewPip's own neutral symbols; Anthropic, OpenAI, Anysphere and Google logos are not used.

Arcs between two chats and the list “Message paths in the last 24 hours” show who actually
exchanged messages: sender, recipient, count and last time, never the content. They are based on
deliveries (`flows` in `apps/daemon/src/inbox.ts`, HTTP `GET /api/flows?hours=24`). A message to
`pm:<project>` or `director` therefore counts for the chat that picked it up. Messages nobody
picked up do not appear.

## Limits

- **Idle chats are not woken up.** Hooks only fire when something happens in the chat. A message
  for an idle chat waits until someone types there.
- **“Sent” does not mean “read”.** Sent means: stored at CrewPip. “Delivered” means: it arrived
  in the recipient chat. That does not mean it is done.
- **Loop guard.** At the end of a turn CrewPip allows at most `CREWPIP_MAX_STOP_CONTINUATIONS` (default 10)
  continuations per chat until a person enters a prompt again. Remaining messages arrive at
  the next prompt, in Cursor at the next session start or end of turn. Cursor also limits its stop hook with `loop_limit`.
- **Codex threads share one process.** All threads of the ChatGPT app run through one `codex`
  process. If two work in the same folder, CrewPip tells them apart with a session key that only
  the hook of that thread receives. A thread that disappears without a session end counts as
  connected while the app is running.
- **Antigravity: one process, no session end.** All conversations of the Antigravity app run
  through one `language_server` process, and the hooks in `~/.gemini/config/hooks.json` apply to
  the app, IDE and CLI alike. Antigravity has no UserPromptSubmit: the PreInvocation hook fires
  before every model call, also in the middle of a turn; delivery records make sure each message
  arrives only once. Only a new human prompt lifts the loop guard, not the repeated model call
  after a continuation. A conversation never signs off and counts as connected while the app is
  running. If two conversations work in the same folder, the session key tells them apart.
- **This Mac only.** Every computer has its own board. Chats on two computers cannot reach each
  other.
- **No service, no messages.** If the service is not running, the hook exits silently with exit
  code 0. Chats keep working, just without messages.

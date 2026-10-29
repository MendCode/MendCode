# Embedding MendCode in another UI

Third-party UIs (t3 code and similar) drive an agent as a child process that speaks JSON-RPC on stdio. t3 code does this with
Codex's `codex app-server`: `initialize` → `thread/start` or `thread/resume` → `turn/start`, then notifications
(`turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`), server requests for approvals
(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`) and
`turn/interrupt`. `mendcode app-server` offers the same shape over the existing daemon, so a host written for that
conversation needs little more than a different command and the method names below.

```bash
mendcode app-server [--cwd PROJECT] [--dir DATA]
```

It is a daemon client, like `acp`: threads are sessions, turns are queued messages, and every approval still goes through the
daemon's permissions. Nothing is added to the daemon or the wire protocol. Stdout carries only protocol lines (diagnostics go to
stderr), the process exits when stdin closes, and it is local-only (`--connect` / remote attach is refused). It starts the
daemon for `--dir` when none runs, as other commands do.

Other entry points, when stdio is not what you want: `run --format json` prints the raw session events of one turn,
`session events <id> --follow` follows a session, the daemon socket speaks the framed protocol (`generate` prints its JSON
Schema), and `serve` offers the opt-in [HTTP adapter](remote.md#http-adapter-b34).

## Stability

The conversation is named `mendcode-app-server@1` (`initialize` returns it as `protocol`). Inside a version, changes are additive
only: new methods, new optional fields, new notifications; a host ignores what it does not know. A breaking change gets a new
name and a new `initialize` answer. Times are epoch milliseconds. The types are exported without zod from
`@mendcode/protocol/wire` (`AppServerMethods`, `AppServerNotifications`, `AppServerServerRequests`, `AppServerItem`, ...).

## Messages

One JSON object per line, JSON-RPC 2.0 (`"jsonrpc": "2.0"` is sent and optional on input, as with Codex). Requests are handled
side by side, so `turn/interrupt` and approval replies are never blocked by a running request. Send `initialize`, then the
`initialized` notification, before anything else (`-32002` otherwise).

| Method | Params | Result |
|---|---|---|
| `initialize` | `clientInfo {name, version?}` | `protocol`, `serverInfo`, `methods`, `cwd` |
| `thread/start` | `cwd?`, `title?`, `model?` (`provider/model`), `effort?`, `agent?`, `approvalPolicy?` | `thread`; also notifies `thread/started` |
| `thread/resume` | `threadId`, `approvalPolicy?` | `thread`; attaches so the next events stream |
| `thread/fork` | `threadId`, `title?` | `thread` (the conversation continues in a new thread) |
| `thread/list` | `cwd?`, `limit?` (1-200), `search?`, `archived?` | `data: thread[]`, newest first |
| `thread/read` | `threadId`, `includeTurns?`, `limit?` (1-50), `before?` / `after?` | `thread`, `turns`, `older`, `newer` (cursors for the next page) |
| `thread/name/set`, `thread/archive` (`restore?`), `thread/compact/start` (`instructions?`) | `threadId`, ... | `{}` |
| `turn/start` | `threadId`, `input[]`, `model?`, `effort?`, `agent?`, `approvalPolicy?` | `queueId`, `queued`, `turn` |
| `turn/interrupt` | `threadId`, `turnId?` (default: the running turn) | `{}` |
| `model/list` | `threadId?` | `data: model[]`, `default?` |

`approvalPolicy` is a MendCode permission mode: `ask`, `edits`, `plan`, `smart` or `full` (the Codex values `untrusted`,
`on-request` and `never` are not mapped, so a host never grants more than it meant). A thread starts in the daemon's default.
`input` entries are `{type: "text", text}`, `{type: "mention", path}` (sent as `@path`), `{type: "localImage", path}` (the
daemon reads the file, an image or PDF within its limits) and `{type: "image", name, data}` (base64 bytes).

`turn/start` answers when the turn begins (`turn` set, `queued: false`) and always before that turn's `turn/started`
notification. A thread that is busy queues the message: the reply is immediate with `queued: true`, `turn: null`, and the later
`turn/started` carries the same `queueId`. When nothing starts within two seconds (the engine is slow to admit it) the reply is
also `queued: true`; match by `queueId`.

Notifications, all with `threadId`: `thread/started`, `turn/started` (`turn`, `queueId`), `turn/completed` (`turn.status` is
`completed`, `failed` with `error {code, message}`, or `interrupted` with `reason`), `turn/retrying`, `item/started`,
`item/completed` (the final `item`), the deltas `item/agentMessage/delta`, `item/reasoning/textDelta`,
`item/commandExecution/outputDelta`, `item/fileChange/outputDelta` and `item/toolCall/outputDelta`,
`thread/tokenUsage/updated` (per model call, with `costMicros` when the price is known), `thread/compaction/updated`,
`thread/approvalPolicy/changed` and `serverRequest/resolved`. Items are `userMessage`, `agentMessage`, `reasoning`,
`commandExecution` (`command`, `output`), `fileChange`, `toolCall` and `contextCompaction`. Another client attached to the same
thread (the TUI) shows the same turns and may answer an approval first; the host then gets `serverRequest/resolved`.

## Approvals and questions

The server asks the host with requests: `item/commandExecution/requestApproval` (shell tools),
`item/fileChange/requestApproval` (edits and writes) and `item/tool/requestApproval` (everything else, including MCP tools);
each has `requestId`, `title`, `detail`, and the answer is `{decision: "accept" | "acceptForSession" | "decline" | "cancel"}`.
`cancel` declines and interrupts the turn. An error reply, or a host that does not answer, never approves: an error declines,
and an unanswered request stays pending in the daemon (the TUI or a later client can still answer it). The daemon decides
what needs approval, so the policy (`approvalPolicy`, project rules, sandbox) is the same as in the TUI.
`item/tool/requestUserInput` carries `questions[]` (`id`, `header`, `question`, `options`) and expects
`{answers: {<id>: {answers: string[]}}}`. A plan review needs the TUI's full review flow, so it is not forwarded as a request:
the host gets `thread/attention` (`reason: "planReview"`) and the request stays pending.

## Resume

Threads are sessions and survive the app-server process and the daemon. A host stores `thread.id`; after a restart it sends
`thread/resume` and renders history with `thread/read` (`includeTurns`), then keeps streaming. Events of a turn that was already
running when the host attached are not replayed: read the thread, then follow the next ones. `thread/list` finds threads by
project or text.

## Typed client

`@mendcode/client/app-server` is a transport-free typed client: give it a `write` for the server's stdin and call `receive` with
each stdout line.

```ts
import { createAppServerClient } from "@mendcode/client/app-server"

const client = createAppServerClient({
  clientInfo: { name: "my-ui" },
  write: (line) => void child.stdin.write(line),
  handlers: { "item/commandExecution/requestApproval": async (params) => ({ decision: "decline" }) },
})
client.on("item/agentMessage/delta", (event) => process.stdout.write(event.delta))
await client.initialize()
const { thread } = await client.request("thread/start", { cwd: "/work/project", approvalPolicy: "ask" })
const { text, turn } = await client.runTurn({ threadId: thread.id, input: [{ type: "text", text: "explain this repo" }] })
```

`examples/app-server-client.ts` is a complete runnable version that spawns `mendcode app-server`
(`bun examples/app-server-client.ts "prompt" --cwd DIR [--accept]`).

## Security

Unexpected JSON-RPC failures return `internal error`; exception text is not sent to the host. Expected error messages
are redacted before transmission, including reflected method names.

The command runs commands and edits files only through daemon turns, under the daemon's permissions; it adds no tool and no
approval bypass. `localImage` and `thread/*` read local data, so the command is refused for remote attach. It is a
local client of your own daemon: whoever can write to its stdin has the authority of that terminal. Secrets are never put in
notifications beyond what the daemon already shows in the transcript (its events are redacted).

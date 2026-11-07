# Embedding MendCode in another UI

Use `mendcode app-server` to drive MendCode from a third-party UI such as t3 code, with JSON-RPC on a child process's stdio. It offers the same conversation shape as Codex's `codex app-server` over the existing daemon.

## Start the app-server

Run the child process:

```bash
mendcode app-server [--cwd PROJECT] [--dir DATA]
```

It is a daemon client, like `acp`: threads are sessions, turns are queued messages, and every approval still goes through the daemon's permissions. Nothing is added to the daemon or the wire protocol.

- Stdout carries only protocol lines; diagnostics go to stderr.
- The process exits when stdin closes.
- It is local-only: `--connect` / remote attach is refused.
- It starts the daemon for `--dir` when none runs, as other commands do.

### Adapt a Codex host

t3 code uses this conversation with Codex:

1. Send `initialize`, then `thread/start` or `thread/resume`, then `turn/start`.
2. Handle notifications: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`.
3. Handle server requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`.
4. Use `turn/interrupt` to interrupt.

A host written for that conversation needs little more than a different command and the method names below.

### Other entry points

When stdio is not what you want:

| Entry point | Does |
|---|---|
| `run --format json` | Prints the raw session events of one turn. |
| `session events <id> --follow` | Follows a session. |
| Daemon socket | Speaks the framed protocol; `generate` prints its JSON Schema. |
| `serve` | Offers the opt-in [HTTP adapter](remote.md#http-adapter-b34). |

## Stability

The conversation is named `mendcode-app-server@1`; `initialize` returns it as `protocol`.

- Inside a version, changes are additive only: new methods, new optional fields, new notifications. A host ignores what it does not know.
- A breaking change gets a new name and a new `initialize` answer.
- Times are epoch milliseconds.

The types are exported without zod from `@mendcode/protocol/wire`: `AppServerMethods`, `AppServerNotifications`, `AppServerServerRequests`, `AppServerItem`, ... .

## Messages

Send one JSON object per line using JSON-RPC 2.0 (`"jsonrpc": "2.0"` is sent and optional on input, as with Codex).

1. Send `initialize`.
2. Send the `initialized` notification.
3. Send other requests. Anything before initialization gets `-32002`.

Requests are handled side by side, so `turn/interrupt` and approval replies are never blocked by a running request.

### Methods

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

### Permission policy and input

`approvalPolicy` is a MendCode permission mode: `ask`, `edits`, `plan`, `smart` or `full`. A thread starts in the daemon's default.

The Codex values `untrusted`, `on-request` and `never` are not mapped, so a host never grants more than it meant.

| `input` entry | Content |
|---|---|
| `{type: "text", text}` | Text. |
| `{type: "mention", path}` | Sent as `@path`. |
| `{type: "localImage", path}` | The daemon reads the file, an image or PDF within its limits. |
| `{type: "image", name, data}` | Base64 bytes. |

### Match a turn to its reply

`turn/start` always answers before that turn's `turn/started` notification. Match replies and notifications by `queueId`.

| Condition | Reply |
|---|---|
| The turn begins | `turn` set, `queued: false`. |
| The thread is busy | Immediate reply with `queued: true`, `turn: null`; the later `turn/started` carries the same `queueId`. |
| Nothing starts within two seconds because the engine is slow to admit it | Also `queued: true`. |

### Notifications and items

All notifications carry `threadId`:

| Notification | Details |
|---|---|
| `thread/started` | Thread started. |
| `turn/started` | `turn`, `queueId`. |
| `turn/completed` | `turn.status` is `completed`, `failed` with `error {code, message}`, or `interrupted` with `reason`. |
| `turn/retrying` | Turn retrying. |
| `item/started` | Item started. |
| `item/completed` | The final `item`. |
| `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/toolCall/outputDelta` | Deltas. |
| `thread/tokenUsage/updated` | Per model call, with `costMicros` when the price is known. |
| `thread/compaction/updated` | Compaction updated. |
| `thread/approvalPolicy/changed` | Approval policy changed. |
| `serverRequest/resolved` | A server request was resolved. |

Items are `userMessage`, `agentMessage`, `reasoning`, `commandExecution` (`command`, `output`), `fileChange`, `toolCall` and `contextCompaction`.

Another client attached to the same thread, such as the TUI, shows the same turns and may answer an approval first. The host then gets `serverRequest/resolved`.

## Approvals and questions

The daemon decides what needs approval, so the policy (`approvalPolicy`, project rules, sandbox) is the same as in the TUI.

| Server request | Applies to |
|---|---|
| `item/commandExecution/requestApproval` | Shell tools. |
| `item/fileChange/requestApproval` | Edits and writes. |
| `item/tool/requestApproval` | Everything else, including MCP tools. |

Each request has `requestId`, `title`, `detail`. Answer with `{decision: "accept" | "acceptForSession" | "decline" | "cancel"}`.

- `cancel` declines and interrupts the turn.
- An error reply declines; it never approves.
- An unanswered request stays pending in the daemon, never approved. The TUI or a later client can still answer it.

### Questions and plan reviews

`item/tool/requestUserInput` carries `questions[]` (`id`, `header`, `question`, `options`) and expects `{answers: {<id>: {answers: string[]}}}`.

A plan review needs the TUI's full review flow, so it is not forwarded as a request. The host gets `thread/attention` (`reason: "planReview"`) and the request stays pending.

## Resume

Threads are sessions and survive the app-server process and the daemon.

1. Store `thread.id` in the host.
2. After a restart, send `thread/resume`.
3. Render history with `thread/read` (`includeTurns`), then keep streaming.

Events of a turn that was already running when the host attached are not replayed: read the thread, then follow the next ones. Use `thread/list` to find threads by project or text.

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

The command runs commands and edits files only through daemon turns, under the daemon's permissions. It adds no tool and no approval bypass.

`localImage` and `thread/*` read local data, so the command is refused for remote attach.

**Warning:** This is a local client of your own daemon. Whoever can write to its stdin has the authority of that terminal.

Secrets are never put in notifications beyond what the daemon already shows in the transcript; its events are redacted.

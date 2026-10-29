# TUI control REST (B84)

The existing [HTTP adapter](remote.md#http-adapter-b34) stays off by default and binds loopback only.
Every `/tui` route requires a full remote token; read-only tokens and browser Origin requests are denied.
Start a terminal with `--tui-control` to opt it into control of its project. Without an owner, UI requests
return 409. No TUI command is classified read-only: prompts and control requests may contain private content.

| Route | Payload / behavior |
|---|---|
| `POST /tui/append-prompt` | `{text}` inserts into the prompt, moves to its end, saves the draft |
| `POST /tui/open-help` | Opens Help |
| `POST /tui/open-sessions` | Opens the session picker |
| `POST /tui/open-themes` | Opens Themes; arrows/search preview, Esc restores, Enter persists |
| `POST /tui/open-models` | Opens the model search picker |
| `POST /tui/submit-prompt` | Submits through the normal prompt path |
| `POST /tui/clear-prompt` | Clears prompt, attachments and shell mode |
| `POST /tui/execute-command` | `{command}` invokes a registered built-in action |
| `POST /tui/show-toast` | `{title?, message, variant, duration?}`; variant `info/success/warning/error`, duration defaults to 5000 ms |
| `POST /tui/publish` | `{type, properties}` for `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, `tui.session.select` |
| `POST /tui/select-session` | `{sessionID}`; unknown session 404, different project 403 |
| `GET /tui/control/next` | Claims a polling owner; returns `{requestID, path, body}`, or 204 after 25 seconds |
| `POST /tui/control/response` | `{requestID, response: boolean}`, or legacy boolean for the sole outstanding request |

UI actions return `true` when processed, `false` when declined by the terminal (unknown command, another focused
editor, failed selection). Provider results still arrive through the ordinary session protocol. Opening pickers
preserves the draft. Themes use the shared bordered grid and header hints, with one column below 70 columns.
The v1 open-themes misroute to `session.list` is corrected.

The v1 underscore command aliases are accepted: `session_new`, `session_share`, `session_interrupt`,
`session_compact`, `messages_page_up/down`, `messages_line_up/down`, `messages_half_page_up/down`,
`messages_first/last`, `agent_cycle`. Published dotted IDs include `help.show`, `theme.list`, `model.list`,
`session.list/new/share/interrupt/compact/page.up/page.down/line.up/line.down/half.page.up/half.page.down/first/last`,
`prompt.clear/submit`, `agent.cycle`. Native key-action IDs are also supported; unknown IDs return false.
Existing provider/sharing configuration and approval rules apply to actions requiring them.

The daemon allows one owner per canonical project, at most 128 owners and 32 outstanding requests per project.
It delivers requests serially and waits at most 15 seconds for each result. There is no global broadcast, durable
queue or automatic resend of UI actions after disconnect. A persistent terminal owns by connection, never by a
caller-supplied client ID. Polling clients own by authenticated token, with a 30-second lease; use a dedicated token
and one polling loop. Only that owner can answer its current request. Revocation, cancellation, disconnect and
daemon stop release waiters. An action already delivered may finish after its caller cancels; cancellation does
not undo it. Native command IDs keep the existing replay-cache guarantees. Legacy bare responses are ordered;
use requestID for reliable correlation and never retry an uncorrelated response as a new request.

Native clients use `registerTuiControl`, `sendTuiControl`, `nextTuiControl`, `respondTuiControl` or the additive
`tui.control.*` commands. Targeted `tui.control.request` frames are ephemeral and never enter session/global logs.
HTTP uses the same broker and protocol validation. No new dependency, provider or external service is introduced.

```sh
bun scripts/render-frames.ts .agents-frames/B84 --b84 100x30 180x50
```

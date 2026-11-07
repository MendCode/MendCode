# TUI control REST (B84)

Use the TUI control REST routes to send prompt and UI actions to a terminal that opts into control of its project. The existing [HTTP adapter](remote.md#http-adapter-b34) stays off by default and binds loopback only.

## Opt a terminal into control

1. Start a terminal with `--tui-control` to opt it into control of its project. Without an owner, UI requests return 409.
2. Use a full remote token for every `/tui` route. Read-only tokens and browser Origin requests are denied.

**Warning:** No TUI command is classified read-only: prompts and control requests may contain private content.

## Send a UI action

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

UI actions return `true` when processed, `false` when declined by the terminal: an unknown command, another focused editor or a failed selection. Provider results still arrive through the ordinary session protocol.

Opening pickers preserves the draft. Themes use the shared bordered grid and header hints, with one column below 70 columns. The v1 open-themes misroute to `session.list` is corrected.

## Choose a command ID

Use these command IDs with the command actions:

| ID form | Accepted IDs |
|---|---|
| v1 underscore command aliases | `session_new`, `session_share`, `session_interrupt`, `session_compact`, `messages_page_up/down`, `messages_line_up/down`, `messages_half_page_up/down`, `messages_first/last`, `agent_cycle` |
| Published dotted IDs include | `help.show`, `theme.list`, `model.list`, `session.list/new/share/interrupt/compact/page.up/page.down/line.up/line.down/half.page.up/half.page.down/first/last`, `prompt.clear/submit`, `agent.cycle` |
| Native key-action IDs | Also supported; unknown IDs return false |

Existing provider/sharing configuration and approval rules apply to actions requiring them.

## Ownership and request limits

The daemon delivers requests serially. Its limits are:

| Limit | Value |
|---|---|
| Owners per canonical project | One |
| Owners in total | At most 128 |
| Outstanding requests per project | 32 |
| Wait for each result | At most 15 seconds |
| Polling owner lease | 30-second lease |

A persistent terminal owns by connection, never by a caller-supplied client ID. Polling clients own by authenticated token; use a dedicated token and one polling loop. Only that owner can answer its current request.

### Disconnects, cancellation and responses

There is no global broadcast, durable queue or automatic resend of UI actions after disconnect. Revocation, cancellation, disconnect and daemon stop release waiters.

**Warning:** An action already delivered may finish after its caller cancels; cancellation does not undo it.

Native command IDs keep the existing replay-cache guarantees. Legacy bare responses are ordered; use requestID for reliable correlation and never retry an uncorrelated response as a new request.

## Implementation

Native clients use `registerTuiControl`, `sendTuiControl`, `nextTuiControl`, `respondTuiControl` or the additive `tui.control.*` commands. Targeted `tui.control.request` frames are ephemeral and never enter session/global logs.

HTTP uses the same broker and protocol validation. No new dependency, provider or external service is introduced.

Render the frames with:

```sh
bun scripts/render-frames.ts .agents-frames/B84 --b84 100x30 180x50
```

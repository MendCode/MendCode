# Permission, question, plan review and memory REST (B88)

Use these eight routes to list and answer pending permissions, questions and plan reviews, or ask the memory assistant through the existing [opt-in HTTP adapter](remote.md#http-adapter-b34).

Start with the adapter: its listener is off by default, loopback only and token authenticated.

## Authentication

Every B88 route requires a full token, including lists: pending requests contain user and tool content.

Browser origins follow the adapter's explicit CORS policy. Responses use `Cache-Control: no-store`. No commands were added to `READ_ONLY_COMMANDS`.

## Routes

| Route | Payload → result |
|---|---|
| `GET /permission` | Pending permissions across sessions of the selected workspace |
| `POST /permission/:requestID/reply` | `{reply: "once" | "always" | "reject", message?}` → `true` |
| `GET /question` | Pending question batches, with options and single/multiple/custom selection |
| `POST /question/:requestID/reply` | `{answers: string[][]}` in question order → `true` |
| `POST /question/:requestID/reject` | No body required → `true` |
| `GET /plan-review` | Pending plans, separate from durable review history |
| `POST /plan-review/:requestID/reply` | `{action: "apply" | "edit" | "reject" | "close", markdown?, comments?, reason?, permission?: "full" | "edits" | "ask"}` (`permission` defaults to `ask` here; the terminal defaults to `full`, see [plan review](plan-review.md#access-after-applying)) → `true` |
| `POST /memory/side-chat` | `{root?, message, history?, context?}` → `{text, actions}` |

### Request fields

Requests use the v1 field names: `id`, `sessionID`, `tool.messageID`, `tool.callID`, `permission`, `patterns`, `always`, `metadata`, `questions`, `markdown`.

Identifiers remain native v2 ids; the tool reference is the native tool item id.

### Permission and question replies

Permission metadata carries the real title/detail. Native rule and ordinary tool approvals publish their permission name and targets in an additive `server.request.permissionContext` field.

- Engines without structured targets return empty pattern lists rather than invented grants.
- `always` maps to the native session grant; it is never a global permission change.
- Rejection feedback is passed to the owning actor.

Question answers retain their nested arrays. Counts, duplicates, multiple selection and custom-answer restrictions are enforced before consumption.

## Select a project and handle errors

Use `x-opencode-directory`/`directory` or `x-mendcode-workspace`/`workspace` to select a registered project. A request from another project is absent from that list and cannot be answered there.

| Condition | Result |
|---|---|
| Missing, wrong-kind or already closed ids | 404 |
| Simultaneous replies | first-wins semantics; the loser returns 409 |
| Invalid JSON, decisions or unknown query fields | 400 without consuming the request |
| Oversized list | an error; lists never silently truncate pending requests |

## Review a plan

Plan replies use the [durable native review flow](plan-review.md):

- Edits/comments survive restart.
- Destinations are revalidated.
- Planning-only packets refuse apply.
- Cancellation/restart closes requests without implementation.

Native clients retain `planReviews`/`reviewPlan` and gain `pendingInteractions(directory, kind)`.

## Ask the memory assistant

Memory history entries are `{id, role: "user" | "assistant", text, createdAt}`. Context accepts nullable `selectedWorkspaceID`, `selectedGroupID`, `selectedCategoryID`, `pageContext`.

Workspace ids use v2 project roots. Selection is contextual information, never file or execution authority; an explicit `root` must equal the selected project.

The current project's/profile's memory remains available. Category/group selection focuses it, and page context is passed first.

### Limits and provider failures

- The most recent 12 history entries are bounded/redacted; questions, context and answers are also redacted.
- Completion is tool-free. It uses configured memoryAssistant → memoryExtractor → small → main candidates, deduplicates models and tries the next candidate on provider failure.
- The deadline is 55 seconds, with at most one REST side call per project/profile.
- Request abort or daemon shutdown discards late actions.
- Missing/unavailable providers return explanatory text and `actions: []`.

### History and approvals

The REST memory call is stateless. It returns reviewable actions without applying them, creating pending drafts, saving side history or changing main-session history.

The caller owns its history and approval workflow, as in v1. The existing TUI [Memory assistant](memory.md#memory-assistant) retains its own durable pending-proposal flow.

Native clients can use `memorySideChat(directory, payload)` through the additive `memory.side-chat` command. No real service is required by tests.

## Frames

B88 adds no terminal page or chrome. Render frames of existing screens receiving REST decisions and the existing Memory assistant:

```sh
bun scripts/render-frames.ts .agents-frames/B88 --b88 100x30 180x50
```

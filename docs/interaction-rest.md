# Permission, question, plan review and memory REST (B88)

These eight routes use the existing [opt-in HTTP adapter](remote.md#http-adapter-b34). The listener is off by default,
loopback only and token authenticated. Every B88 route requires a full token, including lists: pending requests contain
user and tool content. Browser origins follow the adapter's explicit CORS policy. Responses use `Cache-Control: no-store`.
No commands were added to `READ_ONLY_COMMANDS`.

| Route | Payload → result |
|---|---|
| `GET /permission` | Pending permissions across sessions of the selected workspace |
| `POST /permission/:requestID/reply` | `{reply: "once" | "always" | "reject", message?}` → `true` |
| `GET /question` | Pending question batches, with options and single/multiple/custom selection |
| `POST /question/:requestID/reply` | `{answers: string[][]}` in question order → `true` |
| `POST /question/:requestID/reject` | No body required → `true` |
| `GET /plan-review` | Pending plans, separate from durable review history |
| `POST /plan-review/:requestID/reply` | `{action: "apply" | "edit" | "reject" | "close", markdown?, comments?, reason?}` → `true` |
| `POST /memory/side-chat` | `{root?, message, history?, context?}` → `{text, actions}` |

Requests use the v1 field names (`id`, `sessionID`, `tool.messageID`, `tool.callID`, `permission`, `patterns`, `always`,
`metadata`, `questions`, `markdown`). Identifiers remain native v2 ids; the tool reference is the native tool item id.
Permission metadata carries the real title/detail; native rule and ordinary tool approvals publish their permission name
and targets in an additive `server.request.permissionContext` field. Engines without structured targets return empty
pattern lists rather than invented grants. `always` maps to the native session grant; it is never a global permission change.
Rejection feedback is passed to the owning actor. Question answers retain their nested arrays; counts, duplicates, multiple
selection and custom-answer restrictions are enforced before consumption.

`x-opencode-directory`/`directory` or `x-mendcode-workspace`/`workspace` select a registered project. A request from another
project is absent from that list and cannot be answered there. Missing, wrong-kind and already closed ids return 404;
simultaneous replies use first-wins semantics (the loser returns 409). Invalid JSON, decisions and unknown query fields
return 400 without consuming the request. Lists never silently truncate pending requests; an oversized list returns an error.

Plan replies use the [durable native review flow](plan-review.md): edits/comments survive restart, destinations are
revalidated, planning-only packets refuse apply, and cancellation/restart closes requests without implementation.
Native clients retain `planReviews`/`reviewPlan` and gain `pendingInteractions(directory, kind)`.

Memory history entries are `{id, role: "user" | "assistant", text, createdAt}`. Context accepts nullable
`selectedWorkspaceID`, `selectedGroupID`, `selectedCategoryID`, `pageContext`. Workspace ids use v2 project roots; selection
is contextual information, never file or execution authority. The current project's/profile's memory remains available;
category/group selection focuses it and page context is passed first. An explicit `root` must equal the selected project.
The most recent 12 history entries are bounded/redacted; questions, context and answers are also redacted. Completion is
tool-free, uses configured memoryAssistant → memoryExtractor → small → main candidates, deduplicates models and tries the
next candidate on provider failure. It has a 55-second deadline and at most one REST side call per project/profile.
Request abort or daemon shutdown discards late actions. Missing/unavailable providers return explanatory text and `actions: []`.

The REST memory call is stateless: it returns reviewable actions without applying them, creating pending drafts, saving side
history or changing main-session history. The caller owns its history and approval workflow, as in v1; the existing TUI
[Memory assistant](memory.md#memory-assistant) retains its own durable pending-proposal flow. Native clients can use
`memorySideChat(directory, payload)` through the additive `memory.side-chat` command. No real service is required by tests.

B88 adds no terminal page or chrome. Frames of existing screens receiving REST decisions and the existing Memory assistant:

```sh
bun scripts/render-frames.ts .agents-frames/B88 --b88 100x30 180x50
```

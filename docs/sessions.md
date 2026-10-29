# Session history: fork at a message, undo and redo, timeline, export

## Lifecycle and fan-out (T6 / T11)

`/tier session_meta on` enables own-thread metadata (balanced); legacy settings leave it off. The primary agent's
`session_meta` tool can rename, regenerate titles, link/unlink a PR and settle its thread. `/title regenerate` uses
the configured title model, a bounded redacted transcript and a 30-second deadline; an intervening rename wins.
`/pr link [number|github.com URL]` reads `gh pr view` in the saved working directory (without a reference, its branch).
`/pr refresh` checks the saved link on demand; `/pr unlink` removes it. No polling. The session widget, list and prompt
chip show the PR; `#N` attaches only that saved PR as untrusted context, without network discovery.

`/pin [on|off]` persists a pin; Ctrl+B toggles a row's pin. Sidebar and picker group Pinned, Active and Settled rows;
Ctrl+O includes settled rows in the picker. `/settle [reason]` archives without deleting history, dismisses a usage
pause and offers `/settle undo`. Manual settlement refuses running/queued work; an agent's request waits for its work
to finish. Undo restores the thread and disables its automatic rules. `/settle rules inactive N`, `/settle rules pr`
and `/settle rules off` configure optional per-thread rules. They run on local listing/foreground idle, skip pinned/busy
threads and use saved PR state; `/settle check` explicitly refreshes it. Defaults never auto-settle.

`/tier fanout on` enables `/fanout "prompt" modelA modelB ...` (full): validate 2–8 models, create separate worktree
leases, inherit the owner's permission mode/session rules/selected agent, and retain branches for review. New worktree
project resources still require their own trust. Provisioning failure starts no providers and releases unused leases.
`/fanout compare` shows statuses/summaries; `/fanout open N` opens a branch; `/fanout changes N` opens its Changes view.
Grouped transcript summaries update without waking a model. No automatic commits, merges or successful-lease removal.
Compare keeps the latest group; earlier children remain in history. Existing provider authentication and lease cleanup
remain explicit user choices.

Both command families and the metadata port are local-only, refused for remote/peer clients. Agent PR/title operations
need execute approval; metadata writes need write approval. Subagents/offline turns do not receive `session_meta`.
Browser tabs: [browser.md](browser.md). Quote with comment: [editor.md](editor.md).
`/handoff <goal>` (balanced/full, local only) creates a focused child from bounded, redacted summary/recent context and puts the goal in its draft. Nothing is submitted until you send it. The source history stays intact; model, agent and permission mode carry over. Wait for the current turn to settle. Portable queued context attaches to the child's first turn without cloning the full native transcript.

The `threads wait` action reads another session's last answer and follows the same consent gate as `read` and `search`.
Peer model turns exclude `threads` and retain that restriction through automatic continuations and restart. Queue
inspection, editing, reordering and steering are local-only; explicit `@thread` snapshots remain local-only.

## Empty chats

A terminal's new chat (start-up without a session, `/new`, `ctrl+x n`, the palette, `tui` control `session.new`) sends
`session.create` with `reuseEmpty: true`. The daemon answers with the project's empty chat when it has one (`reused: true`;
a second terminal gets the same one) and makes one otherwise, so blank sessions never pile up: at most one per project.
Other empty chats of that project that no terminal is attached to are removed at the same time. `--title`, `--model`,
`--agent`, a parent, `run`, ACP, the app server, REST and `session create` never ask for it: they make the session they named,
always new, and it is marked explicit (`session.explicit:<id>` in `meta`) so it is never reused, hidden or removed.

A chat is empty when it is a root session without title, turns, draft, queue entry, goal, attachment, label, child, pin or
archive mark, with no model, effort or options of its own, on the project's default agent, and with no events but
`session.created` and the default permission mode recorded after it. The check asks every table that keeps rows per session, so
anything stored later keeps its chat. People's lists (`/sessions`, the sidebar, the palette, Agent View, `@thread`) send
`session.list` with `hideEmpty: true`, and the daemon sends no `session.activity` for an empty chat, so other terminals hear of it
once something is typed. `session.list` without `hideEmpty` (API, `session list`) shows every session. On start the daemon
removes the empty chats earlier versions left, across all projects, with `deleteSession`: nothing in them is lost.

A draft counts as something only when it holds text beyond spaces and line breaks, or an attachment: `draft.set` with nothing
else removes the draft, and a blank one an earlier version stored is deleted when the store opens, so it never keeps a chat
listed. A chat kept by its draft alone is listed with `draft` on its summary (`session.list`, and `session.activity` when the
draft appears, changes its first line or goes: `preview`, `chars`, `attachments`, `images`, `updatedAt`), and terminals label it
`Draft · …` instead of `Untitled session` ([editor.md](editor.md#unsent-drafts-and-copy-on-select)). `/sessions` leaves such a
chat out (no title and only a draft: it was never worked in; `/drafts` lists it), and `mendcode -c` skips it as it skips empty
chats, so it opens the last session worked in for the project. The field is additive; an
older daemon sends none and its chats read as before. A read-only remote token gets neither, as it cannot call `draft.get`.

## Archive and restore (B64)

`session.archive { sessionId, restore? }` returns `{ session: SessionDetail }`. Archiving sets `archivedAt` (epoch ms);
restoring clears it. Repeated archive requests preserve the timestamp. Events, model history, drafts, secrets, attachments,
engine bindings and children stay intact, including during a running turn. Opening or sending to an archived session by ID
works without restoring it. `session.list` hides archived sessions before filtering/pagination; `archived: true` includes them.
`client.archiveSession(id, restore?)` is typed. The command mutates state and is unavailable to read-only remote clients.

In `/sessions`, Ctrl+A archives/restores the selected row; Ctrl+O includes/hides archived sessions. Typing keeps that scope.
The shared panel grid fills the page, with selection details from 110 columns and one column below 70; hints stay in the header.
Archive changes propagate to other terminals through `session.activity` (`archivedAt: null` clears the marker on restore).
The left sidebar includes archived rows under Settled. Archiving the open session leaves its transcript open.

Retention and archived-session treatment in `storage clean` remain a user decision; the existing explicit age-based cleanup
is unchanged. Archiving is not a storage-clean exemption. Frames: `bun scripts/render-frames.ts .agents-frames/B64 --b64 100x30 180x50`.

## Session tree, bookmarks, recap and changelog (B7)

A fork is a new session, so v2's counterpart of pi's in-place `/tree` is the **fork family**: every ancestor and branch a
session shares a lineage with. This is an adaptation, not a copy: pi navigates one session file that holds all branches,
v2 keeps each branch as its own append-only session and switches between them inside the same terminal.

| Command | Ack | What it does |
|---|---|---|
| `session.tree` `{ sessionId }` | `{ current, nodes: SessionTreeNode[] }` | the family, root first, branches depth first; each node has its fork point (`parentId`, `atItemId`, `atPreview`) and its `labels` |
| `session.label` `{ sessionId, itemId, label? }` | `{ itemId, label? }` | bookmarks a user message; an empty or absent label removes it. Refused with `target_mismatch` for any other item |
| `session.recap` `{ sessionId, refresh? }` | `{ text, at, cached }` | a model-written summary of the session so far |

`session.fork` now records its parent and the message it was cut at (`session_forks`, additive table, `CREATE TABLE IF NOT
EXISTS`), and a branch keeps the bookmarks of the messages it carried over. Forks made before this change have no lineage
and appear as roots. A deleted parent leaves its branches as roots. `session.timeline` entries gain an optional `label`.
Labels (`session_labels`, one line, 80 characters, secrets redacted) and recaps (`session_recaps`) belong to their session
and go with it. The three commands return or change user content, so they are not in `READ_ONLY_COMMANDS`. Typed client
helpers: `sessionTree`, `labelMessage`, `recapSession`.

`session.recap` sends the last part of the transcript (the same bounded plain-text view `/btw` uses) to the model of the
`aside` role (then `small`, then the session's model) and caches the answer until the session grows; `refresh` writes it
again. It needs the native engine (`invalid_command` otherwise) and refuses a session with no conversation yet.

Terminal (`apps/cli`, pages load lazily):

- `/tree` is one tree for the whole family and `/timeline` is the same page opened on the messages. A session is a node;
  under the open one hang its messages (`session.timeline`: number, time, the start of the text, `◆ label`, `undone`
  struck through), and under the message each started from hang the forks (cut at that message, `atItemId`) and the
  sub-agents (under the last message that began before them, since the daemon records no message for a sub-agent), with
  `├─ └─` connectors. Other sessions of the family list only their bookmarked messages. `●` marks the one place the open
  session stands: its newest message that was not undone. Each session row says what it cost, read from `session.stats`
  (`12.1K tok · 3m 12s`; tokens in plus out, active time), a sub-agent adds `agent · model · state`, a fork `+N unmerged`;
  the detail panel (under the list on a narrow screen) adds the model, cache reads, turns, the first line of a sub-agent's
  result and the summary. Sub-agent nodes exist only when the daemon returns children, so a session without them shows
  just its messages and forks; `session.tree` is not needed to list the messages (a token that cannot read the family still
  gets them). Keys: arrows/PageUp/PageDown/`Home` `End` move; `←` folds a branch point (or goes to the parent) and `→`
  unfolds; `enter` jumps to a message (as `/timeline` always did), opens a fork or sub-agent in place, or opens a bookmark
  of another session at its message; typing searches titles, agents, message text and bookmarks (ancestors of a hit stay,
  the first hit is selected) and `esc` clears the search before it goes back; `tab` / `shift+tab` cycle the filter
  (everything, messages only, branches & agents, bookmarked only). Control keys act on the selected node: `^F` forks at
  the message (the same `session.fork` with `atItemId`), `^L` bookmarks it (an empty label removes it; a bookmark of
  another session is labelled in that session), `^Y` copies it through the terminal clipboard (a message in full, read
  with `session.history`; a branch by its title; a bookmark by its start), `^R` writes a branch summary through
  `session.recap`, `^B` merges a fork back into its parent (see Merge-back below) and `^A` opens the message's actions.
  The header lists only the keys that work on the selected row. `/fork pick` is the same page where `enter` forks;
  `/fork merge [id]` merges from the prompt. `/tree` is listed in every tier, minimalist included.
- `/label <text>` bookmarks the latest message that was not undone; `/label` with no text removes that
  bookmark. In `/tree` and `/timeline`, `^L` edits the selected message's label; labels also show there.
- `/recap` shows the summary in a scrollable page; `r` writes it again, `/recap refresh` does the same from the prompt.
- `/changelog` lists the bundled entries (`apps/cli/src/changelog.ts`, newest first, no network). The newest id shown is
  kept in `<data dir>/tui/changelog-seen`, so the next run marks what is new since then. Add an entry at the top of that
  file for each user-visible change set.

An automatic recap on returning to the window is the opt-in `autoRecap` setting (see [return](return.md), which also
covers the resume and idle prompts). Not built: branch summaries written into the model's context when
switching branches (pi does that; here a summary is read-only text for the person).

## Message and part revisions (B87)

Enable `settings.set { patch: { allowMessageEdits: true } }` explicitly; edits are off by default.
`session.message.delete { sessionId, messageId, expectedRevision? }`, `session.part.delete { sessionId, messageId, partId, expectedRevision? }`
and `session.part.update { sessionId, messageId, partId, part, expectedRevision? }` use an item's ID as `messageId`.
The body is `{ id: "body", type: "text", text }`; a file is `{ id: "file:<sha256>", type: "file", attachment: BlobRef }`.
File hash, bytes and MIME are immutable; names can change and parts can be removed. These are v2 native parts,
including tool output, rather than the donor framework's part union. Deletion does not undo files or rerun tools.

`expectedRevision` defaults to 0; the ack returns the next revision. Stale revisions and missing/mismatched targets fail
without changing anything. Typed helpers: `client.updatePart`, `deletePart`, `deleteMessage`. Immutable `message.revised`
snapshots/tombstones update chat, loaded history, timeline, export, old event windows and transcript forks, across restart.
Original events, user authority and usage accounting remain in the audit log. Revision snapshots obey the event limit.

Sessions must be idle with an empty queue. Exact native history matches update atomically with the transcript; later turn
boundaries are adjusted and stale redo stashes cleared. Deleting tool output removes its paired model call. Compacted,
ambiguous/clipped/mention-expanded or shell-composed history, opaque reasoning, external Codex/Claude/ACP bindings and
assistant/tool media without an exact history mapping are refused. These are explicit remaining parity gaps.

## TUI startup (B16)

`mendcode [PROJECT]` (also `thread [PROJECT]`) accepts `--model`, `--agent`, `--session`, `--continue`, and `--fork`. Startup uses the same validated selection and transcript fork as headless `run`. `--prompt TEXT` submits once after transcript loading; `--initial-message TEXT` fills the editor without submitting and overrides the stored draft. These explicit inputs do not open first-run setup over the chat.

`--isolated` starts a private daemon in a temporary data namespace and shuts it down when the TUI exits (including SIGINT/SIGTERM), without changing the shared daemon. This v2 adaptation does not reuse shared sessions/settings; v1's private worker over shared storage remains a parity gap. It cannot be combined with a remote/socket attach. Use `--dir DATA` for normal persistent operation.

`--diagnostics` enables `/diagnostics` (`/diag`) and `/snapshot`, with lazy-loaded bordered memory/resource panels. Keys: `r` refresh, `s` capture both process heaps, arrows/PageUp/PageDown scroll, Escape back. Snapshots stay in each process's data directory under `diagnostics/`, with private directory/file permissions (0700/0600). Heap dumps can contain credentials and conversation data: capture only explicitly and do not share them casually. Remote read-only clients cannot capture either heap; the mutating snapshot command is not in `READ_ONLY_COMMANDS`.

Diagnostics also reports the loaded session list, current transcript message/item counts, route, PID and uptime, alongside each process's memory and the daemon's resources. RSS guardrails match v1: warning at 2 GiB, critical at 4 GiB. The shared panel grid stacks under 70 columns; keys stay in the header.

Daemon-side commands that work on what a session already holds. Everything down to "Terminal UI" is protocol
(`packages/protocol`), the store (`packages/store/src/turns.ts`) and the daemon (`packages/daemon/src/session-history.ts`,
`turn-snapshots.ts`); the last section is what the terminal (`apps/cli`) does with them.

The automation CLI also exposes `session get`, `inspect`, `status`, `rename`, `fork`, `delete` and `export`, directory/child/history filters and per-turn selections; see [automation.md](automation.md). `session.get` and `session.inspect` are additive read-only protocol commands with typed client helpers. CLI forks request `transcript: true`; `beforeItemId` excludes a user message's turn while the existing `atItemId` remains inclusive. User submissions can carry an optional `selection` (model choice and agent), persisted in `queue.added` for restart recovery.

Ported from v1 (`session/revert.ts`, `/undo` `/redo`, fork, timeline, export) with one difference in kind: v1 reverts
through a whole-worktree git snapshot and deletes the reverted messages on the next prompt; v2 keeps the event log
append-only. Its default snapshots cover the agent's edit tools; worktree capture is opt-in (below).

| Command | Ack | What it does |
|---|---|---|
| `session.fork` + `atItemId` | `{ sessionId, copied, events }` | a new session branched from a user message |
| `session.undo` `{ sessionId, force?, atItemId? }` | a `RewindReport` | undo the chosen user message and all later turns, or the last message when omitted |
| `session.redo` `{ sessionId, force? }` | a `RewindReport` | bring the last undone message back |
| `session.timeline` `{ sessionId }` | `{ entries: TimelineEntry[] }` | the user messages to jump to or fork at |
| `session.history` `{ sessionId, before?, after?, limit?, turnId? }` | `{ turns, older?, newer? }` | complete conversation turns, independently of the chat window |
| `session.export` `{ sessionId, format, reasoning?, toolDetails?, assistantMetadata?, timestamps? }` | `{ format, text, turns, truncated }` | the session as Markdown or JSON with optional transcript details |

`session.fork` without `atItemId` is unchanged (history copied, transcript starts empty). Schemas: `commands.ts`
(`SessionFork`, `SessionUndo`, `SessionRedo`, `SessionTimeline`, `SessionExport`), `queries.ts` (`TimelineEntry`,
`RewindReport`, `SessionExportResult`), `events.ts` (`TurnReverted`, `TurnRestored`). The protocol version is unchanged:
new fields are optional. Native `item.completed` events may carry bounded, redacted `toolInput` for transcript exports.

## Active-response queue policy (B51)

`/queue` opens the queue manager (below) with the daemon's current policy in its header; `/queue after-response`, `/queue after-tools` and `/queue immediate` save it for all terminals. `/settings` also cycles the prompt policy. Wire: `settings.set { patch: { queue: { mode } } }`; `queue: null` clears it. The typed client helper is `queueMode(mode?)`. Unset, the policy is `after-tools` wherever the engine takes a message mid-turn (MendCode's own engine, Claude Code, pi), as Claude Code does, and `after-response` for Codex and ACP agents, which cannot; the queue card names the one in force. Per message, `ctrl+s` sends now and `ctrl+shift+enter` sends the other way (waits for the response under `after-tools`).

- `after-response` waits for the full response and any automatic compaction, then starts queued prompts in order.
- `after-tools` joins ordinary prompts in the native engine after **every** tool result in the iteration is persisted, before the next model call. Their messages, attachments, file mentions and original authority enter the same turn exactly once. Explicit model/agent selections, shell commands and compaction keep their own turn boundary. A prompt that arrives while a response without tool calls streams joins the same way once that answer is persisted: one more model call in the same turn, unless the turn's model-step budget is spent (then it waits for its own turn). Only a message of the user's joins there: a notice about the session's background work then gets its own turn once the answer ended, and a turn started on its own (send now, restart) or under an explicit model/agent selection takes nothing after its answer. External Codex and ACP engines do not expose this injection boundary; they keep queued prompts until the response completes. Claude Code and pi do, as their own CLIs take a message typed mid-turn: Claude Code gets the message at the turn's next tool result and reads it after the step at hand (or answers it right after, inside the same MendCode turn); pi gets it as `steer` at its turn boundary ([pi-engine.md](pi-engine.md)). A saved policy wins.
- `immediate` interrupts the active response and sends the next queued prompt after the engine stops (or its existing cancellation grace expires). Late output from the old turn is ignored.

Whatever the policy and engine, ordinary messages waiting together when the session starts its next turn start in **one** turn: each keeps its own user message in the transcript, and the engine receives their texts in order, separated by a blank line, with all their attachments and authority. A run stops at the first entry that keeps its own boundary: a shell command, a system notice, a compaction, a different model/agent selection or turn options. A message sent now on its own (`queue.promote`, `delivery: "restart"`, steering an idle session) and a compaction's follow-up start alone; the messages behind them join the turn after. `turn.started` carries the first `queueId` and the others in `joinedQueueIds` (at most 63); `session send --wait`, REST waits, app-server `turn/start`, ACP, channels, loops and workflows match either.

### Managing the queue (any terminal)

The daemon owns the queue, so every change shows in every terminal on the session and survives a restart (held, as above).

| Command | Effect |
|---|---|
| `user.submit { delivery?, clientRequestId? }` | `delivery`: `queue` waits for the response, `steer` joins the running turn after its next tool result (or after a tool-free answer, with one more model call), `restart` interrupts and goes next; unset follows the policy. `steer` needs the native engine: elsewhere it queues (`steered: false` in the ack). The same `clientRequestId` on the same session returns the first answer instead of queueing twice (kept in memory, lost on daemon restart) |
| `queue.reorder { queueId, to }` | `up`, `down`, `top`, `bottom` or a position; ack `{ position }` |
| `queue.edit { queueId, text }` | replaces the text in place (secrets masked); persisted as `queue.edited`. Refused for compactions, notices and entries a command or mention expanded (they carry display text) |
| `queue.steer { queueId }` | promotes one queued message into the running turn; idle, it sends that message now; ack `{ steered }` |
| `queue.list { sessionId }` | `{ held, paused, entries: [{ queueId, kind, text, attachments, editable, delivery? }] }` |

None is read-only: read-only remote clients and peers are refused. `queue.changed` entries gain `kind` and `delivery`. Steered messages go ahead of plain queued ones, in the order they were steered; a policy of `after-tools` still injects only the first plain entry, and a message marked `queue` always waits.

TUI: bare `/queue` opens the manager (`↑↓` select, `K`/`J` move, `e` edit in place, `s` steer, `p` send now, `x` twice drops, `esc` back) and follows changes made in another terminal. `ctrl+shift+enter` (`queue.flip`, rebindable) sends the prompt once the other way: a steer under `after-response`, a plain queue entry under `after-tools` or `immediate`. `ctrl+enter` stays a newline. Headless: `session send --mode auto|queue|steer|restart --request-id ID` (`auto` is steer when running, send when idle; `auto` and `steer` return at once, so they cannot `--wait`; not with `--command`).

The queue uses the shared bordered panel grid, previews with QUEUED/STEERING/SEND chips, and header key hints. Ctrl+S or the first SEND chip sends now; Ctrl+K on an empty prompt drops the newest queued entry. User cancellation stops and holds remaining entries. A cancel ends the turn at once on every engine (`turn.cancelled`, then idle) while the engine stops behind it: Claude Code can take a few seconds to finish its step, and a message sent meanwhile shows as queued and starts once the engine has stopped (or its grace ran out); late output is dropped. Restart also restores the queue held: no prompt runs until an explicit send or new submission. Settings changes are pushed live; changing the policy alone never releases a held queue. No queue control is allowed to read-only remote clients.

## Events: `turn.reverted` and `turn.restored`

`{ turnId, byClientId? }`, one per turn. The log is append-only: an undone turn keeps all its events, and readers hide
it. A turn is hidden when its last marker is `turn.reverted`. `visibleEvents(events)` and `revertedTurnIds(events)`
(`packages/protocol/src/turns.ts`) do this for any list of events: they drop the turn's own events, its items, deltas,
requests and usage, and the markers. A client that replays the log should apply it (or hide items whose `turnId` is
reverted as the markers arrive). The daemon applies it to Dream's session digests and to `/btw` transcripts; usage
counters keep the tokens an undone turn spent, because they were spent.

## Paging the event log: `session.events`

`client.subscribe { afterSeq }` replays everything after a seq, so a long session costs its whole log to open. A client
that wants the newest events first asks for a window instead:

`session.events { sessionId, before?, after?, limit?, includeReverted? }` (read-only) answers an `EventsWindow`
`{ events, firstSeq, lastSeq, more, sessionLastSeq }`, events in ascending seq:

| Query | Window |
|---|---|
| neither `before` nor `after` | the newest `limit` events |
| `before: seq` | the `limit` events just older than `seq` (a window's `firstSeq`) |
| `after: seq` | the first `limit` events newer than `seq` |

`limit` defaults to 200 (`EVENTS_PAGE_DEFAULT`) and is at most 1 000 (`EVENTS_PAGE_MAX`); `before` and `after` exclude each
other. `more` says whether the log goes on past the window in the direction asked (older for the newest window and
`before`, newer for `after`). A window is also cut to what one ack frame holds (`MAX_FRAME_BYTES`): the end nearest the
cursor is kept (the newest events, or the oldest for `after`) and `more` is true, so a page of very large events is
smaller than `limit`, never an error.

**Undone turns.** Like `visibleEvents`, a window leaves out the events of undone turns and the `turn.reverted` /
`turn.restored` markers, unless `includeReverted`. It cannot use the markers, which may lie outside the window, so the
daemon hides by position: a turn's events are the ones between its `turn.started` and the next turn's, and an event is
hidden when that turn is reverted now (redo shows it again). `firstSeq` and `lastSeq` are the raw bounds, hidden events
included, so `before: firstSeq` continues exactly where the window ended, and a page may come back with fewer events than
it covered, or none. Paging back to the start and concatenating gives `visibleEvents` of the whole log.

**Client** (`@mendcode/client`): `loadWindow(sessionId, limit?)`, `loadBefore(sessionId, seq, limit?)` and
`loadAfter(sessionId, seq, limit?)` return `{ ok: true, window } | { ok: false, error }`. To open a long session:
`loadWindow`, render it, then `subscribe(sessionId, window.lastSeq)` (subscribing from a seq already existed: the daemon
replays only what came after it, then streams live) and `loadBefore(sessionId, window.firstSeq)` when the user scrolls up.
The daemon's event log and `client.subscribe` are unchanged, so a client that never pages works as before.

The terminal uses these helpers on startup and session switches. Scrolling past loaded history requests one earlier
page and keeps the viewport anchored. At the scrolled top, `loading earlier…` reports a pending page; `start of session`
requires an earlier page loaded and exhausted history, and never appears on home or short sessions (see `docs/layout.md`).
Timeline jumps fetch earlier windows until the chosen message is loaded.

## Complete history

`/history` or `ctrl+x shift+g` opens a bordered history grid. `/timeline` remains the
message jump/fork list. `/` opens Quick Jump, Enter reads a turn, Escape returns to the list or chat, `l` returns to
live bottom, `v` cycles timeline/tree/pages, `s` toggles preview, and `t` cycles hidden/count/tree tools. PageUp/PageDown
load older/newer pages; arrows select or scroll. Space/Left collapse tree rows; Right expands. Selection, view and
preview are remembered per session. Below 70 columns the grid has one column; key hints sit in the page header.

Quick Jump searches prompt, response and tool/subagent output backward through at most 200 pages, selects the first
match, and keeps the query for filtering. The daemon returns at most 50 turns per request (20 by default), omits undone
turns and private reasoning, redacts secrets, and marks cut output. Message text is bounded to 40,000 characters,
tool text to 6,000; a turn has at most 200 items/20,000 events and each reply fits a wire frame. Blob-backed output
keeps its stored preview and a cut marker. `client.history(sessionId, query?)` returns `{ ok: true, history }`.

Chat supports `ctrl+alt+y/e` for one-line scrolling and `ctrl+alt+u/d` for half pages (legacy ESC-control and Kitty
sequences). `message.next`, `message.previous`, `message.last-user` are configurable actions with no default keys;
navigation fetches missing earlier windows. `ctrl+x h` toggles Markdown source concealment. `/rename [title]` opens
this session's rename editor or applies the given title.

## Several tool calls in one model response

The native engine runs the tool calls of one response one at a time, in the order the model emitted them, and every call
id gets exactly one result before the next model request.

When a call that changes files (`write`, `edit`, `apply_patch`, `notebook_edit`) fails, the calls after it in the same
response are not run: the model wrote them for files as that edit would have left them (typically the command that
checks it). Each of them gets an error result, `skipped: the earlier <tool> call of this response failed, so this call
did not run. Fix that edit first, then send this call again.`, and shows as an error card. Failed means any error
result: the tool's own failure, invalid arguments, a refusal by a permission rule, plan mode or the reviewer. Results of
calls before the failed one stay as they are. The skip lasts for that response only.

Unchanged: a failed read or command does not skip anything; a write the user denies or abandons ends the turn and the
remaining calls are recorded as `cancelled` (with `continue_loop_on_deny` the turn goes on and the denial counts as a
failed write); cancelling a turn mid-response records the calls not yet run as `cancelled`.

## Turns, marks and the model history

The store keeps one row per turn (`turns`), updated by every event append: the turn's first event number, the user
message item (`itemId`), its first 120 characters (`preview`, whitespace collapsed), its outcome, whether it was undone,
and flags (`shell`: the user's own `!command`; `notice`: a system notice; `compacted`; `shellTool`: a shell tool ran).
The table is built once from the log when an older database opens.

The model's history (`engine_messages`) has no turn ids, so each turn also records, when it starts, how many messages
every engine held (`history`: a map engine to count; an engine missing from the map held none). That count is where an
undo or a fork cuts the history. A compaction rewrites the history, so it sets the count of that engine to `null` in every
older turn (`historyMark()` reads it: `undefined` means unknown). Consequences:

- a message followed, in the same or a later turn, by a compaction cannot be undone, and a fork at a message whose next
  turn started before a compaction is refused (`target_mismatch`, "fork from a later message");
- messages after the latest compaction work normally;
- a session recorded before marks existed has none: when it was never compacted, one engine keeps its messages and the
  number of user prompts in that history equals the number of turns that have a user message, the marks are worked out
  from that (a tool's `[image from … call]` note is not a prompt); any other case is refused, never guessed.

A fork does not copy this history: it points at its parent's rows up to the cut (`engine_prefix`) and the store resolves
the chain on every read, so undo marks, counts and redo of a fork behave as if it owned the rows; see
[storage.md](storage.md#forks-share-their-history) for what happens when either side rewrites or is deleted.

Engines that keep their history elsewhere (Claude Code, Codex) have no `engine_messages`: undo and fork still work on
the transcript and files. Claude Code's conversation is cut too: each turn's message carries a uuid derived from its turn id,
and an undo of a message asks Claude Code to `rewind_conversation` before it (right away, or before the next message when no
Claude Code process runs), so the report says `history.tracked: true`. Codex still remembers the turn (`history.tracked: false`).
A redo brings back the transcript and files but not Claude Code's cut conversation.
A fork of such a session cannot fork the engine's own conversation, so its first turn on Claude Code or an ACP agent
starts with the copied conversation as text, through the portable handoff below (this replaces the former 60,000-character
dump marked by `session.fork.seed`).

### Portable handoff between engines

A session can move between the daemon's own engine, Claude Code, pi and ACP agents (`/model`, `session.model.set`, a per-turn
`--model`), and a fork can start on another engine than its source. Each engine keeps its own history, so the daemon
records per session and engine the last turn that engine took part in (`session_engine_seen`) and, on the next turn on an
engine, puts the turns it did not see in front of the user's message as one quoted block (`[Handoff: ... continues on
Claude Code ...]` ... `[End of handoff]`). Moving back only brings what the other engines added. The selection is
budgeted, never summarised by a model, and never touches the new message or its authority text:

- the **newest turns whole**, as many as fit; each message is cut at 3,000 characters (`[cut]`), a turn bigger than the
  whole budget is cut rather than dropped;
- the **original request** (up to 2,000 characters) when it fell outside the budget and the engine has seen nothing yet;
- **command outcomes** (`$ command -> ok|error: last 300 characters`, 8 per turn), the **files edited** and the user's own
  `!commands`, as short lines; reads, searches and reasoning are not carried;
- a note counting the **omitted turns**, with the session id: an agent with `session_read` can page through them (an
  external engine cannot, the transcript stays in MendCode).

The budget is the `handoffTokenCap` setting (`settings.set`, 4 characters per token, default 16,000; `0` turns the
automatic handoff off for engine switches and forks, and the daemon still records the engines). The text is the already
redacted transcript, so secrets stay markers, and the closing marker cannot be forged from inside it. `session.model.set`
answers with `handoff: { from, to, turns, omitted, tokens }` when the switch will hand something over (the TUI shows it
as a notice; remote and peer clients are not told). A turn that fails does not count as seen: the next attempt hands the
same context again. The other engine's context is not the new one's: until the new model answers, the footer, dock and
`/status` show no context for it. Forks inherit the daemon engine's record (their model history is shared with the parent) and start
with no external engine, so a fork onto Claude Code or an ACP agent gets the copied turns once. `session_engine_seen`,
`session_fork_base` and `session_pending_context` are additive tables that go with their session; sessions from before
the record are read as having run on the engines they are bound to (or the daemon's own). Codex and the faux engine,
which fix their engine per daemon, hand nothing over. A plain `/fork` (no message) copies only the daemon's model history
and has no transcript turns to hand to another engine; fork at a message (`/fork pick`, `/fork <n>`) for that.

#### Into the daemon's own engine: a rebuilt history

The native engine keeps a provider-neutral history (user and assistant messages, tool calls and results) that any of its
providers replays, so moving between its models (ChatGPT, Zen, Anthropic, ...) carries everything and hands nothing. Moving
into it from Claude Code, Codex, pi or an ACP agent does not get the text block above: the turns it did not run become its
own messages, appended to its history when `/model` switches (outside a turn, so the next turn's undo mark includes them),
else at the next turn or `/compact`:

- each turn in order: the user's message, then one assistant message with the answer and every tool call as a record
  `[ran Bash {"command":"bun test"} → ok]` with its output (inputs cut at 2,000 characters, outputs at 6,000, keeping the
  start and the end). They are records in the text, never tool calls: the native model cannot call another engine's tools.
  Reasoning stays out (another model's, unsigned);
- the newest turns whole within **half of where the native engine packs that model** (`compactAtTokens`, the model's
  `modelContext`), the newest one always; the original request and a count of the turns left out (readable with
  `session_read`) head them in a `[Handoff: ...]` block on the first message.

The switch's reply says `handoff: { ..., rebuilt: true }` and the TUI: `gpt-6-astra now has the conversation from Claude
Code · 12 turns, ~96,000 tokens · 40 older stay in this session · /compact packs it`. From then on it is that engine's
history: `/compact` writes a model summary of it and the automatic compaction applies. `handoffTokenCap` `0` turns this
off too. Nothing is written into Claude Code's or Codex's own files; moving into them still uses the text handoff.

### Merge-back

`session.merge { sessionId, intoSessionId? }` (`/fork merge [id]`, `^B` in `/tree`, `threads` action `merge_back`) takes the
fork's own turns, from its branch point (`session_fork_base`) or its last merge, selects them with the same budget (the
cap, or the default when it is 0) and queues them as context for the **next turn** of the session it was forked from (or
another session of the family): a block `[Merged back from the fork "title" ...]`. No model call is made and nothing is
sent until the user's next message; at most 4 merged contexts wait per session (the oldest go first). Merging again only
brings the turns added since. Refused: not a fork (`target_mismatch`), nothing new (`invalid_command`), a turn still
running in the fork (`busy`), and any remote or peer client (`forbidden`: it reads a local transcript). The `threads`
tool's `merge_back` is for a fork of the calling session only and always asks for approval.

### Lineage tree

`session.tree` now returns the sub-agents too: every node has `kind` (`fork` or `task`), `model` (the model the session
runs on), `state` (task: `queued`, `running`, `needs_input`, `completed`, `failed`, `cancelled`, `interrupted`; fork:
`running` or `idle`), and a task adds `agent`, `description` and `headline` (the first line of its result, left out for
remote and peer clients); a fork adds `unmerged` (its turns not merged back, counted for the first 50). Tasks hang under
the session that started them (4 levels, 400 nodes); asked from a sub-agent, the tree starts at its parent. `/tree` draws
`◇` sub-agents with `agent · model · state`, `+N unmerged` on forks, a running count in the header, and the model, state
and result in the detail panel; `enter` opens any of them and `^B` merges a fork back. The right-bar `agents` card is the
same lineage below the open session (state glyph, agent · model · state, result line of a finished sub-agent, `+N more`),
asked again on `task.changed`; before the first answer it keeps the former list of `task:` tool cards. Claude Code Task
sidechains and Codex nested threads are not projected as nodes yet (plan T8).

## Fork at a message

`session.fork { sessionId, atItemId }`: `atItemId` is the `itemId` of a timeline entry. The new session (title `fork: …`,
or `side: …` with `readOnly`) gets:

- the transcript events of every turn up to and including that message's turn (`turn.*`, `item.*`, `server.request*`),
  renumbered `2…n` after its own `session.created`, with `sessionId` and `seq` rewritten. Queue, usage, permission and
  foreground events stay behind, as do undone turns;
- the model history cut to where the next turn began (everything when it is the last turn), per engine;
- the source's secrets (same `‹secret:N›` numbers) and its blob references (a superset of what the copied events use,
  so images survive the source's deletion);
- the same `turns` rows, so the fork's messages can be undone like the source's. File snapshots are not copied: undoing a
  copied turn in the fork reverts transcript and history only.

Refused with `target_mismatch` (nothing is created): the item is not a user message of the session, its turn is undone, or
its history no longer exists (see above); with `busy` when its turn is still running. `events` in the ack is how many
transcript events were copied.

## Undo and redo

Settings `snapshot: false` disables file capture and restoration while conversation undo/redo remains available.
`snapshotScope: "worktree"` opts into v1-style Git worktree capture: tracked and untracked, non-ignored files before
and after each turn, including shell/external-engine file edits and binary files. The default remains `"tools"`
pending the rollback-scope decision. Non-Git directories fall back to tool snapshots. Worktree capture never writes
Git's index, commits or branches, and cannot undo services or shell effects outside that filesystem.

Worktree limits: 2 MiB per file, 64 MiB per side, 10,000 paths and the newest 20 turns' file bytes. Unreadable files,
symlinks and oversized files are skipped. Persisted per-message summaries survive byte retention; an older session
summary may be partial. Concurrent edits between the two captures are included, so opt-in requires that scope.

`session.undo` targets the live user message named by `atItemId`, or the last turn that has a user message when omitted,
plus every turn after it (a system notice the agent answered, for example): the history is one tail, so they go together.
Repeated undo walks back one message at a time. The turn may have ended any way (completed, failed, cancelled,
interrupted).

The terminal stops an active turn first, as v1 does (`cancelRunning: true`); ordinary protocol calls still refuse while
busy. Cancellation waits for the actor to finish before reading its snapshots/history. Redo preserves the draft while
more groups remain (`canRedo: true`) and clears it on the last restore.

What it does, in order, only when everything checks out:

1. refuses with `busy` while a turn runs or is finishing, `target_mismatch` when there is nothing to undo, the context was
   compacted since, or the history cannot be rewound (a mark is missing);
2. works out the file steps (below); a conflict refuses the undo unless `force`;
3. applies the files, then in one store transaction takes the model messages from the cut on out of `engine_messages` into
   a stash and appends a `turn.reverted` per turn. If the store step fails the files are put back.

`session.redo` pops the last undo: it puts the stashed messages back at the same positions, re-applies the files and
appends `turn.restored` per turn. It only works while nothing new happened since the undo: the stack and the stash are
emptied when any turn starts (a new message, a compaction). After that the undone turns stay undone.

The `RewindReport` ack: `turnIds`, `itemId` (the message), `files { restored, removed, skipped }` (paths relative to the
session directory when inside it), `history { messages, tracked }`, `shellUntracked` and human-readable `notes`.
Additive fields: `worktreeTracked`, restored `prompt`, `canRedo` and per-file `changes { path, additions, deletions }`.

### Part-level revert

`session.undo { atPartId }` reverts from one part (item) of a turn on, like v1's `revert {messageID, partID}`:

- A part with no earlier assistant text or tool call in its turn (or the user message itself) means the whole message: it is `atItemId` of that turn's user message.
- Otherwise the files that write/edit/apply_patch calls from that part to the end of the turn changed go back to the state before the first of those calls. The transcript and the model's history are **not** cut (`partial: true`, `partId` in the report): the model still remembers those calls, so the next turn should re-read the files. Messages after the turn are undone first, as in v1, and put back if the file step fails.
- Each edit call's before-state is kept per call (`turn_call_files`, up to 2 MiB per turn like the turn snapshot, pruned with the turn's file snapshots, on in both snapshot scopes). Shell calls have no per-call snapshot: a shell part reverts nothing by itself (`shellUntracked`); with `snapshotScope: "worktree"` the whole-message undo still restores worktree files.
- It is an entry on the undo stack: `session.redo` re-applies the files, a new turn clears it (the files stay reverted), and an `undo` while one is waiting redoes it first. Conflicts (a file changed since the turn) refuse unless `force`.

`session.redo { all: true }` restores every waiting group newest undo first and answers one merged report (it stops at the first refusal and says how many groups were restored). REST `unrevert` uses it.

### File snapshots

Before the first change a write/edit/apply_patch call makes to a file in a turn (after approval and the extensions'
`tool.before` hooks, through the engine hook, so any native-engine turn is covered), the daemon keeps the file's state:
its bytes, or `absent` when the turn creates it, plus its mode. When the turn ends it records the file's state again
(the "after"), which lets undo tell the turn's own change from a later one and lets redo re-apply it.

Limits (`TURN_SNAPSHOT_MAX_BYTES`, `SNAPSHOT_TURNS_KEPT`):

- at most 2 MiB of file content per turn, all files together (the "after" states have a budget of their own);
- a binary file (a NUL in its first 8 KiB), a file over what is left of the budget, a directory or an unreadable file is
  not stored: it is listed in `files.skipped` with its reason (`binary`, `too_large`, `unreadable`) and left as it is;
- up to 50 files per apply_patch call; only the newest 20 turns of a session keep snapshots (older ones still undo in
  the transcript and history, without files); the snapshots of undone turns are dropped when something new happens;
- a recreated file gets its old mode, parent folders are recreated, empty folders a turn made are not removed.

**In the default tool scope, not tracked:** anything a shell command (`shell`, `!command`) changed, background tasks, MCP and custom tools,
extension tools, and files the engine changed outside the three edit tools. The report says `shellUntracked: true`
(with a note) when the turn ran a shell tool or was a `!command`; other untracked writers are not detected.

**Conflicts:** a file whose current content is not what the turn left (someone, or a later command, changed it) is a
conflict. `session.undo`/`redo` then refuse with `target_mismatch` naming up to five files, and change nothing; send
`force: true` to overwrite them. A file already equal to the state it would get is left alone. When several undone turns
touched the same path it ends in the state before the oldest, and is checked against the state the newest left.

## Timeline

`session.timeline` lists, oldest first, `{ turnId, itemId, at, preview, reverted }` for every turn that has a user
message, except system notices and compaction turns. `preview` is the first 120 characters on one line; `at` is when the
turn started; `reverted` marks undone messages (they still appear, so a client can show them dimmed or offer redo).
`itemId` is what `session.fork` takes.

## Export

`session.export { format: "markdown" | "json" }` walks the log in pages and keeps only what a reader needs:

- undone turns are left out; protocol clients include reasoning only with `reasoning: true`; the headless JSON exporter requests every retained part by default;
- `toolDetails: true` includes input and output; false keeps tool names/status only. Omitting it preserves older clients' output-only exports. Native calls record redacted input (up to 4,000 characters); older events without it cannot recover it;
- `assistantMetadata: true` adds model, provider, tokens and duration once per turn; `timestamps: true` adds item timestamps. Both default to false;
- `sanitize: true` replaces all transcript content, title, directory, tool input/output and metadata with structural redaction markers; declarative render bodies are omitted. Every text goes through the secret redactor again; pasted secrets are `‹secret:N›` markers already and stay markers;
- attachments are listed by name (`Attachments: a.txt, shot.png`; in JSON `{ name, mime, bytes }`), never inlined;
- message text is cut at 40 000 characters, tool output at 120 lines and 6 000 characters (`… N more lines`), other items
  at 4 000 for Markdown. JSON keeps retained parts up to 65,520 characters each, including bounded local text blobs, input, authority, metadata and declarative renders; a cut item and the whole export are flagged `truncated`;
- the whole export stops at `EXPORT_MAX_CHARS` (120 000) of item text and is then cut to what one ack frame allows
  (`MAX_FRAME_BYTES`, counted after JSON escaping): Markdown ends with `> Export truncated…`, JSON drops trailing turns.
  The ack's `truncated` says so.

Markdown (`# title`, the directory, then `## User`, `**Tool:** \`title\`` with a fenced output, `## Assistant`, notes for
failed, cancelled or interrupted turns; a `!command` is `## User (shell)`, a notice `## System notice`). JSON:

```json
{ "format": "mendcode-session@1", "sessionId": "…", "title": "…", "directory": "…", "exportedAt": 0, "truncated": false,
  "turns": [{ "turnId": "…", "at": 0, "outcome": "completed", "error": { "code": "…", "message": "…" },
    "items": [{ "itemId": "…", "kind": "user_message", "text": "…", "status": "ok", "tool": "…", "source": "shell",
      "attachments": [{ "name": "…", "mime": "…", "bytes": 0 }], "truncated": true }] }] }
```

`error`, `tool`, `source`, `attachments` and `truncated` appear only when they apply. The CLI's `mendcode export`
now calls this command instead of returning raw NDJSON events.

**HTML.** `session.export { format: "html" }` returns one self-contained page: inline CSS only, no script, no network (its CSP is `default-src 'none'`), light/dark from the viewer's setting, all text escaped, fenced code as `<pre>`. Tool input/output and thinking sit behind CSS-only checkboxes ("Tool details", "Thinking" chips in the header) that are off until clicked; printing shows everything. `toolDetails` defaults to true for HTML (the page hides it anyway); `reasoning`, metadata, timestamps and `sanitize` behave as for Markdown. The same frame limit applies: trailing turns are dropped and the ack says `truncated`.

## Left out of v1's behaviour

- Reverting/forking inside a turn: v2's history and file snapshots are atomic per turn. An assistant selection uses that turn's user prompt as its anchor.
- Shell effects outside the worktree and external-engine history: neither is rewound. Worktree filesystem capture is opt-in pending the rollback-scope decision.
- Deleting undone messages on the next prompt: v2 keeps them in the log (hidden) and only drops their file snapshots.
- Exact session net diffs once an older turn's snapshot bytes have expired: archived summaries remain, but totals are marked partial.
- Rewinding an external engine's own conversation (Claude Code, Codex): reported, not done.

## Terminal UI

| Command | Key | What the terminal does |
|---|---|---|
| `/undo` | `ctrl+x u` (`z` alias) | `session.undo`; restore the submitted draft, show files and history |
| `/redo` | `ctrl+x r` | `session.redo`; same card, worded for re-applying |
| `/timeline` | `ctrl+x g` | the tree opened on the open session's messages: `enter` jumps, `^F` forks, `^A` opens message actions |
| `/fork` | | copies the session as before; `/fork pick` opens the tree on the messages where `enter` forks; `/fork <n>` forks at the nth message of `/timeline` |
| `/export` | `ctrl+x x` | export options: filename, format, thinking, tool details, metadata, timestamps, destination and editor |
| `/export [markdown\|json\|html] [path] [--copy] [--force]` | | direct export; also accepts `--editor`, `--no-save`, `--reasoning`, `--no-reasoning`, `--tools`, `--no-tools`, `--metadata`, `--timestamps` |
| `/messages` | | message picker and Copy / Revert / Fork actions; also available by clicking a chat message |
| `/copy [pick\|n\|transcript]` | | session transcript by default; `pick` selects a response; `n` retains the answer shortcut |

The keys are leader chords (`ctrl+x`, then the letter) and are bindable in `keybindings.json` under `message.undo`,
`message.redo`, `session.timeline` and `session.export`. v1 has `<leader>r`, `<leader>g` and `<leader>x` for redo, timeline
and export and `<leader>u` for undo. Usage moves to `ctrl+x U`; `ctrl+x z` remains an undo alias.

**The card.** `/undo` and `/redo` show a full-width bordered panel with key hints in its header: `restored` (or `re-applied`)
and `removed` files, skipped paths and reasons, the captured shell scope, model messages taken out (`history`), external
history limits and the report's notes. Undo restores the submitted prompt and attachments; redo clears the draft when
the last group is restored. It stays until `esc` or until a turn starts. When the daemon refuses because files changed after the turn (the
`target_mismatch` that says `send force`), the card names the files and asks: `y` on an empty prompt repeats the command
with `force: true`, `esc` cancels. Any other refusal (`busy`, nothing to undo) is a toast.

**Undone turns.** The log keeps an undone turn, so the transcript hides it: `turn.reverted` removes the turn's blocks, and
one thin `── undone · N messages ──` row stands where a run of undone turns was (a turn sent after an undo appears below
it). `turn.restored` brings the blocks back. Usage counters keep what the turn spent, as the daemon does.

**Timeline.** `/timeline` opens `/tree` on its messages filter (`tab` shows the rest). One row per user message: number, time, the first 120 characters, `undone` (struck through) for reverted
ones, which can be neither jumped to nor forked at. The selection starts on the newest message that was not undone. A jump
puts the message on the first row of the transcript, laying out older blocks first when it is above the window (see
`docs/layout.md`). A fork switches this terminal to the new session (`session.fork` with `atItemId`).

**Export.** The text of `session.export` goes to `<title-slug>.md` (`.json` for JSON) in the session's directory, or to
the path given. Nothing leaves that directory (a symlink out of it is refused too); an existing file is never overwritten
unless `--force` (the default name takes the next free `-2`, `-3`, …). `--copy` sends the text to the clipboard through
OSC 52 instead, which has a limit of about 55 KB of text; a longer export is refused with a hint to write a file.

`/export` without arguments and `ctrl+x x` open the bordered options grid. Tab/Shift+Tab or arrows select, Space/Left/Right toggle, Enter exports and Escape cancels. Thinking, tools, metadata and timestamps initially follow the display settings. The filename edits inline. File export can open `$VISUAL` / `$EDITOR` first and save its edited text; editor-only uses a private temporary file without a project file. `--no-save` selects editor-only directly. The terminal is suspended and restored using the same lazy editor launcher as the prompt. A failed editor leaves options open and writes no project file. Remote clients use the terminal clipboard.

**Left out.** The message menu restores prompt text and image references; older daemon replies without `attachmentRefs` restore text only. Command-only `/undo` puts no text back into the prompt (the report carries none). `/fork pick` and the timeline list every
user message; there is no search in the list. The undo card shows paths, not diffs (the daemon's report has none).

History conversation rows use the first plain-text Markdown line. Preview and the full reader use the chat renderer for headings, bold, lists and fenced code; stored source stays unchanged.

## Session transfer (B36)

`mendcode export [sessionID]` emits a native `mendcode-session@1` JSON document. Without an ID, an interactive terminal opens a bordered, searchable session selector, newest activity first (type to filter, ↑↓ select, Enter export, Escape cancel). Headless use requires an ID. `--format markdown` selects Markdown and `--format html` the self-contained HTML page. JSON includes thinking, tools, metadata and timestamps by default; `--no-reasoning`, `--no-tools`, `--no-metadata` and `--no-timestamps` opt out. `--sanitize` redacts arbitrary content, not just known credentials. `/export` also accepts `--sanitize` and offers **Sanitize content** in its options page. `session export <id> --json` keeps the automation envelope, with `{ format, text, turns, truncated }` in `data`; `session events` remains the raw-event interface.

`mendcode import <file.json|URL>` sends `session.import { source, directory }` to the daemon. Typed clients use `importSession(source, directory)`. Native JSON is validated before import: 256 KiB source, 1,000 turns, 200 items per turn, 2,000 total items; unique IDs, finite dates, known part kinds and bounded fields. Files must be regular files and final-component symlinks are refused. HTTP(S) reads are anonymous, reject credentials and redirects, stop after 20 seconds and enforce the size bound while streaming. CLI import is local-only and `session.import` is never a read-only remote command.

Import creates a new session under the current project, atomically with fresh session/turn/item IDs and original event timestamps. Existing sessions and configuration remain untouched. Running turns become interrupted. Provenance retains source ID, sanitization and truncation flags. The native engine resumes with the imported user/assistant text and tool results as historical assistant notes; it never executes imported tool calls. Attachment descriptions survive round-trip, but attachment files are not transferred or resolved from source paths. The result reports their omitted-file count and the model receives an explicit unavailable-files note. Provider quota/cost counters are not incremented from imported historical metadata. Imported history has no recoverable file snapshots.

`/import setup` brings in those tools' MCP servers, Codex prompts and global instructions (preview first, never secrets): see [setup](setup.md).

**Claude Code and Codex transcripts (B8).** `mendcode import <file.jsonl> [--from claude-code|codex]` and `/import [claude-code|codex] [file]` read those tools' JSONL logs (`~/.claude/projects/<project>/<session>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; both older and current Codex rows). Without `--from` the content is sniffed. With no file, `import --latest [--from …]` / `/import` take the newest transcript of the current project from the tool's default location (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` respected; Codex rollouts are matched by the `cwd` of their first row). The daemon only translates them to a `mendcode-session@1` value and runs the native import above, so redaction, bounds and "tool calls are history, never run" apply unchanged. Mapping: user text and images (as attachment descriptions) → user messages; assistant text → agent messages; thinking and Codex reasoning summaries → reasoning; tool calls and their results → one tool item with input (cut at 4,000) and output (cut at 65,536, flagged). Sidechain (subagent) rows, meta rows, Codex environment/instruction preambles and Codex `event_msg` duplicates are skipped. Claude Code token usage becomes turn metadata; Codex has none. A file may be up to 64 MiB; only the newest 1,000 turns / 2,000 items are kept and the session is flagged truncated. The terminal opens the imported session. Import is local-only (a remote peer is refused). Not imported: attachment files, MCP/settings/memory (a "setup" import is a separate decision because it changes trust and permissions).

v1 `{ info, messages }` JSON (what `mendcode export` of v1 writes) imports like another agent's transcript: each user message starts a turn, text, reasoning and tool parts become its items (tool input, output and status kept, files described, not transferred), token use and a failed message are kept, then the result is validated and redacted as a native file. **Pending service:** ShareNext flat parts require B36's compatibility-format decision. `/share/<slug>` imports and account-authenticated share APIs require B74's real sharing backend; they fail explicitly instead of guessing an endpoint or sending credentials. `migrate-v1` remains the separate database-migration path.

Frames: `bun scripts/render-frames.ts .agents-frames/B36 --b36 100x30 180x50` (app harness and local protocol fakes).

## Model recall and versioned working notes (B28)

Every message a recall page returns carries `at`: when it was sent, as local time with its UTC offset
(`2026-10-28T17:25:03-05:00`). That is how the model answers "when did I ask that?": the times are not in the
conversation, so they cost nothing until it reads a page, and the screen shows them only with `/timestamps` on.

The native engine exposes `session_search`, `session_read` and `session_notes` only when the daemon setting
`experimental.session_recall` is `true` (absent means off). Enable it through `settings.set` with a patch such as
`{ experimental: { ...current.experimental, session_recall: true } }`; preserve the other experimental settings.
Changing the flag updates the model's tool catalog on the next call and revokes existing recall ports immediately.
External engines keep their own tool catalogs; these tools are not injected into their processes.

| Model tool | Input and result |
|---|---|
| `session_search` | `query`, optional `session_id`, `before`, `limit`; returns `{ session_id, messages, next_cursor?, more }` |
| `session_read` | the same paging fields without a required query; `message_id` and optional `offset` read one message as `{ session_id, message_id, at, text, next_offset? }` |
| `session_notes` | `action: "read"` with optional `version`, or `action: "write"` with current `version` and replacement `text`; returns `{ version, text, current_version }` |

Recall defaults to the calling session. An explicit target must be that session or a linked descendant, with every
ancestor in the same canonical project directory. Siblings, ancestors, unrelated projects and cycles are refused;
message IDs and cursors must belong to the selected session. This is the conservative isolation boundary for the
audit's pending policy decision: broader access is not enabled or configurable without user approval.

History comes from persisted events, not the compacted model context. Pages scan at most ten completed user/assistant
items (successful tool outputs are assistant items), in chronological order within each newest-first page. `limit`
defaults to ten and clamps to 1–10. Search is case-insensitive and filters the scanned page, not the whole history:
follow `next_cursor` even when `messages` is empty. Previews stop at 2,000 characters; single-item reads stop at 16,000
and expose `next_offset`. Private reasoning, notices, failed tool outputs and reverted turns are excluded. Recognizable
credential patterns are redacted. All three RPCs require full access; none belongs to the remote read-only allowlist.

Notes start at version zero with empty text. Each write requires the current version and at most 16,000 characters;
missing/stale versions fail without modifying anything. Revisions persist across restart/compaction, are readable by
version, and are deleted with their session. Forks/children start with independent notes. Notes are never injected
automatically into prompts and never copy the terminal's private per-project scratchpad. Plan mode can read notes,
but cannot write them; writes use normal write permissions and extension rewrites are rechecked.

Protocol commands are `session.recall.search`, `session.recall.read` and `session.notes`, each with `{ sessionId, input }`.
Typed client helpers are `searchSession(sessionId, input)`, `readSession(sessionId, input?)` and
`sessionNotes(sessionId, input?)`. Their successful replies wrap the result as `page`, `recall` and `notes` respectively.
Tool cards use the shared bordered panel grid, become one column below 70 cells, and keep the existing Ctrl+O expansion
and terminal-extension overrides. Frames: `bun scripts/render-frames.ts .agents-frames/B28 100x30 180x50 --b28`.

## Thread tools and `@thread` (T4, tier balanced)

Other local sessions of the same project, two ways. Both are bounded, redacted text (credential patterns replaced, secret markers `‹secret:N›` stay markers: values never cross sessions), same canonical project only, and never offered to a remote or peer client.

**`threads` tool.** One native tool for the main agent, `experimental.thread_tools` (feature `threads`: on from `balanced`, off in `minimalist`, off without a tier; `/experimental` and `features.threads` override; schema loads through `tool_search` when discovery is on). `action`: `list` (as `sessions`), `read` and `search` (pages of 10 messages, `more: before=<id>` cursor, search scans 40 per call), `message` (a `tell`: same 3 pending / 20 per hour limits, the answer returns as a notice), `wait` (up to 120 s, default 60, until the session is idle, then its last answer; a timeout reports it is still running and never stops it), `interrupt` (cancels only the running turn; queue and history untouched) and `merge_back` (a fork of this session only: its turns since it branched become context for this session's next message, see Merge-back). `stats` reports a session's figures (this one without `sessionId`; see `session stats` in [automation](automation.md)). Approvals: `list` and `stats` read metadata without asking; `read`, `search` and `wait` need the user's explicit `@thread` mention for that target, its id written in the user's message, or individual approval for every operation, in every mode but full (full access reads them unattended). A sub-agent session this session started (or one of theirs) is its own work: `read`, `search` and `wait` on it never ask. Allow rules and session grants do not replace that consent. Plan mode can approve these reads individually. `message`, `interrupt` and `merge_back` also follow their write gate; unmentioned merge-back needs individual consent because it imports history. Explicit deny rules always win. Creating or launching sessions is not part of this tool.

**Chats of other programs in `threads`.** `threads list` also names the chats that Codex, Claude Code and the previous MendCode keep for the same project, with the ids `codex:<id>`, `claude:<id>` and `v1:<id>` and the mark `readonly=yes` (a previous-MendCode chat shows its title; the other two only their date, since a title would mean reading them). `read` and `search` work on those ids, page from the newest with `more: before=<n>`, and show user, assistant and tool-call lines with the same cuts and secret redaction as a session; reasoning and tool output are never shown. Every read or search of one asks the user: no `@thread` grant and no earlier approval covers it. `message`, `wait`, `interrupt` and `merge_back` refuse those ids. Only chats whose own record names the session's project directory are listed, and a chat is read only through an id listed for that directory. The sources are the files the session import reads (`~/.codex/sessions`, `~/.claude/projects/<project>`, honouring `CODEX_HOME` and `CLAUDE_CONFIG_DIR`) and `~/.local/share/mendcode/mendcode-local.db` (or under `XDG_DATA_HOME`), opened read-only; nothing is written or copied. Only the daemon on the default data directory reads them; one started with a private `--dir` does not.

**`@thread:<id>` mention.** Typing `@th` in the composer lists the project's other sessions (title, `thread` tag); Tab inserts `@thread:` and the last 8 characters of the id (the daemon also accepts a full id). On submit the daemon appends a `<thread-snapshot readonly>` block per mention (at most 3): title, state, last request (1,500 characters), the compaction checkpoint if the session was compacted (3,000), and its last 6 user/assistant messages (900 each), the whole capped at 3,000 tokens (4 characters each; oldest messages go first). The block says it is data, not instructions, and the conversation inside it cannot close its tag. The transcript shows `@thread:ID (title)`. A mention of a session outside the project, or of nothing, refuses the prompt (`target_mismatch`); from a remote or peer client it is refused (`forbidden`). The mention is the user's consent: the session may then `threads read`/`search`/`wait` for that session without individual approval, subject to explicit permission rules; nothing is read automatically otherwise, and attaching grants no send or interrupt right. The grant lives in daemon memory (64 sessions) and ends on restart.

## Picker search, tags, colors and sort (C7)

`/sessions` filters with a small query language: plain words (all must be in the title, directory, tags, agent or model),
`"a phrase"`, `re:pattern` (the rest of the line, case-insensitive), `tag:x` (a tag starting with x) and `color:name`.
Ctrl+S cycles the sort (recent, created, name), Ctrl+L the scope (all projects, the open session's project) and Ctrl+E the
named-only filter (sessions the user titled; `SessionSummary.named`). The summary line names every non-default toggle.

Ctrl+F also searches message text: `session.search { text, regex?, sessionIds?, directory?, limit? }` asks the daemon, which
scans the newest 300 user and assistant messages inside the last 3000 events of at most 200 sessions (never tool output) and
answers `{ hits: [{ sessionId, snippet }] }`. Several words become an all-of expression. Matching sessions are listed even when
their metadata does not match, and the selected one shows its snippet. Decision taken: it is opt-in per picker (off on open) so
typing never scans history; it is refused for remote clients (`forbidden`) because it returns message text, and it is not in
`READ_ONLY_COMMANDS`. Secret markers in snippets are redacted.

Ctrl+T edits the tags and the color of the selected row: words are tags, `color:red` (`red orange yellow green cyan blue
purple pink`) or `color:none` sets the mark. They are the Agent View metadata that `/agents` already had
(`session.agent-view.metadata.patch`, which gained an optional `color`), so one set of tags serves both pages. `session.list`
and `session.get` now carry `tags` and `color`; rows draw `●` in the color and the tags in muted text.

# Changes review, plan review and pasted secrets (terminal)

What the terminal adds around `/changes`, plan approvals and `‹secret:N›` markers. Changes selection and comments are
shared with the model through the daemon (`review.query`, `review.update`, `review.changed`). Plan review uses
`request.resolve`; sending a Changes review uses one `user.submit`.

## /changes review

Balanced/full: `o` previews a local suggested order and `O` applies it: source, tests, docs, generated/binary, then path within each group. This is a filename heuristic, not dependency analysis or an LLM call. It never applies during comment/jump editing. Refresh retains the selected path, draft and comments; an explicitly applied order stays for that open view. `/tier review_order off` disables it. Minimalist leaves it off unless explicitly enabled.

`/changes session` shows the session's persisted net changes; `/changes message <n>` shows the nth user message's
changes from `/timeline`, including reverted turns. These sources do not use the current Git diff. `r` refreshes the
same source; navigation uses the existing panel grid and compact tabs below 70 columns. Historical views are read-only.

The additive `session.changes { sessionId, atItemId? }` command and `client.sessionChanges()` return `ChangesReport`
with `scope` and `complete`. Per-message summaries survive snapshot-byte pruning; session totals involving pruned
bytes are marked **Partial** because overlapping older edits cannot be recomputed exactly. Disabled snapshots,
untracked writers and capture limits also produce partial reports. Diff text is redacted and bounded. The command
requires full peer access: source content is deliberately not added to `READ_ONLY_COMMANDS`.

`/changes` (alias `/diff`) lists the working tree's files and their diffs. With the diff focused the page has a row
cursor, and comments are made on it. Ported from v1's `/changes` (`routes/changes/*`): row selection, `c` comment, `]`/`[`
hunks, `n`/`p` files, `l` jump to a line, `g`/`G`, `r` refresh. New in v2: multi-row selection, hunk comments, edit and
delete, the comment list, and **send review**.

| Key | What it does |
|---|---|
| `↑` `↓` / `j` `k` | move the row cursor (the file list when it has focus) |
| `shift+↑` `shift+↓`, or `v` then moves | select rows; `esc` drops the selection |
| `c` | comment the row, or the selection; on a `@@` header it comments the hunk |
| `C` | comment the whole hunk the cursor is in |
| `e` / `d` | edit / delete the comment under the cursor |
| `]` / `[` | next / previous hunk |
| `n` / `p` | next / previous file |
| `l` | jump to a line number (new side first, then old) |
| `g` / `G` | first / last row; `PgUp` `PgDn` scroll |
| `L` | the comment list: `↑↓` select, `enter` open, `e` edit, `d` delete, `X` twice clears all |
| `s` | send the review (also from the list) |
| `R` | replay: see below |

### Replay

`R` (or `/changes replay [n]`, which opens the last message's changes, or message `n`, already in replay) shows one
hunk at a time and steps through every hunk of every file, in the list's order, with `step 3/9 · hunk 2/2 of this file`
above it. `]`, `space`, `enter`, `↓` or `→` go forward; `[`, `,`, `backspace`, `↑` or `←` go back; `n` / `p` jump to the
next / previous file's first hunk; `g` / `G` the first / last step. `esc` or `R` leaves replay (the cursor stays on that
hunk); `c` / `C` still comment the hunk on screen. It works on every source, including the read-only `session` and
`message` views. Files with no hunk (binary, a pure rename) have no step. Order is the report's (by path), not
chronological.

In the comment box: `enter` saves, `alt+enter` adds a line, `ctrl+u` clears, `esc` cancels. A review holds 60 comments of
800 characters at most.

The daemon saves selection and comments atomically in `<dataDir>/reviews/<sessionId>.json`. The terminal keeps a
mirror in `<dataDir>/tui/reviews/<sessionId>.json`, removed when empty; existing client-only comments are imported on
the first daemon update. Reopening, reconnecting or restarting preserves the shared review. A comment keeps the diff rows it is about, so it
is found again after a refresh even when the lines moved; one whose code is gone is listed as outdated and still sent.

### The review message

`s` sends **one** `user.submit` with every shared comment, in the order written and with its author (user, agent or assistant). The format follows v1's
`<mendcode_review_context>` block (`MendCode review workspace:` and `user comment <path>:<line>`), with the diff excerpt and
the comment added:

```
<mendcode_review_context>
MendCode review workspace:
- Comments: 2 on 1 file (branch main)

1. user comment src/a.ts:11-12, old 11
   ```diff
   -removed line
   +added line one
   +added line two
   ```
   comment: Why drop this?
            And why twice?
2. user comment src/a.ts hunk @@ -40,2 +41,2 @@
   ```diff
   @@ -40,2 +41,2 @@ function b() {
   -old b
   +new b
   ```
   comment: Split this hunk
</mendcode_review_context>
```

The location is `path:11-12` (new lines), `path:old 11` (removed rows), both when the range has both, `path hunk @@ … @@` for a hunk
and the bare path for a file without rows (binary, rename). Excerpts are cut to 40 rows, and to 12, 4 or none when the
message would pass 60 000 characters. After a successful send those comment ids are removed and the page closes; comments arriving during the send remain. A
failed send keeps the review.

### The Git page

From the balanced tier `/changes` is the first tab of the [Git page](git.md): one row above the page shows the tabs and the branch, and `<` `>` move to Commit and Worktrees. The page and its keys are the same; in minimalist nothing is added.

### Left out

This page has no stage, unstage or revert per hunk or file, as in v1 (`r` refreshes); committing whole files is the [Commit tab](git.md). The page uses the shared bordered panel grid from 70 columns, with Files and Diff side by side and one row of panel
padding. Below 70 columns, Files and Diff are single-column tabs. Key hints sit in the page header.

## `review` tool

Permission `read` (review state only; no staging, reverting or code edits). The native engine supplies a session-bound
port, so the tool and every connected terminal share selection and comments through the daemon. Actions match v1:

| Action | Input / result |
|---|---|
| `current`, `summary` | Workspace totals, files/hunks, selected file/block/row, comments |
| `file` | `filePath` (selected file by default); numbered block rows; `includePatch` adds the raw patch |
| `navigate` | `filePath` / zero-based `blockIndex`, or `direction`: next-file, prev-file, next-block, prev-block |
| `reload` | Re-read changes, preserve selection and reconcile comments; publish a page refresh |
| `comment_add` | `filePath`, `blockIndex`, `body`; optional `line`, `side` (old/new/both), `author` (default assistant) |
| `comment_list` | Shared comments, including stale anchors |
| `comment_clear` | All, or filtered by `filePath` and/or `staleOnly` |

The terminal sends targeted additions, edits, removals and selection changes with `review.update`; it never replaces the
whole shared list. A remote navigation preserves an open comment/jump draft. Events are ephemeral; `review.query` hydrates
state after reconnect. Read-only remote peers can query, but cannot update the review.

Legacy `review { path }` and no-argument diff summaries remain available outside a daemon; explicit workspace actions
report unavailable there. Diffs remain bounded, include untracked files, and never change Git's index (`GIT_OPTIONAL_LOCKS=0`).
Shared reviews hold at most 60 comments, each 800 characters, with a 100 KB snapshot cap. File replies bound block rows and
patch text, flag truncation and stay below the protocol frame limit. The standalone numbered-diff mode keeps its existing
60-file, 12-hunk and 600-line / 30 KB limits. Sources: `packages/tools/src/tools/review.ts`, `packages/daemon/src/review.ts`.

## Plan review

When the agent presents a plan (`plan_submit`, approval titled `Review plan`) the panel offers four choices, by key or
number, or by arrows and `enter`:

| | Key | Sends |
|---|---|---|
| Approve & build | `a` `1` | `request.resolve` approve once (plan mode ends) |
| Edit plan | `e` `2` | puts the plan text in the prompt; `enter` denies with a reason that starts with a note that the user edited the plan, followed by the edited text; `esc` cancels |
| Comment | `c` `3` | the prompt takes feedback; `enter` denies with the feedback as the reason; plan mode stays |
| Reject | `d` `4` | `request.resolve` deny with no reason (the agent is told the plan was rejected) |

Typing feedback without choosing still works as before. Approvals carry no answer text, so the edited plan and the
feedback travel as the deny reason (2000 characters at most; a longer edited plan is kept in the prompt and not sent).
Letters type into the prompt while an edit or comment is open, so they never approve by accident.

## Pasted secrets

Markers in the transcript, the approval panel and tool titles are drawn as `‹secret ··<tail>›` with the tail from
`secrets.list` (asked once when a marker without a known tail arrives; a forgotten secret keeps showing the marker). The
transcript keeps the raw marker.

`/secrets` lists the session's secrets: marker, kind, tail and time. `enter` calls `secrets.reveal` and shows the value
under the list **only while that row stays selected**; moving, pressing `enter` again, `esc`, `q` or any other way off the
page hides it, and a reply that arrives after that is dropped. The value lives in the page state only: never logged, never in
a toast (an error says "could not reveal the secret"), never written to disk, stripped of terminal escapes and capped at
six rows. `x` twice calls `secrets.forget` (its marker stops resolving).

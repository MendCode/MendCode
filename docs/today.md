# Today

`/today` is the page to open when you come back to MendCode. It lists what waits for you, the sessions worth picking up and what Dream proposes for your memory, so you can see where to get back in control. Opening the page runs nothing and calls no model; it stores only the time of your last visit, the rows you pin for today and the rows you dismiss.

Every row says why it is there and which command or page manages it. `/today` relates what [`/reviews`](pr-review.md), [`/memory`](memory.md), `/workflows` and [`/sessions`](sessions.md) already track; it does not replace them.

## The three tabs

| Tab | What it lists | Read from |
|---|---|---|
| Attention | sessions waiting for an approval or an answer, however long ago they asked; open pull requests whose newest review waits for you or has a blocking finding (one row per pull request, see below); workflows waiting for input; saved memories that contradict each other | `session.list`, `pr.review` status, `workflow.list`, `memory.graph` |
| Pick up | sessions from the last 7 days whose last turn was interrupted or failed, paused sessions, and finished sessions whose folder has uncommitted changes or unpushed commits and no linked pull request | `session.list`, `git.status` (one per folder, at most six) |
| Memory | what Dream did in its last run, then every pending memory proposal with the memory before and after | `dream.list`, `memory.list` |

**Attention or Pick up?** An Attention row is blocked: the session, review or workflow does not continue until you answer. A Pick up row waits on nobody: it was left half-done and you continue it when you choose. Each list says so in a line under its title.

The paragraph on top is built from counts of these lists. "Since" is your last visit to `/today`; the first time it is the last 24 hours. A visit is recorded when the page opens, as `todayLastVisit` in the terminal profile (`tui/profile.json`). Pressing `r` reloads without moving "since".

A tab with nothing in it says so, for example "nothing needs you". An empty list means the daemon had nothing to report, not that a source failed: a source that could not be read adds a line under the paragraph that names it.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` or `j` `k` | select a row |
| `1` `2` `3` or `tab` | switch tab |
| `Enter` | jump to the row's session; a row without one opens the page that manages it (`/reviews`, `/workflows`, `/memory`) |
| `m` | pin the row for today, or unpin it |
| `x` | dismiss the row; in the dismissed list, bring it back |
| `X` | dismiss every review untouched for 7 days or more, after one `y` (`+` and `-` change the days); in the dismissed list, bring every row back |
| `d` | list only the dismissed rows, and back |
| `o` | list or fold the older reviews |
| `t` | triage: group the rows with a cheap model (see below) |
| `[` `]` | scroll the detail |
| `r` | read everything again |
| `?` | show every key |
| `esc` or `q` | back (with a triage group listed, `esc` first shows every row again) |

The header and each row's detail say what `enter` and `m` do on the selected row.

## Pinned for today

`m` puts the row in a **Today** group at the top of its tab, above **The rest**. Pinning runs nothing, changes nothing in the session, review or memory, and MendCode never pins a row by itself. Pins are kept in the terminal profile as `todayMarks` (the day and at most 50 row ids) and read as none from the next day on.

## Pull requests in Attention

A pull request is one row, however many times it was reviewed. The row shows the newest head: the newest review job names it, and the newest finished, checkpointed or waiting review of that head says what waits. Earlier heads and re-reviews fold into the row's history and evidence ("4 earlier reviews of 2 older heads folded in").

A pull request has no row when:

- GitHub reports it merged or closed (the page reads each repository's pull requests once, cached and time-boxed, as `/reviews` does);
- its newest head is being reviewed right now, or every review of that head failed (`/reviews` shows those);
- its newest review has no open blocking finding and does not wait for you. Open means open on the pull request, as the commit status counts it: that review's own findings plus earlier published ones nobody resolved, so an incremental review that found nothing new keeps an earlier blocker's row.

A review row nobody touched for 7 days folds under one line at the end of the list, "3 older reviews folded (untouched 7+ days) · o lists them". The tab count and the paragraph count only the rows the list shows and say how many are folded or dismissed.

## Dismissing rows

`x` hides the selected row from its tab, in any tab. It stays hidden until something newer happens on it: a new question in the session, a review of a new head. `X` dismisses every review untouched for 7 days or more in one go: the paragraph asks first, `+` and `-` change the days, `y` confirms and any other key cancels.

`d` lists the dismissed rows, where `x` brings one back and `X` (after `y`) brings back every row. Dismissing runs nothing and changes nothing in the session, review or memory. The page keeps the dismissals in the terminal profile as `todayDismissed` (the row id and the row's time, the newest 300), written by MendCode; you never edit a file for it. Attention lists at most 40 rows plus 40 older reviews, counted without the dismissed ones, so dismissing rows brings up the waiting ones past the limit.

## Triage

With many rows (50 memory proposals, 30 sessions waiting), `t` sends the rows the tabs list (not the dismissed or folded ones; at most 60, as short text: tab, kind, title and why) to a cheap model in one call, and shows the groups it proposes: a title, why the rows belong together, an example row and one action. Nothing calls a model before you press `t`, and the answer is kept until the page closes (`t` shows it again; inside the triage view `t` asks again).

The model is the memory or `small` role when you set one, else the main model's cheaper peer (Luna for Sol). With only a large model or an external engine available, triage says so and does not call. The model's name is in the triage view's first line, and the call is counted in [usage](usage.md) as `todayTriage`.

In the triage view, `↑` `↓` select a group, `enter` lists only its rows (one by one, each with its own enter), and `a` accepts the proposed action:

| Action | What accepting does |
|---|---|
| one by one | lists only the group's rows; each one stays your call |
| pin for today | pins the group's rows |
| review in /memory | opens `/memory`, where `A` or `X` approve or reject what the list shows after you confirm with `y` |
| nothing now | sets the group aside |

The model never approves a command or permission, never accepts or rejects a memory and never pins a row: groups with approvals, questions, reviews or contradictions can only be walked through or pinned, and only memory rows go to `/memory`. A failed or offline call says why and leaves the rows as they were.

## Remote and read-only terminals

Over `--connect`, `/today` shows what the connection may read:

- PR reviews are local-only and are not listed.
- A read-only token cannot read memory, so the Memory tab and memory contradictions are not listed, and the page says so.
- Sessions, workflows, Dream's last run and the git state of session folders are listed.
- A read-only token cannot triage: `t` shows the daemon's refusal.

## Cost

The page loads on its first use, like the other pages, so a terminal that never opens it pays nothing at start-up. Each open asks the daemon for at most one list per source: sessions (100 at most), workflows, pending memories, Dream's runs and, with the `pr_review` feature on and a started session, the review dashboard with the pull requests' GitHub state (one cached `gh` read per repository). Nothing polls while the page is open, and no model is called except by `t`.

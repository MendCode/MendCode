# Today

`/today` is the page to open when you come back to MendCode. It lists what waits for you, the sessions worth picking up and what Dream proposes for your memory, so you can see where to get back in control. Opening the page runs nothing and calls no model; it stores only the time of your last visit and the rows you pin for today.

Every row says why it is there and which command or page manages it. `/today` relates what [`/reviews`](pr-review.md), [`/memory`](memory.md), `/workflows` and [`/sessions`](sessions.md) already track; it does not replace them.

## The three tabs

| Tab | What it lists | Read from |
|---|---|---|
| Attention | sessions waiting for an approval or an answer, however long ago they asked; PR reviews waiting for you or with open findings; workflows waiting for input; saved memories that contradict each other | `session.list`, `pr.review` status, `workflow.list`, `memory.graph` |
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
| `t` | triage: group the rows with a cheap model (see below) |
| `[` `]` | scroll the detail |
| `r` | read everything again |
| `?` | show every key |
| `esc` or `q` | back (with a triage group listed, `esc` first shows every row again) |

The header and each row's detail say what `enter` and `m` do on the selected row.

## Pinned for today

`m` puts the row in a **Today** group at the top of its tab, above **The rest**. Pinning runs nothing, changes nothing in the session, review or memory, and MendCode never pins a row by itself. Pins are kept in the terminal profile as `todayMarks` (the day and at most 50 row ids) and read as none from the next day on.

## Triage

With many rows (50 memory proposals, 30 sessions waiting), `t` sends the rows on the page (at most 60, as short text: tab, kind, title and why) to a cheap model in one call, and shows the groups it proposes: a title, why the rows belong together, an example row and one action. Nothing calls a model before you press `t`, and the answer is kept until the page closes (`t` shows it again; inside the triage view `t` asks again).

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

The page loads on its first use, like the other pages, so a terminal that never opens it pays nothing at start-up. Each open asks the daemon for at most one list per source: sessions (100 at most), workflows, pending memories, Dream's runs and, with the `pr_review` feature on and a started session, the review dashboard. Nothing polls while the page is open, and no model is called except by `t`.

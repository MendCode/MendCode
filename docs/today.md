# Today

`/today` is the page to open when you come back to MendCode. It lists what waits for you, the sessions worth picking up and what Dream proposes for your memory, so you can see where to get back in control. It only reads: opening the page runs nothing, calls no model and stores nothing but the time of your last visit.

Every row says why it is there and which command or page manages it. `/today` relates what [`/reviews`](pr-review.md), [`/memory`](memory.md), `/workflows` and [`/sessions`](sessions.md) already track; it does not replace them.

## The three tabs

| Tab | What it lists | Read from |
|---|---|---|
| Attention | sessions waiting for an approval or an answer; PR reviews waiting for you or with open findings; workflows waiting for input; saved memories that contradict each other | `session.list`, `pr.review` status, `workflow.list`, `memory.graph` |
| Pick up | sessions from the last 7 days whose last turn was interrupted or failed, paused sessions, and finished sessions whose folder has uncommitted changes or unpushed commits and no linked pull request | `session.list`, `git.status` (one per folder, at most six) |
| Memory | what Dream did in its last run, then every pending memory proposal with the memory before and after | `dream.list`, `memory.list` |

The paragraph on top is built from counts of these lists. "Since" is your last visit to `/today`; the first time it is the last 24 hours. A visit is recorded when the page opens, as `todayLastVisit` in the terminal profile (`tui/profile.json`). Pressing `r` reloads without moving "since".

A tab with nothing in it says so, for example "nothing needs you". An empty list means the daemon had nothing to report, not that a source failed: a source that could not be read adds a line under the paragraph that names it.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` or `j` `k` | select a row |
| `1` `2` `3` or `tab` | switch tab |
| `Enter` | jump to the row's session; a row without one opens the page that manages it (`/reviews`, `/workflows`, `/memory`) |
| `[` `]` | scroll the detail |
| `r` | read everything again |
| `?` | show every key |
| `esc` or `q` | back |

## Remote and read-only terminals

Over `--connect`, `/today` shows what the connection may read:

- PR reviews are local-only and are not listed.
- A read-only token cannot read memory, so the Memory tab and memory contradictions are not listed, and the page says so.
- Sessions, workflows, Dream's last run and the git state of session folders are listed.

## Cost

The page loads on its first use, like the other pages, so a terminal that never opens it pays nothing at start-up. Each open asks the daemon for at most one list per source: sessions (100 at most), workflows, pending memories, Dream's runs and, with the `pr_review` feature on and a started session, the review dashboard. Nothing polls while the page is open.

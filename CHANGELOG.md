# Changelog

What changed for MendCode users, newest first. Every user-visible change adds an item under `## Unreleased` in the same pull
request; a release reads its notes from here and fails without them ([release notes](docs/release.md#release-titles-and-notes)).

A section is a summary paragraph and items under `### New`, `### Changed`, `### Fixed`, `### Upgrade notes` and
`### Known limitations` (only the groups that apply). Cutting a stable or beta release renames `## Unreleased` to its tag
(`## v0.0.2 - 2026-11-03`) and starts a new empty one; nightlies take the items they add to `## Unreleased`.

## Unreleased

## v0.0.14 - 2026-11-10

Computer Use no longer slows the app it worked in and sends browsers to the MendCode extension, which is on in the full tier; every tool call keeps its own row in the transcript; Claude Code sessions keep your language after compacting; and sub-agents can start bare.

### Upgrade notes

- Same code as v0.0.14-beta.1.

## v0.0.14-beta.1 - 2026-11-10

Computer Use no longer slows the app it worked in and sends browsers to the MendCode extension, which is on in the full tier; every tool call keeps its own row in the transcript; Claude Code sessions keep your language after compacting; and sub-agents can start bare.

### New

- Sub-agents can start bare: with none of your or the project's instructions, memories or skills, only the question, for a second opinion your conventions do not steer. Turn it on with `/tier task_bare on` and ask for a clean agent.
- A bare sub-agent on Claude Code also runs none of your Claude Code hooks.

### Changed

- Computer Use sends Chrome, Brave, Edge, Arc and Chromium to the MendCode browser extension, and tells you how to install it.
- The browser extension is on in the full tier: ask the model to use your browser and it offers to install it. Elsewhere `/tier browser_extension on` turns it on.
- Claude Code sessions compact at 200K tokens even when `compactAtTokens` is set higher for long-window models; a per-model `compactAt` still raises it.
- The whole memory graph groups each category with a dotted line in its color, so memories without links no longer sit apart in a list.

### Fixed

- Computer Use no longer leaves an app slowed after it ends: a session that goes quiet ends on its own and turns the app's accessibility mode off again.
- The Computer Use cursor stays where it last went, dimmed, instead of vanishing between steps.
- Every tool call keeps its own row in the transcript: reads, searches and commands no longer fold into `Read 5 files` or `N tools more`.
- Waiting for something on screen in Computer Use checks less often the longer it waits, so the app stays responsive.
- A PR review no longer picks up the `AGENTS.md` of a folder when it reads a file there.
- The code graph now covers a project's own git repository inside a folder that ignores it (a workspace holding the app's repo), so graph searches find that code instead of answering that nothing matches.
- Dream, `/btw` and memory extraction now wait out a busy or rate-limited provider and try again, instead of failing on the first overload.
- Usage counts now include the tokens Claude Code spends on compacting a conversation.
- Claude Code's own automatic compaction writes its summary in your language, so a long session no longer drifts into English after it.

## v0.0.13 - 2026-11-09

Image generation with a ChatGPT login works again, the default theme is called MendCode, profiles can start from a clean look, and diagrams read better in a narrow terminal.

### Upgrade notes

- Same code as v0.0.13-beta.1.

## v0.0.13-beta.1 - 2026-11-09

Image generation with a ChatGPT login works again, the default theme is called MendCode, profiles can start from a clean look, and diagrams read better in a narrow terminal.

### New

- `mendcode profile new <name> --clean` makes a profile that starts from MendCode's clean look: while it is on, your own look settings and UI modules are set aside, and disabling it brings them back.

### Changed

- The name `mendcode-next` is gone: `--json` lines carry `"schema": "mendcode.cli"`, the migration report `mendcode.migrate`, `mendcode upgrade` keeps its binary as `<data dir>/bin/mendcode`, and the development wrapper is `mendcode` (`MENDCODE_BIN_DIR`).
- The default theme is now called MendCode (`mendcode`, formerly Ink: mendcode.dev's black and white); like before it keeps the terminal's own background, so transparency and blur show through. The green Mend theme is gone: a saved `ink` or `mend` opens MendCode, and v1's orange theme is `mendcode-v1`.
- graft's tally line no longer ends the answer; the turn's closing line shows it as `graft ~70k`.

### Fixed

- An install whose executables were still called `mendcode-next` moves them to the new name on its next upgrade and keeps its rollback; uninstall removes them too.
- A sequence diagram's messages from the last participant to itself get the room beside it, so they no longer break one word per line; none of their words is cut.
- A generated picture's path shows your home folder as `~`; copy path still copies the full path.
- Dream no longer stays on "running…" while a session waits for your approval, even one you archived; background work only waits for sessions that are really working.
- Mermaid diagrams read better in a narrow transcript: a sequence gives its spare room to its long messages instead of splitting them, and a state diagram writes a state's transition to itself beside its box and never lets two labels land on the same row.
- Image generation with a ChatGPT login works again: when the image model refuses the reasoning effort, the request is sent again at once without it, quietly and in the same image card.
- A look change saved while a profile is on (for example the theme, from chat) keeps only that change; the profile's other keys stay the profile's.
- The home's Completed list no longer shows sessions that were never written in, and an untitled session reads "Untitled session" instead of its id.

## v0.0.12 - 2026-11-08

Computer use is much faster and smarter, with its own cursor, and a profile can give a clean look by switching off your own terminal modules.

### Upgrade notes

- Same code as v0.0.12-beta.1.

## v0.0.12-beta.1 - 2026-11-08

Computer use is much faster and smarter, with its own cursor, and a profile can give a clean look by switching off your own terminal modules.

### Changed

- Computer use is much faster: a batch of actions no longer waits for the cursor, and a single action no longer waits for its animation. A task like 12 + 34 in Calculator runs in a fraction of a second, and the model is taught to do a task in one call.
- Computer use tools are smarter: steps can name the button instead of its ID, an action waits for the app to settle and returns what changed, a session starts by the app's name (also in your language), an app that is still opening is waited for, and an argument past its limit is brought to the limit instead of failing.
- The computer use cursor has its own look, a coloured dot with a black action tag. Each MendCode picks its colour when it starts, and two running at once never share one. The cursor stays with the controlled app: a window covering the app covers the cursor too.
- A profile can switch off your own terminal modules and views while it is on (for a clean demo look without your footer extensions), together with your footer, mascot and panel; turning it off brings everything back exactly as you had it.

## v0.0.11 - 2026-11-08

Replies stay in your language after background tasks and compactions, and the sidebar counts read more clearly.

### Upgrade notes

- Same code as v0.0.11-beta.1.

## v0.0.11-beta.1 - 2026-11-08

Replies stay in your language after background tasks and compactions, and the sidebar counts read more clearly.

### Fixed

- Replies stay in your language in turns a background task starts and after a compaction. Claude Code sessions also get a standing language rule and write their compaction summary in your language, and MendCode's own notices no longer move the reply language to English.
- The sidebar's running and approval counts have a space between the mark and the number.

## v0.0.10 - 2026-11-08

An undo in a Claude Code session no longer gets stuck waiting, so idle compaction keeps working.

### Upgrade notes

- Same code as v0.0.10-beta.1.

## v0.0.10-beta.1 - 2026-11-08

An undo in a Claude Code session no longer gets stuck waiting, so idle compaction keeps working.

### Fixed

- In a Claude Code session, an undo now reaches Claude Code in turns that run with their own MCP servers too. An old undo no
  longer stays waiting, so idle compaction can't fail on it or cut the conversation back to that point.

## v0.0.9 - 2026-11-08

Agents ask for Claude models by name and keep going on long tasks, Claude Code sessions compact while idle, PR watch waits
for MendCode's own review, the reviews page can be cleaned up, and replies stay in your language.

### Upgrade notes

- Same code as v0.0.9-beta.2.

## v0.0.9-beta.2 - 2026-11-08

Agents ask for Claude models by name and keep going on long tasks, Claude Code sessions compact while idle, PR watch waits
for MendCode's own review, the reviews page can be cleaned up, and replies stay in your language.

### New

- `/customize` → Home → Logo size picks large, medium or small for any logo kind, and Home position puts the home's block in the middle or at the top.

### Fixed

- Creating thousands of items in the same instant no longer fails with an id error.
- `mendcode doctor` tells warnings (a skill another layer overrides, a field an agent file cannot use) apart from real problems, checks the binary, PATH and login, lists Claude Code, Codex and Rex when installed, and ends with one line saying whether MendCode works.
- The installer runs the binary it installed and says whether its folder is on PATH, with the exact line to add for your shell.
- The home's logo keeps its size and place while the slash menu is open.
- Logo kind `both` draws the same letters as the wordmark instead of another font.
- The big title sits a row further from the mark where the screen has room.
- Replies stay in your language after a background task or Monitor ends in Claude Code, and after a short or mixed message; a Spanish message with English words is no longer answered in French.
- `mendcode workflow list` shows the newest 50 runs (`--limit N` up to 500); with hundreds of runs `--all` failed.
- A workflow step no longer reads the files an earlier, finished step of the same run wrote as another session's work, and no longer stops to leave them alone.
- Asking for a sub-agent by a Claude family name ("opus", "sonnet") runs it on your Claude Code model the first time, without naming the engine; when a call still cannot run, one error says everything to change. Agents with tool or path rules are marked "native models only" in the task tool.
- Reviews page: `d` removes a finished review (failed, cancelled, done) from the list; cancelling or removing keeps the selection where it was; ↓ on the last row goes back to the first, and ↑ on the first to the last.
- Shift with ↑ or ↓ moves five rows at a time on every page with a list or text.
- PR watch no longer says "all checks passed" on a new commit while MendCode's own review of it has not reported yet; it waits for that review (up to 20 minutes).
- `mendcode daemon run --listen HOST:PORT` starts a daemon other machines can connect to; before, only a source checkout could. `--connect` to an address with no daemon prints a short error.
- An agent that sends a message to another session and waits is told at once when that session needs your approval, instead of waiting ten minutes without saying so.
- An agent asked to change MendCode's own source code no longer refuses it as if it were a settings file.
- GPT-6.1 Terra carries long tasks through in one turn instead of stopping at a plan or a first step.
- Claude Code sessions compact while idle, just before Claude Code's one-hour prompt cache expires, as the native engine does (full tier, `idle_compact`).

## v0.0.8 - 2026-11-07

Workflow scripts say why they stopped and cheap models follow their steps more reliably, and test tokens are no longer
hidden from the model as secrets.

### Upgrade notes

- Same code as v0.0.8-beta.1.

## v0.0.8-beta.1 - 2026-11-07

Workflow scripts say why they stopped and cheap models follow their steps more reliably, and test tokens are no longer
hidden from the model as secrets.

### Fixed

- Workflow agents asked for JSON get the schema as the shape of their answer, and an answer that repeated the schema first is still read.
- A workflow agent is told that finishing its own task is `done`, so a step no longer reports blocked because later steps are still to do.
- Test values such as `test-…`, `mock-…` or `fixture-…` tokens are no longer hidden from the model as secrets, so it can edit the tests that use them.
- `mendcode workflow show` prints a script's last log lines and what it returned, so a script that stopped early says why.

## v0.0.7 - 2026-11-07

`/today` gathers what needs you in one page, memory works by itself in balanced and in every engine, Claude Code
sessions load less of your own setup and keep their background agents on a model change, held-space dictation no
longer stops after a minute, the token count moves while a model thinks, and the PR reviewer spends less.

### Upgrade notes

- Same code as v0.0.7-beta.1.

## v0.0.7-beta.1 - 2026-11-07

`/today` gathers what needs you in one page, memory works by itself in balanced and in every engine, Claude Code
sessions load less of your own setup and keep their background agents on a model change, held-space dictation no
longer stops after a minute, the token count moves while a model thinks, and the PR reviewer spends less.

### New

- Claude Code sessions load less of your own Claude Code setup by default: `/settings` → `claude context` picks lean (no own MCP servers or auto memory), full or isolated (none of your setup); permissions never change.
- `/today` lists what needs you, the sessions to pick up and Dream's memory proposals in one read-only page.
- On `/today`, each tab says what it holds (Attention: blocked until you answer; Pick up: left half-done) and each row says what Enter does.
- `/today` `m` pins rows into a Today group at the top until midnight.
- `/today` `t` asks a cheap model once to group the rows and propose one action per group; nothing happens until you accept a group, and approvals and memory decisions stay yours.
- In /memory Pending, `A` and `X` approve or reject every proposal the list shows, after one confirmation.
- Pending proposals nobody decides are archived after a while (`memoryPendingDays`; 0 keeps them).
- Claude Code and Codex sessions receive the same memory block as native ones.
- Memories record the session and engine they came from.
- Balanced now remembers by itself: saved facts reach prompts and new ones are proposed to Pending; minimalist stays off until you turn it on.
- Memory is reviewed once per session at checkpoints (after several turns, when a session goes idle, before compaction) instead of after every turn, with a daily call limit; temporary folders, worktrees and child sessions are skipped.
- pi and ACP agent sessions receive the same memory block as native, Claude Code and Codex ones.
- Unused code graph caches, and those of folders that no longer exist, are cleaned up automatically.

### Changed

- The PR reviewer spends less of your model quota: a push with nothing new to review (an empty or reworded commit, only ignored files) calls no model, and a diff just over one review call is no longer split into a second call.
- A retried PR review verification no longer asks the readers again, and a measured cost rise is settled by the next measurement instead of a model.
- When GitHub cannot be reached, the PR review watch now says it is waiting and has not stopped; it keeps retrying and resumes by itself.
- `/today` shows each pull request once, from its newest head, and leaves out merged or closed ones and reviews with no blocking finding left; reviews nobody touched for a week fold under one line.
- `/today` can dismiss a row with `x`, or every old review with `X` after one confirmation; `d` lists what you dismissed and brings it back.
- The PR reviewer blocks a MendCode pull request for cost only when a total rises (memory, CPU or disk per session); a rise inside alone is a note.
- The start screen's infinity mark has the website logo's wide shape, with MendCode in big letters under it when the terminal has room.

### Fixed

- Choosing a panel preset in a session no longer hides your own version of it: `/panel galaxy` shows your custom galaxy, `/panel galaxy default` the built-in one, and the `/panel` menu says which is which. Sessions that already showed the built-in copy get yours back.
- A PR review verifier answer with text after its JSON, or the JSON written twice, is no longer refused and retried.
- The activity line shows the tokens received while a long model call or a long think is still running, marked `~` until the exact figure arrives.
- A light theme in a dark terminal (or a dark one in a light terminal) paints its own background, so its text stays readable; the terminal's colours come back on exit.
- Dictating with a held space no longer stops and starts again after a minute: it listens until you let go.
- A file pasted in the middle of a sentence no longer splits it: the model gets the whole sentence, then the file, and the transcript shows the file folded to its name.
- The built-in pets drop the old green: MendGirl and her robot are in Ink's black and white, and MendAscii takes every theme's own primary color (the Mend theme keeps the mint robot).
- Changing a Claude Code session's model no longer ends its background agents: the model switches live, and a new effort waits until they finish.
- Page tabs draw their shortcut number dim and apart, so it no longer reads as the tab's count; `/today` shows each count once.
- The PR reviewer measures MendCode's own pull requests again from a checkout without installed dependencies, and a failed measurement names its error instead of bun's version.
- On a small diff the reviewer says the review pass reads the code itself, instead of calling the readers' share spent.
- A workflow started from a plan or smart session keeps that mode instead of falling back to ask.
- Dream by itself only runs inside full git checkouts: never the home folder, hidden folders such as `~/.ssh`, `~/Library`, secrets folders or tool clone folders (`*-wt`, `worktrees`); a tick lists what it left out and why.
- Dream's run report names the model that answered and the cached prompt tokens.
- The memory tools refuse a category they do not know and name the valid ones; a near miss is stored as the category it means.
- Memory review keeps its progress across daemon restarts: unreviewed turns are still reviewed and reviewed ones are not sent again.
- Titles, summaries and Dream with no model of their own or `small` run on the main model's cheaper peer (Luna for Sol), also for Claude Code, Codex and pi sessions.
- First-run setup no longer opens on the Model row while it is still checking; the Model row appears only once something can run.
- Dream no longer runs on temporary folders, missing folders or worktrees, and skips projects with nothing new.
- Dream recovers every interrupted project, not only the most recent runs.
- A memory you rejected or archived is not proposed again, and repeats are matched ignoring case and punctuation.
- Memory extraction skips greetings and no longer counts failed calls in usage.

## v0.0.6 - 2026-11-06

Workflows run with the permission you choose and no longer stall on their own package files, approving from the
terminal never hangs, `/workflows` navigation is fixed, and release reviews stop re-reading reviewed code.

### Upgrade notes

- Same code as v0.0.6-beta.1.

## v0.0.6-beta.1 - 2026-11-06

Workflows run with the permission you choose and no longer stall on their own package files, approving from the
terminal never hangs, `/workflows` navigation is fixed, and release reviews stop re-reading reviewed code.

### Fixed

- Returning from a workflow task with ↑ goes back to the workflows list.
- Package workflow agents can read their own package files without an external-directory prompt.
- Workflow previews and runs honor the user's chosen permission instead of silently lowering it to the script default.
- Headless runs explain when a session is waiting for an earlier approval instead of hanging.
- The workflows page shows runs from other projects without requiring a scope switch.
- Release reviews reuse completed stacked and incremental reviews without skipping unreviewed changes.

## v0.0.5 - 2026-11-06

A setup that finds your tools and sign-ins, a redone Marketplace and `/sessions` with search, replies that stay in your
language, restarts that never interrupt or leave sessions held, prompt history that comes back, and an Apache 2.0 license.

### Upgrade notes

- Same code as v0.0.5-beta.1.

## v0.0.5-beta.1 - 2026-11-06

A setup that finds your tools and sign-ins, a redone Marketplace and `/sessions` with search, replies that stay in your
language, restarts that never interrupt or leave sessions held, prompt history that comes back, and an Apache 2.0 license.

### New

- MendGirl, with neko ears and her little robot, ships as a built-in pet beside MendAscii: choose her in `/pet` or as the start screen's mascot with `/mascot mendgirl`.
- Workflow scripts can pass text to a check's standard input with `check(command, { stdin })`.
- With session recall on, an agent can find the session where something was done: `session_search` with `scope: "project"` looks through the titles and messages of this project's other sessions, newest first, and `session_read` can then open the ones it found.
- Ask the agent to take you to a session it found and your terminal switches to it when its reply ends, as if you had chosen it in `/sessions`; elsewhere it gives you the `mendcode attach` command with the session's full id.
- Replies stay in your language: each message you send restates it to the model, so a long stretch of tool output in another language no longer switches the answers. By default it follows the language of your latest message; `/language Español` (or the Reply language row of `/customize`, Chat) holds one language. Works with the native engine, Claude Code, Codex and pi.

### Changed

- The PR reviewer has cheap readers read all the changed code first and sends your main model their summaries and the risky hunks instead of the whole diff, so reviews use far fewer main-model tokens; `readers: { code: overflow }` in `.mendcode/review.yaml` brings back the old behaviour, and `/reviews` shows what the readers used.
- MendCode's license is now Apache 2.0: still open source, and copies and forks must keep the notice that credits MendCode and its author. Earlier versions keep their MIT license. The MendCode name and logo are not licensed to forks.
- MendAscii takes the theme's colors: under the default Ink theme it is a black and white robot with pink cheeks; the Mend theme and the others keep the mint and teal one.
- Every notice is now one short row in words with the same look and place: a severity mark, the message and what to do next, with `F4 details` for the full text (`/tier` says the tier, its prompt and how many features are on, instead of a list of flag ids); errors stay until your next prompt or command.
- `/profiles` → `o` groups what a profile overrides with plain names and before → after values, shows the selected one in a detail and tags the ones you kept `yours`; `k` there keeps your value, and the list's header shows a few keys with `?` for the rest.
- `/sessions` has a search row on top ("Search sessions, folders or ids"): typing still searches at once and now also finds sessions by folder path and by id (full or short), including older sessions past the ones the page loads. Tab picks a folder to show only its sessions, the scope shows as a small this folder / all projects toggle, the header keeps a few keys with `?` for the rest, PgUp/PgDn and Home/End move through long lists, and Esc clears the search before it goes back.
- `/marketplace` is redone: a search row on top, kind filters on Tab, one row per profile with its kind, author or source, a short description and an on, off or update badge, and a detail that shows what installing it takes over (before → after, read from the profile before anything installs) and where it comes from. Enter previews, then installs, updates or installs again after you confirm; `d` removes; each ends with one short notice. Empty, offline and failed catalogs say so in words. `/profiles` and `/marketplace` share three tabs, What it takes over | Installed | Marketplace, on `1` `2` `3`.
- `/reviews` has a quieter header: a few keys with `?` for the rest, and only what needs attention (running, queued, waiting, failed) next to the tabs; the 24-hour totals stay in the Watches tab.
- `@mendcode review` on a head that was already reviewed now replies with that review's result (its findings, the earlier ones now fixed and those still open) and suggests `@mendcode review full`, instead of a bare "skipped" with a terminal command.

### Fixed

- Forced service restarts validate the service before draining and no longer stall on a disconnected daemon; explicitly paused queues and disabled restart resumption stay held.
- `/rename` targets the current session across projects, and message search refreshes when the session scope changes.
- Compaction preserves percentage thresholds, validates model overrides, and reports reserve-derived thresholds correctly.
- Marketplace removal cancels on Enter, filtered previews stay accurate, and the selected source remains visible.
- Standalone Codex sessions follow the reply-language setting.
- Workflow checks mark discarded output as truncated even when the captured output ends in whitespace.
- ↑ in the prompt and `/prompt-history` show what you typed before again in projects with a long history (long pasted messages left the list empty); ↑ pressed while the daemon restarts no longer leaves it empty either.
- A workflow script's `check()` that passes now gets the command's output in `detail`, as a failing one already did, instead of just "pass". It gets the whole output, so a script can read a JSON file or a long report through a check; very large output is cut and marked `truncated` instead of being shortened silently.
- The first-run setup shows each tool and login it found (Codex, Claude Code, ChatGPT, API keys, pi) as a row you can act on: use Codex as its own harness, sign MendCode in with your ChatGPT account and come back with your choices kept, use Claude Code, or add a key. Using Codex this way works in every tier and leaves your tier as it is (`/tier codex_engine on|off`). With nothing that can answer yet, it no longer offers to start chatting with a model that does not exist; it offers to skip for now instead.
- A compaction threshold written as a fraction (such as 0.8 for 80%) now compacts at that share of the context window instead of right away on an almost empty session; the threshold is a percent of the window, and a new value above 100 or not above 0 is refused with a message saying so.
- The agent gives a session's full id (`ses_…`), which `mendcode attach` takes, instead of a short code, and `/sessions` finds a session by its full id or the short end of it.
- In `/sessions`, typing `/` no longer adds a slash to the search (which made "/glass" find nothing), and the selection no longer jumps to another session while other sessions are working, so scrolling down a long list stays where you are.
- `mendcode daemon restart --force` no longer kills a command, background task, monitor or agent a session is running: it waits a bounded time for that work (`--grace`) and says which sessions it waits on, then the daemon really restarts; anything it still has to stop is listed by command line to that session when the daemon starts again. A restart command that goes away during the wait leaves the sessions unpaused and interrupts nothing.
- A forced restart no longer waits on a session that only waits for your approval or answer: it lists it as waiting for you, and its turn resumes after the restart. After the restart, messages queued during the wait are sent in order instead of staying held until you resumed each session; a session you paused yourself stays held.
- Started in your home folder, `/sessions`, the home's Agent View and its Completed list no longer show every project under it: like any folder, they show the sessions started there. `/sessions` now opens on this folder's sessions with each child session nested under its parent; Ctrl+L still shows all projects.

## v0.0.4-beta.5 - 2026-11-06

Ink, black and white like the website, is the new default theme; the sessions sidebar fits one session per line with a
state symbol; `/usage` counts every harness and call once with cache; `/reviews` shows each pull request's state.

### New

- PR reviews set a `MendCode review` commit status on the head, so a branch can require that its latest commit was reviewed and has nothing blocking.

### Changed

- Ink, the website's black and white, is the new default theme: if you never picked a theme you get Ink, and `/theme mend` brings the old look back.
- The sessions sidebar shows one row per session with a state symbol (waiting for you, running, failed, unread reply, queued, idle), the age, child sessions and PR on the right, groups for pinned, today and earlier, and settled sessions folded into one row; only running and approval rows move.
- Diagrams and charts no longer show art/copy labels; tables and code blocks keep copy.
- `/reviews` follows the running or newest review until you pick one, and running reviews show a live spinner with their phase, step and time.
- `/reviews` shows each pull request's GitHub state (merged, closed, draft, ready, failing checks or conflicts), and `f` can filter to ready, needs work or closed.
- `/usage` totals count every call once (every harness, ACP agents, sub-agents, calls outside your turns, imported usage) with cache read and write, reasoning no longer counted twice (also in the sidebar, the footer and each turn's output figure), and show today, 7 and 30 days, a by-harness table and cache columns with hit rate per model; an unpriced cost says unknown.

### Fixed

- `mendcode profile check` fails a workflow script too large to run, instead of letting it install and fail later.
- Selecting text in a message drawn with its own background colour shows the highlight on that text again.

## v0.0.4-beta.4 - 2026-11-06

Large pull requests get reviewed through cheap readers instead of failing, merged pull requests count as reviewed only after
a full review, and a child session's approvals no longer fill your queue.

### Changed

- Large code pull requests keep reviewing with cheap readers fetching overflow files in pieces, with unread files clearly listed.

### Fixed

- PR reviews retain deferred files' changed lines, withhold full coverage for unread files, and keep small diffs batched.
- Release reviews reuse only proven full reviews, work with GitHub Actions tokens, and read commit trees together instead of separately.
- A session whose child waits for approval gets one notice that disappears once answered and stays out of your queue, and answering a card that just changed no longer shows "request is not pending".

## v0.0.4 - 2026-11-05

Profiles and areas, threads and side chats, turns that resume after a restart, a PR reviewer that describes, scores and
shows its progress, and a terminal that starts lighter by loading what a session does not use only when it is needed.

### Upgrade notes

- Same code as v0.0.4-beta.3.

## v0.0.4-beta.3 - 2026-11-05

Send now keeps going with your message, a running PR review takes one line, and release PRs review only what merged pull
requests did not.

### New

- PR reviews reuse changes already reviewed in merged pull requests, reviewing only the remainder of release PRs and calling no model when nothing else changed.

### Changed

- A running PR review shows one live line above the prompt with its phase, current step and time, instead of a row per step.

### Fixed

- Send now continues with the promoted message exactly once after interrupting a running tool.
- After a daemon restart with watched pull requests, resumed turns no longer fail because they started before the reviewer was ready.
- Live answers of `mendcode docs` wait for a busy daemon as long as `mendcode usage --quota` does.

## v0.0.4-beta.2 - 2026-11-05

The terminal starts lighter: the parts a session does not use load only when they are needed, so the idle prompt uses less
memory. `--no-context-files` also leaves out prompt files, and a busy daemon is no longer reported as stopped.

### Changed

- The terminal loads the web server, GitHub and PR review, engines and providers you do not use, MCP, LSP, loops, Dream and the code graph only when needed, so the idle prompt uses less memory.

- An idle terminal keeps fewer prepared database statements in memory, creating them only when needed.
- The terminal leaves command-only pages and help text unloaded until needed, keeping the idle prompt lighter without changing the start screen.
- The terminal loads computer and browser controls and other optional daemon helpers only when needed, keeping the idle prompt lighter.
- The "What fits you" prompt on a release page sits right under Install, and it updates an older MendCode first with that channel's command.

### Fixed

- Quota and live documentation no longer report an unresponsive daemon as stopped.
- `session send` without `--approve` leaves pending tool approvals for the terminal owner instead of silently denying them, including in child sessions.
- `mendcode --help` says `--no-context-files` leaves instruction files out while skills stay; `--exclude-tools skill` hides them.
- `--no-context-files` also leaves out `SYSTEM.md` and `APPEND_SYSTEM.md`, including the ones an installed package brings.

## v0.0.4-beta.1 - 2026-11-05

Packages become profiles and areas, sessions gain threads, side chats and resumable turns after a restart, the PR reviewer
describes, scores and shows its progress live, smart permissions cover more cases with every engine, `/whatsnew` shows what fits
how you work, and the daemon holds less memory while it runs commands.

### New

- The PR reviewer's `@mendcode describe` (and `/pr describe`) writes a summary into the pull request's description from its review, in a marked section that never touches what a person wrote; the title changes only with `commands.describe_title`, and a label is added only if the repository has one. `@mendcode resolve` closes the threads of findings the last review marked fixed, and `@mendcode approve` (off unless `commands.approve` is on) approves a head whose last review confirmed nothing. See [PR review](docs/pr-review.md#commands-in-a-pull-request).
- PR reviewer: the verify pass scores each finding from 0 to 10, shown small on the comment; `min_score` in `.mendcode/review.yaml` hides the lower ones and the higher scores come first before `cap` cuts. See [PR reviewer](docs/pr-review.md).
- PR reviewer: `fallback_models` names models a review moves to when its own model fails or is not available (never for a quota); the review says which model reviewed.
- PR reviewer: hunks that only delete lines are sent as one line, and a diff too large for one call keeps the repository's main language longest, so reviews read fewer tokens.
- A PR review at work shows in the session that watches the repository: its steps as tool rows and the activity status with the PR, its phase and its time, gone with the final note. Other sessions name it in the footer (`reviewing Symbex-1#25`). See [PR reviewer](docs/pr-review.md#seeing-a-review-run).
- `/reviews` lists one row per pull request with its earlier runs in the detail, so Failed holds only PRs whose last run failed; running rows show their live phase and time, done ones what they found, and this daemon's own jobs say `this device`.

- With an Anthropic API key, the native engine keeps each conversation in a Claude message thread (beta) and sends only the new messages on each call: the same price, a shorter wait for the first token in long conversations. Turn it off with `/tier message_threads off`; set `zeroDataRetention: true` if your organization requires zero data retention. See [message threads](docs/message-threads.md).
- The card that approves a child above its launcher's mode also offers Approve in full access: the child asks nothing. Only you pick it on the card; a session still cannot ask for full. See [permissions](docs/permissions.md#what-a-session-cannot-do-from-its-own-shell).
- In smart mode, reading the skills and instruction files MendCode loaded for the session no longer asks for external directory access, also through symlinks. Edits there and secrets files still ask. See [permissions](docs/permissions.md#skills-and-instructions).

- `mendcode worktrees list|size|gc`: every worktree with its size, state and why it is kept, including worktrees git lists that MendCode did not make. `gc` previews and `--yes` removes; `gc --artifacts` clears `dist`, `target`, `.next` and `bun build` leftovers of idle worktrees without removing them. See [storage](docs/storage.md#what-changed).
- `/whatsnew` shows what changed since your last look and which changes fit what you usually do, each with an action you confirm before it applies; `/whatsnew all` lists every change with no model call. `/changelog` reads the changelog packed into the build, and every release page ends with a prompt to paste into any session. See [what's new](docs/whats-new.md).
- `worktreeCapGb` warns on `/storage` when MendCode's worktrees pass a size you choose and frees only safe ones to get under it.
- A daemon restart no longer leaves your turns interrupted for good: sessions it stopped, including `run --bg` children, continue when it starts again, and a `run --bg` child keeps its launching session across the restart. A session that cannot continue tells its launcher. `daemon restart` says which turns are running when it refuses, and what `--force` interrupted. Turn it off with `resumeAfterRestart: false`. See [automation](docs/automation.md#background-sessions-b17).
- Sessions started with `run --bg` that wait for approval are announced: the launching session is told once (it cannot approve), and your terminal gets one card, drawn like any approval, with Allow all, Reject all or One by one. Your other terminals say who waits (`/approvals` goes to the card). `session status` and `logs` name what a session waits on.
- `mendcode dev start|restart|stop|status|tui|run`: a second daemon on its own data directory that runs the current checkout, marked DEV and restarted without touching the daemon your sessions use, so MendCode can be programmed from MendCode. See [dev mode](docs/dev-mode.md).
- `mendcode usage --quota [--json]` prints the quota windows the footer shows, read from the running daemon; nothing is sent to a provider. See [usage](docs/usage.md#quota-from-the-command-line).
- A session that runs `mendcode run --permission smart` above its own mode now asks you on one card (model, folder, mode, title, prompt) when your terminal has it open; approving starts that child with that prompt only. Without you there it is still refused, and the error gives the command to run yourself. See [permissions](docs/permissions.md#what-a-session-cannot-do-from-its-own-shell).
- `/customize` is regrouped: the common sections first (Look, Home, Prompt & footer, Chat, Activity), Extensions, Views, the slash menu and terminal internals under Advanced. A row that depends on one switched off is hidden with it. See [customize](docs/customize.md).
- `/` in `/customize` and `/settings` filters the rows by name, section or what they change.
- Reviews, memory, history, marketplace and connect search with the same `/` box as `/customize` and `/settings`: same keys, same match count, same hint row; `esc` clears the box before it leaves the page. The wheel now also scrolls history, keymap, prompt mode and compaction. See [pages](docs/layout.md#pages-one-set-of-keys).
- Home > Input position puts the chat input at the bottom, centered under the logo or at the top of the start screen.
- Logo fonts rounded, double, shade and braille.
- Footer packs: the footer's whole look in one data file, chosen with `/footer pack NAME` or Footer pack in `/customize`. Built in: `clean` (the new default: folder and branch, then model, effort and context), `powerline`, `minimal`, `badges`, `bars` and `plain`, each with a words-only form. Parts like changes, running shells, cost or a low quota show only when they matter, and the context changes colour at 70% and 90%. A footer you made yourself is never covered; `footerPack: off` brings back the previous footer. Profiles can ship packs. See [customize](docs/customize.md#footer-packs).
- With the status line in the prompt's border, the activity takes the place of `READY` there instead of a row of its own, and the footer no longer repeats the model, effort, context or branch.
- With `MENDCODE_BROWSER_EXTENSION=1` the model can work in your own Chrome, Arc, Brave or Edge, in a "MendCode" tab group and background tabs, on sites you allow. It asks before installing the extension. See [browser](docs/browser.md#your-own-browser-extension).
- The PR reviewer measures MendCode's own pull requests (start-up, memory, size) and puts the table in the review; a rise above the noise is a critical finding. `prReview.perfAttrib: false` turns it off. See [PR review](docs/pr-review.md#performance-of-mendcodes-own-pull-requests).
- `/reviews open <job id>` opens a PR review's reviewer session, and a running review shows its phase in `/reviews`. See [PR review](docs/pr-review.md).
- `@mendcode review full` reviews the whole PR; plain `@mendcode review` reviews only what is new since the last full review. See [PR review](docs/pr-review.md).
- The PR reviewer sends data, results and generated files to readers on a cheap model (or a local summary) instead of reading them whole; `readers` in `.mendcode/review.yaml` sets how many read at once. See [PR review](docs/pr-review.md#data-files-and-readers).
- The PR reviewer's own tokens show in `/usage` as the `prReview` role. See [usage](docs/usage.md#auxiliary-calls).
- `budget.tokens_per_diff_token` scales a review's token cap with its diff. See [PR review](docs/pr-review.md).
- `threads` and `sessions` ask for up to 100 sessions (10 by default) and take `query`, `state` and `project` filters. See [peers](docs/peers.md#sessions).
- `/loop` understands phrases in Spanish and English (`/loop cada 5 minutos ve diciéndome`, `/loop daily at 9am check the issues`) and asks for one line of confirmation before it starts; with no interval it paces itself (`adaptive`), and a schedule it cannot read is converted by the small model. The strict form (`/loop every 30m …`) is unchanged. See [loops](docs/loops.md#natural-language).
- A loop starts with the permission mode of the session that created it (never more): from full access it asks nothing, and a report-only loop reads any path like its creator. From a session that asks, it reads what that session could read and asks about the rest; the footer shows `needs input` and `/loops` shows the request and answers it with `a`, `o` or `x`. A run nobody answers ends with a clear message. See [loops](docs/loops.md#permissions-and-approvals).
- Every loop run leaves a short notice in the session that created the loop, with a link to the loop's session; it starts no model turn and the model reads it with your next message (`/loop open <id>`); `notify: none` turns it off. See [loops](docs/loops.md#notices-in-the-creator-session).
- Accepted and applied plans are saved as Markdown files per project (outside your repository unless `plan_files_location` is `repo`). After a compaction the agent is told where its plan is, other sessions list and read plans with `sessions plans=true`, and the `todo` list keeps the plan's steps up to date. Balanced and full; Claude Code's own plan file is used as is.
- Sessions can list, message and open sessions in other projects, like Claude Code's ListAgents and SendMessage: `sessions scope=all`, `tell` and `threads message` to any session, and `threads start` for a new session in another folder with a first message. Each of those asks you every time, the receiver gets the message marked as an agent's from another project, and nothing is ever above the sender's permission. See [peers](docs/peers.md#other-projects).
- Approving a plan (Enter, or comment then apply) now runs it with full access, as Claude Code does when it leaves plan mode; `m` on the plan page picks auto edits or ask before edits instead, and the page and the "Plan mode off" notice name the access. See [plan review](docs/plan-review.md).
- The assistant is told what the terminal draws according to the tier: full gets the Markdown, Mermaid and callout syntax and when to use each, balanced one short line, minimalist nothing.
- `/btw history` lists the side chats you cleared and opens one to read. The row under the side chat's name says how much of the session it sees and how much of its prompt came from the cache. See [/btw](docs/btw.md).
- Full tier: memory works by itself. Saved facts reach prompts, decisions and the state of the work are proposed after turns, and the nightly Dream saves what passes its checks. See [memory by tier](docs/memory.md#memory-by-tier).
- Full tier: a new chat opens with a short note of what your latest sessions, in this project and others, were doing.
- Dream picks up where it stopped when the daemon was stopped mid-run.
- `/cd`, `/add-dir` and `/attach` complete paths as you type: Tab walks into the highlighted directory.
- The assistant replies in the language of your latest message (English when unclear) and no longer switches language on its own.
- `mendcode usage recover` adds the token usage of a Claude Code, Codex or Pi session log to Usage, with a preview first and
  an undo. See [usage recovery](docs/usage-recovery.md).
- The advisor sees the images attached to your request and can answer with a short code snippet or ASCII sketch. See
  [advisor](docs/advisor.md#what-the-advisor-sees).
- `/pr setup` checks prerequisites and configures repository reviews and publishing with one confirmation; a headless setup command is also available.
- `/voice setup` guides dictation readiness and explicitly confirms audio uploads before enabling an API provider.
- `/graph setup` enables and builds the project's code graph with one confirmation, without changing global defaults.
- Tool design (`toolDesign` in `/customize`): one choice that changes the whole look of the tool cards. Besides the default, `branch` (a bullet per call and a branch under it) and `terse` (no rule, plain diff signs); a profile can bring its own as `tool-designs/<name>.json`. See [customize](docs/customize.md#scrolling).
- Each turn ends with a dim line under the answer: how long it took, when it ended and which shells or sub-agents still run. `timestamps` is now `bottom` (that line), `top` (the time over each message) or `off`. See [customize](docs/customize.md).
- Three or more shell commands in a row fold into one `Ran 6 shell commands` row that opens on click, like reading calls.
- The `defaultContextWindow` setting gives one context window to every model that has none of its own; a model's `modelContext` window and `/context-window` still win. The assistant now finds how to change a context window, a model, a theme or a title from `mendcode docs change` without reading MendCode's files.

### Changed

- GitHub releases read short: a line of summary, "What's new" (up to eight highlights, so put the main items first in each section), short Fixes and Changes, and the rest folded. Titles are `MendCode v0.0.4`, `MendCode v0.0.4 Beta 1` and `MendCode Nightly`. See [releases](docs/release.md#release-titles-and-notes).
- Nightlies are one release, "MendCode Nightly", that each build replaces, instead of a release per build; `mendcode upgrade --channel nightly` and the installers work as before, but only the latest nightly can be installed by its exact tag. See [releases](docs/release.md#channels).
- Unused worktrees are cleaned by default: clean, merged ones idle for 14 days go in the daily pass (`worktreeGcDays: 0` turns it off). Worktrees of workflows, merges, compound runs and loops are included, and a compound run that changed nothing removes its worktree when it ends.
- `mendcode worktrees list` answers at once and `size` shows its progress, however many large worktrees there are; sizes are measured with `du`, scans stop when the client leaves, and identical scans are shared.
- The blobs scan skips loose files such as `.DS_Store` instead of failing to prune snapshots.
- `bun run build` deletes the leftover `.bun-build` temp files from its output folder.
- Image generation uses GPT Image 2.6 (2.5 if your account lacks it), and `image_gen` can make transparent PNGs. See [tools](docs/tools-web.md).
- Inside a sub-agent the chat says so everywhere: one line under the top edge with its name, state, parent session and the keys back (also with the top bar off, and alone in the `minimal` tier), its row in the Agents strip filled, and the prompt in its colour with a hint of whom a message goes to.
- The compaction card keeps its frame and shows no spinner of its own while the activity line shows one, so only one loader runs.
- A PR review that reaches its token cap now posts a partial review of what it verified and lists what it did not review, and the next `/pr review` continues with the rest. See [PR review](docs/pr-review.md#a-review-that-reaches-the-cap).
- `/pr review` (and `@mendcode review`) of a head already reviewed with the same config answers at once and runs nothing; `/pr review <n> full` reviews it again. See [PR review](docs/pr-review.md).
- The `/customize` preview draws what the picked row changes: the home with the pet, a sample chat with the top bar, the prompt with its status line and your real footer, the activity, the diff.
- Numbers in `/customize` edit with Enter and step with the arrows.
- With your own footer rows `/customize` says so and hides the one-row footer parts, and the model edits your rows instead of replacing them.
- Folder profiles are now called areas: `mendcode area add|list|remove` and the `areas` setting (the old `profiles` setting is still read), and `mendcode profile restore` is `mendcode customize restore`. See [areas](docs/areas.md).
- Packages are now called profiles: `mendcode profile ...`, `/profiles`, the `profiles` tool and `mendcode-profile.json`. The old names (`mendcode package`, `/packages`, `/pkg`, `mendcode-package.json`, `disabledPackages`) still work. See [profiles](docs/profiles.md).
- The notice for an installed update now reads `New build installed · /restart to switch`, and the message that resumes work after a usage limit lifts is worded in MendCode's own voice.
- `/context`, the footer and the sidebar show the same used / compaction point for a session, before and after the first message; `/context` uses the provider's count of the last call (images are estimated at 1,500 tokens each) and says whether the figure is measured or estimated. With Claude Code the point is the one its process was given, the model window is listed apart, and a changed `claude_compact` point restarts the process at the next turn. See [Claude Code](docs/claude-code.md).
- The session lists of `threads` and `sessions` (and the plan list, and other programs' chats) are shorter: one header, rows grouped by project, short ids that every tool accepts, ages like `3m`, and the state only when a session is busy.
- A wide flowchart is drawn in the chat instead of shown as source: long labels wrap (`<br/>` still breaks a line), spacing tightens, and a left-to-right flow turns top-down when it still does not fit. The note says what was tried when nothing fits.
- Full tier: the Git page's push, publish and pull request are on by default (`/experimental git_actions off` turns them off); each one still shows its command on a card and waits for Enter. Balanced keeps them behind the switch. See [git](docs/git.md#the-switch).
- A session with a `/goal` now has the goal tools in its request in every tier, so the agent can mark the goal complete or blocked without searching for the tool first; sessions without a goal are unchanged.
- The computer-use cursor is now the size of your own pointer, about half of what it was, and follows the Accessibility cursor size.
- The balanced tier's prompt is about 240 tokens lighter: its description of the terminal's drawing is one sentence instead of the full block.
- The tools a `/btw` answer runs look like the transcript's tool rows. The side chat is read-only in every permission mode: only read-only commands run, never `touch`, `mv` or a redirection into a file; set its model with `models.aside`.
- The activity line reads like Claude Code's: `⠋ Running command… (2m 53s · ↓ 88.6k tokens)`. `activityStyle` brings back the older look (`classic`) and `activityTokens` adds the sent and cached token figures. Token counts are the provider's exact usage, with no `~`.
- The full view's footer without a pack is one row (directory, model, effort, cache, quota, code graph) without repeating the context; `/footer preset rows` gives the five rows.
- Each running sub-agent task in the Agents strip says how full its context is (not Claude Code's own sub-agents). Opening a sub-agent draws a full border around its view and keeps the Agents strip, with the open one marked.
- Commands the assistant leaves running in the background or in a terminal no longer stop after a few hours or when left untouched; they run until they end, you stop them or the chat is deleted. The `processLimits` setting (`lifetimeMinutes`, `idleMinutes`) adds a cap if you want one.
- Compaction while idle follows the prompt-cache lifetime the provider's responses show, not a fixed five minutes, so ChatGPT and OpenAI sessions are compacted less often when their cache lasts longer. See [prompt cache](docs/prompt-cache.md#observed-lifetime).
- After a compaction the assistant still knows which commands are running and can read their output.
- Edit, write and patch cards no longer draw a vertical rule beside their body (`toolRail` brings it back for any tool), show three unchanged lines around each change (`diffContext`) and cap a very long line at a few rows (`diffLineRows`). A Write through Claude Code shows its code as added lines.
- A running shell call names its command in the activity row from the start.
- Images you pasted and never sent are deleted from disk after a week.
- With chat encryption on, MendCode starts faster, uses much less memory, and no longer rewrites the encrypted database when nothing changed.
- MendCode uses less memory right after it starts.
- Answering a message takes much less memory, most of all the first one of a session.
- A terminal that runs MendCode in one process holds less memory, and building a project's code graph is no slower for it.
- Short messages and short turns take less disk.
- Finished turns are stored compressed in the background, so sessions take much less disk, and search, stats and session
  recall run faster.
- MendCode keeps its data in `~/.mendcode`. The first start moves `~/.mendcode-v2` there and leaves a link with the old name,
  so sessions, settings and sign-ins carry over. `MENDCODE_DIR` names another folder; `MENDCODE_V2_DIR` still works.
- A terminal that hosts the daemon, and a separate daemon, hold less memory at the prompt.
- The current-task row above the prompt is gone; the dock's Jobs panel is opt-in and Todos wrap with more room.
- Long command replies open a readable page (F4 shows the full text of a cut notice), and `/pr repos` lists repository
  watches in a page where they can be stopped and restarted.
- Completed streaming output uses less session storage while preserving historical cuts and reconnect replay.
- Session history takes less disk: each event stores its session, number, time and type once, and existing history is
  converted in the background while the daemon is idle. Forked sessions also store less. Short sessions now take less disk
  than a Pi session file.
- A finished short session stores fewer rows: settled state snapshots, empty file snapshots and request profiles take less room.
- New session, turn and item ids are shorter, so every stored row takes less room; existing ids keep working.
- Opening a session and starting a turn read the transcript and model history faster.
- The terminal uses less CPU while a reply streams in.
- `--help` says which `--process` mode uses less memory.
- Compaction uses the session's own model by default, so it reuses the prompt cache; the built-in recipes no longer set a
  `compaction` role, and `/models` notes when a separate compaction model gives that up.
- The working row's token count shows new input and the context read from the provider's prompt cache separately.
- The code graph autopilot refreshes the graph when a lot of code has changed, not after a number of edited files. See
  [code graph](docs/code-graph.md#autopilot).
- The full view's footer is the `clean` pack by default; `footerPack: off` brings back the one-row `line` footer, and `/footer preset rows` the five-row layout. Balanced and minimalist are unchanged. See [layout](docs/layout.md#footer-by-tier).
- The advisor no longer signs off small turns, such as a config value or a one-line fix; the agent can still ask it. See
  [advisor](docs/advisor.md#when-it-is-consulted).

### Fixed

- Exporting a long session keeps how it ends: the oldest turns are left out (and the export says so) instead of the newest.
- Current Claude models on Amazon Bedrock work at every `/effort`: they get adaptive thinking instead of a token budget they reject. Older Claude models are unchanged.
- Shell commands the model runs no longer leave memory behind in the daemon.
- With the Claude Code engine, smart mode lets edits inside the project run without asking, as it does with the native engine.
- Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable and the other current models work with an Anthropic API key at every `/effort`: they get adaptive thinking at that effort instead of a token budget they reject. Older Claude models are unchanged. See [providers](docs/providers.md).
- A turn a daemon restart interrupted resumes even when messages were waiting behind it; they follow the resumed turn instead of staying held.
- A held queue says why: your cancel, the restart or an interruption.
- `mendcode daemon restart` starts the next daemon itself: open terminals wait for it instead of starting one with their own environment. A daemon started from a Rex block no longer carries that block's `REX_SESSION` and `REX_BLOCK`.
- A pull request with a very large diff of data or generated files is reviewed instead of refused for its size: data files are set aside for readers before their content is read, and the size limit applies to the code that is left.
- A push reviews only what changed since the last review of this login on the pull request, also on a device that has no saved state; the summary names that head.
- A review that failed for good is not queued and announced again at every daemon start; `/reviews` still shows it and `r` retries it.
- `/reviews` opens even when a checkout is slow to answer: it shows the jobs and names the checkout it could not read.
- A PR review whose verifier gave an unusable answer is retried, verifying the findings it had without reviewing the diff again, and its error says what the verifier answered.
- A narrow footer row cuts its text segments (the tagline, the directory, the branch) with `…` instead of dropping the tagline whole.
- The jump-to-latest pill no longer covers the last line of text: when that line reaches it, the pill takes a row of its own.
- The summary printed on exit shows prompt tokens apart from cache reads and writes (`↑52K +488K cached ↓2,389`).
- A settings proposal (`mendcode_settings`) waiting on its card from Claude Code answers `Pending` instead of "The operation timed out", and a headless session's proposal is shown on the session that started it.
- Smart mode runs a project binary given by path (`../../node_modules/.bin/tsc`) like the command it names, and an `echo` of `$?` no longer counts as a shell expansion.
- `mendcode --restart-daemon` only stops a process that is a MendCode daemon for that data directory; a stale `mendd.lock` whose pid was reused is reported and left alone (a dead owner's lock is removed), and the command restarts the daemon and exits instead of opening the terminal (#2).
- A turn that shows nothing (an idle compaction with nothing to compact) no longer adds a second "ended" line under the answer.
- `mendcode run` and `session send` accept a long prompt or a long `--file` text (up to 200 KiB each): what does not fit a message goes as a text attachment and the model reads all of it. Over that, the error names the prompt or file, its size and the limit, and "daemon rejected" for a text that is too long now says the same. See [attachments](docs/attachments.md#long-text-from-run-and-session-send).
- A PR review that finishes before you answer `/pr publish` is kept, also across a daemon restart, and `/pr publish on` posts it as found; if the pull request moved on, it says so and posts nothing, and it says when no finished review was waiting.
- `/pr setup` and `mendcode pr setup` on a tier without the PR reviewer now apply once confirmed (they also allow the reviewer with `features.pr_review: true`; the tier is not changed); when something blocks it, the output ends with "Nothing changed". On a development daemon it says the watch is recorded and does not run.
- Smart mode resolves relative paths in a shell command against the directory it runs in (the call's `workdir`, then each `cd`), so `../../node_modules/.bin/tsc` from `packages/widgets` no longer asks as "outside the project". A path that really leaves the project still asks.
- PR review readers on Claude Code are no longer stopped at their token bound after they have already answered: the bound now covers the harness's own prompt and the model's thinking, so the data summaries come from the cheap model instead of a local scan.
- `glob` takes up to 32 patterns per call, and a longer list says so and how to split it.
- PR review readers never run on an ACP harness model (such as an OpenCode one listed under the ChatGPT login): they use the cheap model of the reviewer's own provider.
- A PR review whose data files were summarized by readers is no longer stopped as "could not review" because the model noted it saw summaries or could not run tests: with findings, or a walkthrough, it goes on to verify and publishes with the model's note. The review prompt now says the data arrives summarized and that there is no shell.
- In a Claude Code session, `mendcode run` from its shell is known as that session: `--file` attaches instead of being refused, and `--permission smart` above the session's mode asks you on the approval card.
- `mendcode run --file` from a session's own shell attaches the files instead of being refused.
- PR reviews and report-only loops are no longer told about plans when they try a change (MendCode's own engine and Claude Code), and Claude Code runs them outside its plan mode, so a reviewer never mistakes plan mode for a limit on its review.
- A PR review whose diff does not fit its token budget stops before it spends: it says so up front, or before the next part of a large diff, instead of after. See [PR review](docs/pr-review.md#budgets-quotas-and-accounting).
- The solid logo font draws square letters, and `/customize` rows no longer cut or run together.
- The green and red tint of changed lines in a tool card's diff starts right at the card's rule, with no gap of background before the line number.
- PR review notices link to the pull request (and the review they name) on GitHub, and show a job by a short id with the `/reviews open` hint, so narrow terminals keep the important words. See [PR review](docs/pr-review.md).
- Computer use on apps whose content is a webview (Tauri, WebKit, Electron): the page's content is exposed, a key reaches the app when no node can take focus, and a thin result tells the model to look again before giving up. See [computer use](docs/computer.md).
- The folders MendCode makes in the system temporary directory for Claude Code, Codex and ACP sessions are removed when the daemon stops, and a daemon that died leaves none behind: the next start clears them.
- `--safe-mode` against a daemon not started with it names `--safe-mode` in its refusal, not `--pure`.
- A repeated `/pr review` joins the review already running, and one comment gets one notice however many watches the repository has.
- A review that cannot read the change ends as incomplete without verifying, and no longer says "nothing was posted: no new findings".
- A thread reply such as `Fixed in <head>` no longer counts as a review of that head.
- A message with comments stays a card under your own `message.user` view unless the view declares `handles: ["comments"]`, and the pinned prompt row and the message list show it as `1 comment` instead of its tags.
- `mendcode package check` no longer reports network or file use for a value such as `claude-sonnet` or `magnet`: only imports and requires of those modules count.
- PR reviews, report-only loops, read-only workflow tasks and side chats on Codex, Pi, ACP and Claude Code are no longer told to present a plan.
- Esc Esc on a message nobody answered yet brings it back into the prompt at once with its images, even with a draft or a queued message behind it; when it cannot, the notice says the model already answered.
- A report-only loop run no longer waits on "Review plan": it is not offered the plan tools or the plan mode note, and writes its report as the answer.
- Applying a plan on Claude Code or an ACP agent lifts the plan agent's read-only limit at once, so the next write in the same turn is allowed, and the session moves to the plan's destination agent.
- Leaving plan mode with Shift+Tab or `/plan` returns to the mode the session had before it.
- A plan review that ends with no decision (the daemon restarted, the request was cancelled) tells the model it was interrupted, not that you rejected the plan.
- Plan mode on Claude Code, Codex, pi and ACP agents names the model that really plans (the session's), and those engines are reminded on every plan turn that the session is read-only and the plan is for your review.
- The Plan review page draws the plan like the chat does (diagrams, callouts, tables), scrolls with the wheel and trackpad, and holds its drawing while you scroll.
- Applying a plan against a daemon older than the access choice works: it is applied once without the choice and the page says to run `/daemon restart`.
- The activity line of a Claude Code or pi session shows the tokens received while the turn runs, not only when it ends.
- The footer says plan mode once instead of `Plan · plan mode`.
- A shell card shows a command's output as it printed it: indentation and blank lines stay.
- `/plan <text>` enters plan mode and sends the text as your message.
- Approving a patch shows the files it touches over the diff, without the raw patch JSON.
- Computer use works once Accessibility is on: the helper is now "MendCode Computer Use.app" with a fixed name and path, macOS lists it by itself and System Settings opens on the right pane when a tool needs it. No path to paste. Old "mendcode-computer" entries in Accessibility can be removed with `-`; see [computer](docs/computer.md#setup).
- Memories no longer pile up in Pending when Dream runs on schedule or from `/dream`: the full tier consolidates them, and a Dream run stopped by a restart no longer blocks its project.
- Dream uses your `small` model when no `dream` model is set, instead of the main one.
- A value pasted in `/env` is always masked: pasting on the list opens the add form, and the name field only takes name characters.
- With Caps Lock on, the letter shortcuts of settings and of the pages work as without it; capitals with a meaning of their own, like `G` or `J`, keep it.
- `mendcode session attach ID` opens the session like `mendcode attach ID`.
- `mendcode --help` is one grouped list of every command, and the help of every command fits 80 columns with one usage line.
- The code graph's "tokens saved" compares each lookup with what you would have used instead (a grep, a line range, reading the file) rather than with whole files. The project map shows none. See [code graph](docs/code-graph.md#how-the-saving-is-estimated).
- graft's own "tokens saved" line is no longer added to `/usage`, the footer or the map card.
- The "tokens saved" of command output filters no longer counts output beyond what the model would have been shown.
- A Claude Code turn after a cancelled one whose background command still ran no longer fails with "`claude` was not
  found"; a Claude Code that refuses to start shows its own reason.
- Claude Code's reports about background tasks of an earlier or ended process no longer arrive as messages for the model.
- Switching between two MendCode models after a failed or cancelled turn no longer says the conversation came from
  Claude Code, and no longer adds that turn to the history twice.
- Sub-agents on every engine no longer get the advisor, workflows or sub-agents of their own; `subagentDepth` above 1
  still lets them delegate.
- While the advisor runs, the working row says "Consulting advisor..." instead of "Patching..." or "Running command...".
- The advisor no longer takes an image read during the turn for your request, and sees the turn's edits and the checks it
  ran, so it stops asking for evidence the turn already has.
- Esc in a page opened from another (Settings, then Disk usage) goes back to that page instead of leaving to the chat.
- The mouse wheel and trackpad scroll every page with rows or text, including Usage.
- Enter or space turns the pet off from `/pet`, trusts a project in `/tools` and `/hooks`, and switches the IDE bridge on or off.
- Closing MendCode quickly, or with Ctrl+C or a termination signal, no longer leaves part of the screen painted.
- With Claude Code, a background sub-agent's commands stay in its own thread: they no longer show as a message of the main agent, change the working row or hold queued messages back.
- A queued message with comments comes back to edit as your text and its comment chips, and goes out again with them; the queue never shows their markup.
- A Claude Code sub-agent's thread has its own prompt and queue: the conversation's draft and queued messages wait untouched until you return.
- An automatic PR review checks that it may post, and that no other reviewer already has, before it spends any tokens.
- The advisor sees a short summary of the session (earlier edits apart from this turn's, this turn's checks) and the untracked files, and the executor can pass it files with a line range and images; the extra evidence is capped and says what was cut.
- `@MendCode review` gets no extra reply when this reviewer's own review of the head was posted after the comment.
- `@mendcode review` no longer counts the empty review GitHub records when someone replies in a review thread as a review of
  the head.
- Session titles name what you asked; a model no longer answers your message in the title (such as saying it cannot see an
  image).
- Asking to rename the title renames the session, not a part of the screen.
- Ask any model to change the default model, tier or permissions and it proposes the change for you to approve, instead of
  telling you to do it by hand.
- OpenCode Go answers again: every request carries the session it belongs to, as Go now requires. OpenCode Zen gets it too.
- Preserve terminal preferences and settings across versions, keep recovery history, and guard against accidental downgrades.
- Changes to a file saved twice in quick succession are no longer missed by model lists, config files, the file viewer or code graph
  excerpts.

### Upgrade notes

- `timestamps: true` in your profile reads as `bottom`: the time moves from over each message to the line that closes each turn. `/timestamps top` brings back the old look.
- A `~/.mendcode` left by MendCode v1 is renamed to `~/.mendcode-v1`, nothing deleted, and OpenCode's folders that pointed
  into it follow. A terminal of the earlier version still open keeps the move for the next start.
- Earlier versions cannot read session history written or converted by this one. Keep a copy of the data directory before
  upgrading if you may need to go back.

## v0.0.3 - 2026-11-02

`/memory` follows the same page standard as `/changes` with a graph drawn in braille links, `mendcode --version` names its channel,
and the code graph autopilot can be turned on in the full tier.

### Upgrade notes

- Same code as v0.0.3-beta.1. The code graph autopilot is off in beta and stable; `/tier graph_autopilot on` turns it on in the
  full tier.

## v0.0.3-beta.1 - 2026-11-02

`/memory` follows the same page standard as `/changes` with a graph drawn in braille links, `mendcode --version` names its channel,
and the full tier gains a code graph autopilot (on by default only in nightly builds).

### New

- **Code graph autopilot (nightly only by default).** In the full tier, MendCode builds and refreshes the code graph of a real
  project by itself, in the background, so the model finds code through the graph without having to remember to build it. It never
  builds in the home folder, system folders or very large projects, and `/graph on|off` still decides. The footer's graph segment
  shows the progress. It is on by default only in nightly, dev and local builds; in beta and stable turn it on with
  `/tier graph_autopilot on`. Minimalist and balanced are unchanged. See [code graph](docs/code-graph.md#autopilot).

### Changed

- `mendcode --version` says which channel the binary is from: stable, beta, nightly, or a local build.
- `/memory` follows the same page standard as `/changes`: every tab has the same header with the keys and counts, and the History,
  Loops and Memory sub-pages are titled like the other pages. The Graph tab shows a **Graph** box beside a **Memory** box for the
  selected memory, with links drawn between memories, colors by category and a legend.
- The README screenshots are full-screen renders of the real views.

## v0.0.2 - 2026-11-01

The second stable release: everything in the v0.0.2 betas, from MendCode's own ChatGPT login and an advisor model to a visible
plan, plan mode as in v1, voice dictation, credentials pasted into `/env` and fewer prompt-cache misses.

### Upgrade notes

- Stable installs move from v0.0.1 with `mendcode upgrade`; beta and nightly installs already have this code from
  v0.0.2-beta.4 and the nightly of the same day.

## v0.0.2-beta.4 - 2026-11-01

MendCode signs in to ChatGPT for itself with Sign in with ChatGPT and keeps its own list of the models your account can use, and
Claude models on a new install run in the Claude Code you already have signed in. A second model can advise the first (`/advisor`),
the agent's task list stays visible above the prompt, plan mode works as in v1, credentials can be pasted into `/env`, and fewer
requests miss the prompt cache.

### New

- Advisor: `/advisor <model>[#effort]` names a second model that the main model consults through an `advisor` tool and that is also
  consulted before a plan is shown, after the same call fails twice and before a turn that edited files closes. It is available in
  balanced and full and off until you pick a model; `/advisor off` turns it off and `/advisor` shows its status. A Claude Code model
  (`/advisor claude-opus`) can also advise a native session on your Claude subscription. `/model` has an advisor row and the AI
  config page shows the status ([advisor](docs/advisor.md)).
- A visible plan (balanced and full, `/tier visible_plan off` hides it): while the agent's task list has open items, one muted row
  above the prompt shows the item in progress and how far the list is (`▸ Fix the parser · 3/7`). Ctrl+t opens the whole plan. Claude
  Code, Codex and ACP agent plans show in the same row. Minimalist has no plan row.
- Plan mode works as it did in v1: Shift+Tab or `/plan` enters it read-only, the footer names the plan model, and the plan opens a
  review where Enter switches to the build agent and its model and continues. Claude Code's `ExitPlanMode` opens the same review.
- Paste credentials into `/env`: paste one `NAME=value` or a whole `.env` and MendCode lists the variables it found (names only,
  with their status); choose all or a subset with space, `a` and Enter, and they are saved encrypted for the project (Ctrl+S for
  session or global). The pasted text stays in memory until you save or press Esc.
- Sessions know what MendCode can do: the model is told which tools it can load (image generation, computer use, memory, web,
  workflows and others) and what this terminal can draw, so it uses them instead of saying it cannot. Codex, pi and ACP agents get
  the same information and the `mendcode docs` pointer.
- Codex sessions get MendCode's own tools (code graph, image generation, computer use, memory and the rest) through the same bridge
  as Claude Code, with one approval: MendCode's. Gated like Claude Code by `harness_tools` (balanced and full).
- Sign in with ChatGPT: `/connect chatgpt` (or `control-plane auth login --provider chatgpt --method browser --execute`) shows a
  link; you sign in in the browser, allow MendCode to use your ChatGPT plan, and MendCode keeps a login of its own, which you can
  limit or revoke in ChatGPT → Settings → Usage. The link stays open 15 minutes. Requests on that login go to `api.openai.com` and
  count against your plan.
- On new installs MendCode's engine signs in to ChatGPT only with `/connect chatgpt` and does not read the Codex CLI's login file
  (`ownLogins`). Installs set up before keep it as a fallback.
- PR review: `.mendcode/review.yaml` can start from a preset (`preset: balanced | quiet | strict | on-request | autofix`); the
  file's own keys go over it, and no preset turns posting on, adds checks, widens who may post or pushes.
- PR review: `budget.tokens_per_pr: null` means no internal cap, and `budget.context_tokens` bounds what one call carries,
  apart from the PR's total.
- PR review: `/reviews` (or `/pr dashboard`) opens a page of review jobs, reviewers and watches. From it you can pause, resume,
  cancel or retry a job, take a job over and release it, and show a job's config.
- PR review platform:
  - A review stopped by its token budget, a quota or a rate limit keeps what it found and resumes on retry, or after the quota
    reset with `on_quota: wait`.
  - `mode` and `filters` decide which PRs are reviewed; `/pr list` shows the reason for each PR not taken.
  - `.mendcode/reviewers.yaml` routes PRs to the global reviewer and to personal reviewers. A personal reviewer whose MendCode runs
    elsewhere waits, and its own daemon reviews the PR when it starts. Device claims on a PR are best-effort.
  - Personal profiles can only narrow the repository's config, and the config actions and the `review_config` tool always need a
    scope.
  - Review memory follows the reviewer's scope.
  - `fix.mode` `fix-once` and `fix-loop` push only with `fix.push` and `/pr publish on`; otherwise the fix is kept on a local ref.
  - A stacked PR is reviewed on its own commits, and token use is counted per PR head.
  - An audit of the whole checkout stays in the session; it is a `pr.review` action, with no slash command.
  - GitLab (through `glab`) and Gitea / Forgejo (`GITEA_TOKEN`) are supported: the daemon watches, posts reviews, answers
    `@mendcode` and pushes fixes. They have no check follow-ups and no hosted runner, and Gitea has no thread resolution
    ([providers](docs/pr-review.md#providers)).
  - `template.language` (default English, set by the repository only) is the language of every review, verify, fix and
    `@mendcode explain` reply. With `auto`, a PR is reviewed in its author's language; a short, mixed or unclear text is English.
  - When a watch starts, after a daemon restart and after a pause or outage, open PRs whose head has no review yet are reviewed,
    newest first: at most `backlog.max_prs` (10), updated within `backlog.window_days` (30). `/pr watch-repo` lists what it queued
    and what it skipped, and `max_prs: 0` turns this off.
  - Set up PR review with your session: `review_config` `setup` reports what exists, what is missing and the questions to ask. It is
    read-only.
  - The `pr_review` tool reviews a PR now from a session (`review` asks your approval outside full access, and `status` lists the
    jobs). It posts only as `/pr publish` allows.
  - `.mendcode/reviewers.yaml` capabilities `review`, `fix` and `publish` are enforced, and a reviewer without the list has all
    three. A `requested` watch also takes PRs that area or label routing gives its login's personal reviewer.
  - Logins in `reviewers.yaml` and in `review.yaml`'s `reviewers` and `publishers` follow the checkout's forge, so GitLab and Gitea
    usernames with `_` or `.` can be listed.
  - A diff too large for one call is reviewed in parts.
  - A team setup guide covers the hosted workflow, an always-on server with personal reviewers on laptops, and troubleshooting
    ([team setup](docs/pr-review-setup.md)).
- `grep` takes `context` (0 to 5) to return the lines around each match, so one search can replace the read that would follow it.
- `edit` takes `edits: [{oldString, newString}]` (up to 50) to make several replacements in one file in one write. If one does not
  match, nothing is written and the call says which.
- Mermaid flowcharts with `subgraph` are laid out in layers, each subgraph drawn as a titled frame and nested subgraphs as nested
  frames. A left-to-right diagram too wide for the chat is drawn top-down.
- PR review: `prReview.concurrency` (1 to 4, default 2) sets how many reviews this device runs at once, across every watched
  repository. It is a per-device setting, and `/pr watch-repo list`, the status and `/reviews` show it
  ([concurrency](docs/pr-review.md#concurrency)).
- PR review: an opt-in offline fallback (`routing.offline_fallback` in `.mendcode/reviewers.yaml`) lets a global reviewer take a
  PR a personal reviewer has not claimed or reviewed within the set minutes. Without the key nothing changes.
- Setup: sign in from the page. Up from the Model row reaches the ChatGPT login and API keys; Enter runs `/connect chatgpt` or
  opens `/connect`, and closing it comes back to setup with the new models on the Model row. Ready groups MendCode's own engine
  (ChatGPT login, API keys) apart from the external harnesses that keep their own login (Claude Code, Codex, pi).
- Setup: Space on the Model row lists every model found, grouped by who runs it: MendCode's own engine, then the Claude Code, Codex,
  pi and ACP harnesses. Enter picks one; the list also holds `Sign in to ChatGPT` and `Add an API-key provider`. The Model row names
  who runs the model (`Opus · Claude Code`).
- The model can read another session's conversation in one call: `sessions read=<session id>` returns its messages, oldest first,
  one line per tool call, in pages. An exact id may name a session of any project of this MendCode
  ([peers](docs/peers.md#read-one-sessions-conversation)).
- `/usage` shows the model calls MendCode makes outside your turns: session titles and summaries, `/recap`, memory extraction,
  the Memory assistant, Dream, the permission reviewer, `prompt` hooks, generated agents and the setup helper. The Models tab has an
  "Auxiliary calls" panel, and `mendcode usage`, `mendcode stats` and `--json` (`auxiliary`) list them too. They stay out of the
  turn totals ([usage](docs/usage.md#auxiliary-calls)).

### Changed

- The start screen's title is MendCode's infinity logo, drawn in half blocks (plain ASCII under `glyphs ascii`) with the name
  under it. A logo text or font of your own still draws those letters; a small terminal shows the name.
- Setup uses the whole terminal: the preview takes the rest of the width and the full height with its prompt at the foot, as in the
  chat. The Tier row says what its value gives even unfocused, and lists the tiers when focused.
- Computer use: `tools.batch({revision, steps})` in `computer_code` runs up to 16 actions on one observation in one call. Every step
  is checked before the first is sent, the first failing step stops the batch, and each step reports its outcome, delivery and
  whether a retry is safe ([batches](docs/computer.md#batches)).
- Computer use shows a new cursor: a white dart with a pill naming the action, a click ripple, an outline around the element acted
  on and a trail for drags. It moves like a hand, faster than before, and rests when idle.
- Computer use observes windows faster.
- Computer use: a failed action says whether its input can have reached the app, ending with "not delivered" or "delivery unknown".
- The row under the prompt reads left to right in groups: `Build · GPT-6-Luna · high · fast · native │ ↻ 1 loop │ ~12 turns to
  compact`. Balanced names the reasoning effort and `/fast` beside the model; the full view adds a second row with the code graph,
  the session's cache share and the quota windows. Minimalist has no such row. Narrow terminals shorten the row, keeping the agent
  and any permission that acts without asking. Screen-reader mode uses plain words and ASCII chrome a plain `|`. Every footer
  segment declares where it shows by view ([layout](docs/layout.md#footer-by-tier)); `/footer reset` returns to the view's own
  list.
- Reasoning effort is on by default in the footer (`showEffort`), and `/tier balanced|full` turns it on. A terminal profile saved
  before keeps its value: Customize > Prompt & footer > Reasoning effort, or `/tier balanced` again, shows it.
- Release titles name the channel and version ("MendCode v0.0.2 Beta 4", "MendCode Nightly — 2026-10-29 · Build 2"), and the notes
  list what changed since the previous release of the same channel, with install and verify steps and the full changelog folded
  away. Tags, assets and the updater are unchanged.
- PR review: reviews are durable jobs. A daemon restart finds the queued and running reviews and runs each once; a push during a
  review marks it stale and it is not posted; a failed review is retried with backoff.
- PR review: the default `budget.tokens_per_pr` is 1,000,000, and the review context is bounded by `budget.context_tokens`. A review
  stopped at the cap says it is incomplete.
- PR review: every posted review carries a reviewer marker, and a post that timed out is looked up on the PR before anything is
  sent again, so a slow GitHub answer no longer risks a second review.
- PR review: review children load no memory or instruction files of their own, and treat the checkout as untrusted, so a PR's own
  `.claude/` or `.codex/` settings, hooks and rules never load. Your user memories never reach a repository's reviewer. Only your
  own `~/.codex/AGENTS.md` still reaches a Codex review child.
- PR review: the reviewer's notices to the watching session are recorded without starting a model turn
  (`experimental.pr_review_prompts` brings the old behaviour back).
- PR review: a review, verify or fix turn has no fixed time limit. It is stopped as stalled after 10 minutes with no event from the
  model (a fix session waiting for your approval does not count), with a 2-hour cap. The job keeps its work and retries with
  backoff. Failure and stop notices name the repository, the PR, the head, the reason, the next retry time and the attempts left.
- PR review: a maintainer's `@mendcode review` on a head that was already reviewed is kept. The reply says the next push will be
  reviewed, and that head is reviewed even with `triggers.synchronize` off. A comment from the daemon's own login runs like
  `/pr review`, and what it is refused is said in the session only.
- PR watch: one watched PR ends only when it is gone or inaccessible for 15 awake minutes. A network outage or sleep never ends
  it.
- The daemon drops the Claude Code session variables it inherits when an agent starts it from a Claude Code shell, so a `claude`
  it starts no longer takes itself for that session's child. `ANTHROPIC_*` and your other Claude Code settings are kept
  ([Claude Code](docs/claude-code.md#started-from-claude-code)).
- `apply_patch` also places a hunk whose lines differ from the file only in spaces, and only `-` and `+` lines change the file. A
  hunk that does not match shows the file around its closest line, with `>` on the first line that differs.
- The tool definitions every request carries are as small as before these additions.

### Fixed

- Fewer requests miss the prompt cache: repeated `tool_search` calls on the ChatGPT backend, pruning of old tool results and the
  memory chosen for the system prompt no longer change the start of the request in the middle of a turn.
  `MENDCODE_DEBUG_PROMPT_PREFIX=1` makes the daemon log hashes of each provider request's parts, without content, to find what
  changed ([prompt cache](docs/prompt-cache.md)).
- `mendcode attach <session id>` opens that session in the terminal again; an HTTP URL still attaches to a server.
- On-device dictation with no language set listens in the first two languages of Language & Region at once (English and Spanish
  on a bilingual Mac). `/voice language` lists every language the on-device model hears by name, and takes one
  (`/voice language es`) or two to hear at once (`/voice language es en`).
- While dictating on this Mac the words appear as you speak, not only at a pause, and the row shows the language actually spoken.
- Dictation says when to start talking: holding space shows `starting… wait to speak` until the microphone listens. If the
  transcript does not come back, the words already heard stay in the prompt as a draft.
- Setup's Model row steps through every model found, including those of the Codex harness (also with `ownLogins`), and ACP agents'
  models are no longer listed as the ChatGPT subscription's.
- The pixel wordmark's N is drawn in full.
- A Claude Code session can run a sub-agent on another model (GPT-6.1 Terra, a Codex model). With the thread bridge on (full tier,
  `/tier thread_mcp on claude`), the model is told which models `delegate_task` runs, and Codex gets the same; without the bridge,
  MendCode's tools say how to turn it on.
- Model references as `mendcode models` prints them (`chatgpt/gpt-6.1-terra`, `claude/claude-opus`, `codex/codex:gpt-6-sol`)
  work wherever a model is named: a role, `/model`, `--model`, a sub-agent (`task`, `delegate_task`), `session create --model` and
  `run --model`. The assistant's `mendcode_settings` refuses a model role no catalog lists, as `/model` does, and says that a new
  main model is for new sessions.
- A sub-agent Claude Code starts on another model shows that model on its Agents strip row and thread header from the start.
- A finished turn no longer makes a hidden model call for a session summary. The summary is written only when something asks to
  show it: `/fanout compare` and `mendcode session inspect ID --summary` (`session_meta` tier, local only). Minimalist never writes
  one, and `agent.summary` keeps its prompt, model and `disable`.
- Session titles and summaries go through the budget like every other daemon helper: a reached `stopUsd` blocks them, an expensive
  model needing confirmation is not called unattended, and their spend counts in the ledger.
- Changing the default model while a session runs no longer breaks that session: the running turn finishes on its model, a session
  that already ran keeps its engine, and new sessions start on the new default. `/model` to another engine mid-turn applies from the
  next turn, and a model that another engine runs is never sent to a provider; the turn fails at once, saying where the model runs.
- A daemon started by a terminal in a tuios pane no longer carries that pane's identity, so sessions' commands do not speak to
  tuios as that pane. A terminal that hosts the daemon in its own process keeps it.
- `mendcode daemon status` says `not answering · process N holds the data directory` when a daemon holds the data directory but does
  not answer, and `daemon start`, `stop` and `restart` name that process at once.
- Claude Code, Codex and ACP sessions receive MendCode's notices (such as a PR review's summary) with their line breaks.
- `/reviews` words the age of an update correctly.
- Zod is updated to 4.6.6, which fixes a memory-exhaustion issue in 4.6.5 (GHSA-mrhx-c7xc-m3w5).
- PR review: `@mendcode review` on a head with nothing new names the head, says no new review was posted, and lists the earlier
  findings it resolved and the ones still open. Asking again after a fix closes the threads of the fixed findings; where GitHub
  does not let the account resolve a thread, one reply says `Fixed in <head>`.
- A notice a Claude Code or other external session did not see (a PR review's result) reaches its next turn whole.
- PR review: the `pr_review` tool no longer asks for approval in a full-access session, and its prompt reads "Review a pull
  request".
- A nightly run no longer fails when its run number is already taken by a nightly tag of the same day.
- Claude Code sessions: a background sub-agent stopped by esc stays in the Agents strip as `stopped by you · /relaunch`, and
  `/relaunch` asks Claude to start it again with the same prompt, told how far it got.
- Claude Code sessions: an agent Claude Code sends to the background on its own is shown and followed as a background agent.
- Claude Code sessions: the first message after esc stopped background agents is answered.
- The daemon finds `gh`, `git`, `claude` and `codex` installed with Homebrew however it was started, so a daemon restarted with a
  short `PATH` (launchd, systemd) no longer pauses PR review watches.
- PR review: a watch paused because `gh` is missing or logged out tries again every 5 minutes and resumes by itself with a notice,
  handling the PRs, pushes and `@mendcode` comments of the pause.
- PR review: `@mendcode` comments are read page by page, so none is dropped when many arrive between polls.
- PR review: a sleeping laptop or a network outage no longer ends a repo watch; only a permanent error (a repository gone, access
  revoked) does, and a job that fails on the network spends none of its attempts. A detached daemon with a repo watch no longer
  stops itself when idle.
- PR review: a fix pushed by `fix.mode` is reviewed once the forge reports the new head, and a fix round counts a finding resolved
  only when that re-check closed it.
- PR review: releasing a taken-over fix job pushes the kept fix and no longer ends the job as `failed`.
- PR review: a released claim wakes the other device's waiting job at its next poll.
- PR review: fix commits name their source (the automatic fix mode, or the commenter and the comment of `@mendcode fix`).
- Setup: a first launch with no usable model is not marked done. Esc or Enter leaves it open for the next launch, and the minimalist
  preset opens the page instead of a prompt no model answers. Upgrades and reinstalls keep their finished setup.
- Setup: Claude Code is shown as installed, signed in and with its plan only when `claude auth status` reports it. Each model says
  who runs it and whose login pays.
- Claude Code turns that fail on "Not logged in" give the official login command of the profile in use.
- ChatGPT models: MendCode asks the subscription backend which models your account can use, with its own login, and keeps the list
  refreshed in the background; if the answer fails, the last list is kept. Nothing of the Codex CLI is read or written.
- Claude models on a new install run in the Claude Code installed on the machine, with its own login, as on an install set up
  before. Only ChatGPT uses MendCode's own login.
- `/connect chatgpt` on new installs uses Sign in with ChatGPT, which needs no OAuth client id. A new install's daemon no longer
  lists ChatGPT models with the Codex CLI's login before its first setup.
- Claude Code sessions know that MendCode's slash commands and features are read with `mendcode docs --search`. Asked to keep
  reviewing pull requests, they are told that `pr_watch` only wakes them on one PR and that MendCode's own reviewer
  (`/pr review`, `/pr watch-repo`) reviews every new PR and push from the daemon.
- Claude Code sessions: a ToolSearch that loaded tools says which tools it loaded.
- `edit` shows its full diff up to the limits the daemon allows.
- The context report counts every file a `read` with `paths` named.
- The built-in search (no ripgrep installed) no longer reports an empty line after a file's final newline.
- PR review: the verification line of a "No findings" review says what happened: no candidates and no separate pass, or candidates
  checked again and none confirmed.
- PR review: a `requested` watch takes an `@mendcode` comment addressed to no one on a PR that area or label routing gives its
  login's personal reviewer.
- PR review: `/pr review` (and your own `@mendcode review`) on an `all` watch reviews as the repository's default global reviewer
  from `.mendcode/reviewers.yaml`, so a head the watch already reviewed is not posted twice.
- PR review: a review that posts nothing says so in its notice and that the pull request keeps the earlier review.
- PR review: a fix session waiting for your approval is no longer stopped as stalled; the wait lasts until the approval is answered.
- PR review: a review whose Claude Code child does not start is retried with backoff instead of failing until someone retries it
  from `/reviews`.
- PR review: the model spend of a call that failed, was stopped or was cut off by a killed daemon is accounted.

### Known limitations

- PR review: a Codex review child still reads your own `~/.codex/AGENTS.md`; MendCode never moves or copies `~/.codex`. A Claude
  Code turn killed with the daemon reports no usage, so its spend stays unknown.
- Sign in with ChatGPT has no device code: sign in on the machine that runs the daemon. On that login there is no native
  compaction (MendCode's own summary is used), no hosted image generation and no `/fast` priority. Device code remains for a
  Codex-style client id you set yourself (`MENDCODE_OPENAI_OAUTH_CLIENT_ID`).
- Mermaid subgraphs are told apart by title: two subgraphs with the same title are drawn as one frame. In a left-to-right
  flowchart, a connection back to an earlier box shares the last stretch of the arrow going into it.

## v0.0.2-nightly.20261029.2 - 2026-10-29

Goals stop when they stop making progress, and the pull request reviewer no longer loses or repeats requests.

### Fixed

- Goals: a goal stalls instead of looping when three turns make no progress or after 100 unattended goal turns; the steering says
  the objective beats an earlier stop rule.
- PR review: a notice that arrives while the session is busy is held and shown when it goes idle.
- PR review: an `@mendcode` command that cannot be answered yet (no `/pr publish on`, or `publishers` does not allow this login) is
  kept and answered once that changes, exactly once, also across restarts.
- PR review: `/pr publish on|off` holds for the repository.
- PR review: a kept `@mendcode review` whose head already has a review by your login or a publisher is answered by that review
  instead of reviewing again.
- PR review: `enabled`, `publishers` and `reviewers` are read from the base branch's current tip, so a pull request opened before
  `.mendcode/review.yaml` was added follows it.
- PR review: review sessions get no shell, skills or instruction files, and a refused read says which files may be read.

### New

- PR review: `reviewers` in `.mendcode/review.yaml` takes a list of logins, the team whose `@mendcode` comments are answered.
  It grants no write access and no publishing; `all` and `requested` keep their meaning.

## v0.0.2-beta.3 - 2026-10-29

Pull request reviews no longer fail on large pull requests or on several reviews of one repository at once.

### Fixed

- PR review: reviews of one repository run their checkouts one at a time.
- PR review: a review prompt longer than a message may be (a large pull request) goes whole into a text attachment.

## v0.0.2-beta.2 - 2026-10-29

The first beta of 0.0.2: pull request reviews explain the change and its merge risk, several reviewers can share one repository,
and headless JSON runs end cleanly.

### Fixed

- `mendcode run --format json` ends on the turn's result.

## v0.0.2-beta.1 - 2026-10-29

Not released: its release smoke test failed on the headless JSON run that v0.0.2-beta.2 fixes, so its changes first shipped in
v0.0.2-beta.2.

### New

- PR review: a walkthrough of the changes by layer with a sequence diagram, the change type, the merge risk with its reason, and
  pre-merge checks of the title, description and linked issues.
- Many reviewers on one repository: `publishers` in `.mendcode/review.yaml` decides who may post; a reviewer stands down when
  another already reviewed the head or answered the comment; `@mendcode <command> @login` addresses one developer's reviewer.

### Changed

- PR review: the token budget no longer counts the provider's cache reads.
- Channels: `beta` also takes a newer stable release, and `nightly` a newer beta or stable one.

## v0.0.1 - 2026-10-29

The first public release of MendCode, a coding agent for the terminal.

### New

- One daemon keeps your sessions, and any number of terminals attach to them.
- A native engine with the models you connect, or Claude Code, Codex, ACP agents and pi behind the same screen.
- A code graph so the model reads less, and long conversations packed instead of forgotten.
- Pull request reviews.
- Installers for macOS, Linux and Windows that check the SHA256 and, with cosign installed, the release signature; stable, beta
  and nightly channels; `mendcode upgrade` to update, switch channel or roll back.
- Docs: what each prompt mode sends for the model's provider family, how auto picks it and how to force one.

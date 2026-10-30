# Setup and intro

## First run

The first start opens one screen that detects instead of asking. Left, **Ready** lists what was found (a ChatGPT login, Claude Code, Codex, API keys, pi) with a check mark, and for each thing missing the one command or key that fixes it (`claude auth login`, `codex login`, `/connect`, `export ANTHROPIC_API_KEY=...`). A recommended model is preselected: the model already chosen, else the best source found (ChatGPT login, Claude Code, Codex, an API key, pi). Enter finishes at once; Esc leaves working defaults (nothing is written but `onboarded`). When nothing usable was found, neither Enter nor Esc writes `onboarded`: the chat says `no model is set up yet · this setup opens again next launch`, and the next interactive launch opens this screen again, so nobody is left at a prompt no model answers. A headless run (`mendcode run`, a prompt on the command line, CI) never opens it. An upgrade or a reinstall keeps the data directory and its `onboarded`, so the screen is not shown again; `/setup` reopens it.

Detection only reads what the app already knows: `models.list`, `providers.list`, `daemon.info` and the read-only `setup.import` preview. It makes no network call, never opens a credential file and never imports anything by itself. `daemon.info.harnesses` is what Claude Code and Codex say of themselves (`claude auth status --json`, `codex login status`): installed, signed in, and the plan only when the tool reports one (`signed in · max plan`; otherwise `plan not reported`). Their email, organization and tokens are never read out. Each model option says who runs it and whose login pays: `MendCode's own engine · your ChatGPT subscription`, `runs in Claude Code, hosted by MendCode · your Claude login`, `your API key · billed per token`. A Claude model in Claude Code and the same model behind an API key (`opencode:claude-opus-5-5`, `anthropic:…`) are different routes with different logins.

### Own logins

A new install signs in for itself. Its first setup (no setup done, no model chosen, no session with a message) writes `ownLogins: true`, and from then on:

- **ChatGPT** runs in MendCode's own engine with MendCode's own login, `/connect chatgpt` (browser or device code). The Codex CLI's login file (`~/.codex/auth.json`) is never read, even when Codex is signed in; the setup lists Codex as found and says its login is not used.
- **Claude** models run in Claude Code, hosted by MendCode, with a Claude Code profile of MendCode's own: every Claude Code process the daemon starts gets `CLAUDE_CONFIG_DIR=<data dir>/claude-code`, the variable Claude Code documents for running several accounts side by side. Its login is separate from `~/.claude`: sign it in once with the command the setup shows, `mendcode claude login` (`--dir D` for another data directory). It runs Claude Code's own browser login, `claude auth login`, with that profile; `mendcode claude status` says whether the profile is signed in. Your own `claude` sessions and their login are not touched. A turn on a profile that is not signed in fails with the login command of that profile (`CLAUDE_CONFIG_DIR=<data dir>/claude-code claude auth login`, the same login spelled out) instead of Claude Code's `/login`.

Nothing of another tool is reused: no credential file is opened, copied or imported, and no session is adopted. An install set up before this setting existed keeps what it used (the Codex CLI's ChatGPT login when there is no `/connect chatgpt`, and `~/.claude`), so an upgrade changes no session's model, engine or login. `ownLogins` is set on the machine that runs the daemon (a remote terminal cannot change it); `ownLogins: false` goes back to the old behaviour.

**Minimalist preset: no setup.** When the install receipt asks for it (`install.sh --tier minimalist`, [releases](release.md#starting-tier)) and setup was never
completed with no tier saved, the first launch opens straight to the prompt: no setup page and no welcome. It applies the minimalist tier as `/tier minimalist`
does, runs the same detection (without the import preview) and saves the model the page would have recommended as `models.main.model` (a model already
chosen stays), then records `onboarded`. If nothing usable is found it opens the setup page instead, with the minimalist tier, so the page says what is
missing and how to sign in, and the first launch is not recorded; if the daemon does not answer, nothing is written and the next launch tries again. It happens once: with `onboarded` or a
`tier` saved the receipt is ignored, so changing the tier later is `/tier`. `balanced` and `full` presets, and a start with no receipt, keep the page below; a
preset only selects the Tier row's starting value (Enter applies it, Esc leaves the page and still applies it, and picking another tier on the row beats it).

Below Ready come the choices. The preview on the right is the sample of the focused row, sized to its content, and its title says which row it follows (`Preview · permission: ask`); it is drawn by the real components and nothing is sent:

| Choice | Preview | Written |
|---|---|---|
| **Model** (the engines found) | the status row of the chat with that model, directly under the sample | `models.main.model` |
| **Tier** (`minimalist`, `balanced`, `full`) | the real chat transcript at that tier's view, with a line of what you get and its context cost (about 3.5k / 5.0k / 6.4k tokens of baseline per request, `TIER_BASELINE_TOKENS`) | `tier` and its bundle, as `/tier` |
| **Permission** (`ask`, `edits`, `full`, `plan`) | the real approval card for `bun test` (a completed command for `full`, the plan card for `plan`) | `defaultPermission` |
| **Look · Theme** (`system` and the themes) | the whole screen repaints in the theme at once; Esc puts the previous one back | `theme` |
| **Look · Glyphs** (`auto`, `ascii`, `unicode`, `nerd`) | the whole screen redraws with that symbol set at once (`ascii`: nothing outside printable ASCII); Esc puts the previous one back | `glyphs` in the terminal profile (see [customize](customize.md)) |
| **Look · Tools** (`quiet`, `default`, `detailed`, `everything`; `custom` when the three keys were tuned apart) | the sample's tool cards and code map folded or open, as `/customize`'s Tool layout sets them | `toolOutput`, `toolDensity`, `codeMapCard` |
| **Look · Diff** (`unified`, `split`, `auto`) | the sample edit drawn as the chat would draw it now, and why: split or unified is decided by the chat's width (`Unified here: split needs 100 chat columns, the chat is 80`), not the narrower preview's | `diffView` |
| **Look · Prompt** (`box`, `top-bottom`, `minimal`, `ascii-box`) | the empty prompt in that frame, with the chat's placeholder | `promptChrome` |
| **Look · Pet** (`off`, `mend`, and a picture pet already chosen) | Mend standing on the sample prompt, as in the chat; a picture pet is named but not drawn in the sample | `pet` |
| **Import** (`nothing`, `all 13 MCP servers`, `5 of 13`) | none: it does not change the sample | the selected servers and commands, through `setup.import` |

Up/down (or `k`/`j`, Tab) move between rows, left/right (`h`/`l`, Space) change the value, `r` checks again. Every Look row applies in memory at once (the whole screen, not only the sample, shows it); Esc puts every one back as it was when the page opened, and Enter saves only the keys that moved, after the tier's bundle, so a tier never undoes a row. The action line sits under the choices and stays there while they scroll; it says what Enter will do: `enter  start chatting · GPT-6.1-Sol · balanced · ask · imports nothing`.

**Import is a choice, never a detour, and the default is nothing.** The row appears only when Claude Code or Codex hold a setup MendCode can take over. Left/right switch between nothing and everything; Enter or Space opens a list in the same screen (one line per server or command with a checkbox, its source, and why it would arrive disabled, for example `needs $STITCH_X_GOOG_API_KEY`). In the list Space toggles, `a` selects all, `n` none, Enter keeps the selection and goes back, Esc goes back without changing it. Under the list two muted lines say what is read where it is (skills, commands and agents in `~/.claude`) and what is never imported. Nothing is copied until the final Enter, and then exactly the selected items are written (`setup.import` with `apply` and `only`); an empty selection sends no import at all. Servers whose credentials are not in the environment arrive disabled, as in `/import setup`.

Memory, budget and everything else stay in `/customize` and `/setup advanced`; the screen says so in one line. Finishing writes exactly the values shown (and only those that changed); `/setup` reopens the same screen with the current values, and with a tier already saved the Tier row can stay unset. Below 72 columns the screen stacks. Under 60 columns, or under 72 with fewer than 34 rows, the preview would be a sliver, so it leaves the page: `p` shows it in place of the choices, with the focused row's note on top (left/right still change the row), and `p` or Esc comes back. The subtitle and the key hints say less as the width shrinks rather than being cut mid-word. Screen-reader mode gets a linear text version (see [accessibility](accessibility.md)). The setup pages never draw the agent/model bar, which would show the model in use rather than the one being chosen. After the first run a toast offers `new here? /tutorial · 4 min`; the tour is never forced.

`/setup advanced` opens the older long page below.

## Advanced setup page

`/setup advanced` opens the full welcome wizard. Checks and Choices use the shared bordered grid, followed by a real home preview; below 70 columns they stack. Header hints drive row selection, changes and completion. Welcome mode, home identity, roles/recipes, prompt context, permissions, memory and API budget choices persist through the daemon or terminal profile.

The chosen preset is saved as the `setupPreset` setting (`default` when never set). Presets `minimal` and `full` set prompt mode, memory use/generation, approval and terminal density/presentation. Both keep models, providers and budget policy. `default` and `custom` preserve current choices. Role details remain in `/model`; prompt families use the existing `/prompt-mode` selector.

The Tier row selects `minimalist`, `balanced` or `full` (or none): a bundle of the chat view, prompt mode, density and which feature modules are on, shown with what the next tier adds or removes. It is separate from the presets above and never writes them; see [tiers](tiers.md).

The Helper row opens a tool-less side conversation in the setup page. Enter sends, Esc returns to choices, Ctrl+L clears its context. Draft editing supports arrows, Home/End and backspace. Context survives navigation and reopening within this terminal, is bounded to twelve prior messages per request, and is not added to the coding session or saved to disk. Unavailable models/auth and provider failures appear in the panel. Calls have a 30-second deadline and obey the same USD/expensive-model gates as agent calls. Nothing is sent until the user asks; replies never apply settings automatically.

`/intro` replays v1's signal, mascot, wordmark, identity and handoff phases with native terminal rows. Any key skips and restores the previous page. Reduced motion, `TERM=dumb` and `NO_COLOR` show a brief static identity. Replay never changes onboarding or settings.

`control-plane setup status|plan|doctor [--json]` queries the daemon for current readiness. Plan writes only `<dataDir>/setup/plan.json`, with suggested v2 commands; it does not install packages, modify shell profiles, configure providers or call them. Doctor exits 1 for readiness blockers. No v1 binary/config files are loaded.

## Import setup from Claude Code and Codex

`/import setup [claude-code|codex] [apply]` reads the other tool's setup and shows what MendCode can take over. The default is a preview page: nothing is written, and the page says how to add everything (`/import setup apply`) or to pick (`/setup`); Esc returns to the page it was opened from. `apply` writes it. The same daemon code serves `/setup`'s picker: the `setup.import` command takes an optional `only` list of item keys (`kind:tool:scope:name`) and `apply` then writes just those (no `only`: everything new; empty list: nothing). Local only (a remote terminal is refused; the daemon reads the files) and never in the read-only command set. Sources: Claude Code `~/.claude.json` (user and per-project `mcpServers`, `CLAUDE_CONFIG_DIR` respected) and the project's `.mcp.json`; Codex `~/.codex/config.toml` and the project's `.codex/config.toml` (`mcp_servers`, `CODEX_HOME` respected).

| Taken over | Where it goes |
|---|---|
| MCP servers (stdio and http/sse) | `<data dir>/mcp.json` (user scope) or `<project>/.mendcode/mcp.json` (project scope: a project's own `.mcp.json`, Codex project config, or a Claude per-project entry) |
| Codex prompts (`~/.codex/prompts/*.md`) | `<data dir>/commands/<name>.md`; a prompt using inline shell (`` !`cmd` ``) is left for you to copy after review |
| Global instructions (`~/.claude/CLAUDE.md`, else `~/.codex/AGENTS.md`) | `<data dir>/AGENTS.md`, only when it does not exist |

Nothing existing is overwritten: an entry with the same name is kept and listed as `kept yours`. Running it again changes nothing. MendCode already reads `.claude/skills`, `.claude/commands`, `.claude/agents`, `.agents/skills` and a project's `CLAUDE.md`/`AGENTS.md` where they are, so these are reported under "Read where it is" and not copied. Never imported: permission rules and approvals, hooks, model and provider settings, login tokens and API keys, Codex skills.

Secrets are never copied. An env var or header holding a credential (a secret-looking name, or a value the redactor recognizes) becomes a `${NAME}` reference, the server is imported disabled, and the page names the variable to set for the daemon (`set $API_TOKEN`). A command, argument list or URL that carries a credential is skipped. Servers marked disabled in Codex stay disabled.

Decision taken: preview first, explicit `apply`, imported servers with a missing secret start disabled. There is no `control-plane` form yet.

## Tutorial

`/tutorial` is learn-by-doing. A lesson rail (title, one sentence of why, what to do, progress such as `3/13` and the steps checked off as they happen) stands beside a **practice chat**: the real terminal app (`createApp`) talking to a scripted engine instead of the daemon. The practice chat is marked `practice · nothing here is real or saved`.

Lessons, in order: send a message and watch the streamed answer with its tool card; slash commands (open the menu, move through the groups, run one); `@` to attach a file; approve a command (allow once, for the session, deny); answer a question; steer, queue and interrupt a running turn; switch model and effort; sessions (open the list, close it, start a new chat); tool cards, `/changes` and `/undo`; history recall with the up arrow and bringing a discarded draft back; the right panel (open it, change the preset); change a setting in `/customize` and see it live; where help is (`/help`, `/doctor`).

A lesson completes on the real event, never on a timer: a step is checked when the practice chat sent the command, opened the page, changed the setting or answered the request that step is about. Enter on a finished lesson goes to the next one. The hint under each lesson names the keys you actually have (from `keybindings.json`); a key you unbound is left out and its slash command is named instead. The same bindings work in the practice chat.

| Key | Does |
|---|---|
| `alt+m` | **show me**: the tour performs the lesson itself, typing and pressing keys with each key named (`▶ f2`) |
| `alt+s` / `alt+n` / `alt+b` | skip, next, back |
| `alt+q` | leave (also `/exit` or `ctrl+c` twice in the practice chat) |
| anything else | goes to the practice chat; `esc` and `ctrl+c` included |

Progress is kept in the terminal profile (`tutorialDone`), so `/tutorial` resumes after the last lesson done; `/tutorial restart` begins again and `/tutorial all` includes the lessons the tour left out. Lessons adapt: a `minimalist` user is not taught the right panel, and the panel lesson only appears when the practice chat is wide enough to hold it (about 147 columns; narrower, the panel would cover the chat). The tour ends on a cheat-sheet of your own keys and three next steps.

Layout: from 110 columns the rail is a 36-column column on the left; below that the page stacks, a three-row header above the practice chat (title and why, the action and hint, the practice marker with `[ ][ ]` step progress), which fits 80x24. Screen-reader mode shows the lesson as plain sentences, then the practice chat (see [accessibility](accessibility.md)).

### The practice chat is isolated

The engine (`apps/cli/src/tutorial/engine.ts`) replays fixed turns in memory: a read, an edit with a diff, a command that asks, a question, a long walk. It is not the daemon and not a fake of it on the wire: it starts no process, opens no socket, calls no model, spends no tokens and adds nothing to the context. The practice chat is built with no data directory, so it cannot read or write the user's profile, drafts, stash, scratchpad or keybindings; its sessions, prompt history, queue, settings and project file exist only in memory and vanish with the tour. Nothing it sends reaches the daemon, so no session, memory or file of the user changes. The only thing the tour writes is the progress line in the terminal profile. The global theme is put back when the tour closes. `apps/cli/test/tutorial.test.ts` asserts all of this, comparing the data directory before and after a run.

The practice code loads only when `/tutorial` opens (`lazy-pages.ts`, `footprint.test.ts`), never pulls in zod or the protocol schemas, and does not use `fetch`, `Bun.spawn` or `child_process`. The practice chat has no extensions loaded, so custom [views](views.md) do not apply inside it; the tutorial and setup pages themselves draw through the `page` slot like every other page.

Frames: `bun scripts/render-onboarding-frames.ts <dir> [before|after] [WxH...]` renders the first-run screen; `bun scripts/render-frames.ts .agents-frames/B61 --b61 100x30 180x50` the older set. Fixtures use local services and fake model replies, with temporary data directories.

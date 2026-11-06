# Setup and intro

The first time you start MendCode, one screen finds the logins and models you already have and lets you pick a model, a tier, a permission mode, a look and what to import. Enter starts chatting. `/setup` opens the same screen again later.

## First run

1. Run `mendcode`. The setup screen opens on its own; nothing is asked before it.
2. Check **Ready** on the left. Everything found has a check mark; anything missing shows the one command or key that fixes it.
3. Pick a model on the **Model** row. A recommended one is already selected.
4. Go through the other rows (tier, permission, look, import). Each row shows its effect in the preview on the right.
5. Press Enter. MendCode saves the values you changed and opens the chat.

After the first run a toast offers `new here? /tutorial · 4 min`. The [tutorial](#tutorial) is never forced.

The screen works the same in every tier. It adds no chat chrome, command or prompt tokens. A headless run (`mendcode run`, a prompt on the command line, CI) never opens it.

### What Ready shows

Ready lists what was found in two groups:

| Group | What it holds | Who signs in |
|---|---|---|
| **MendCode's own engine** | the ChatGPT login and API keys | MendCode, with its own login |
| **External harnesses · their own login** | Claude Code, Codex, pi | each tool, with its own login |

For each thing missing, Ready shows the fix: `claude auth login`, `codex login`, `/connect` or `export ANTHROPIC_API_KEY=...`.

You can connect MendCode's own logins without leaving setup:

- Press Up from the Model row to reach the own-engine rows.
- Enter on the ChatGPT login runs `/connect chatgpt`.
- Enter on API keys opens `/connect`.
- Closing that page (Esc, or `m` after signing in) comes back to setup and checks again, so the Model row lists what you just connected.

This saves only what `/connect` saves on its own; the setup's choices stay in memory until Enter. Claude Code and Codex are signed in with their own commands, outside MendCode.

### Choose a model

The Model row offers every model found, not a sample, and names who runs it: `‹ Opus · Claude Code ›`. Left and right step through all of them.

The preselected model is the one already chosen. Without one, it is the best source found, in this order: ChatGPT login, Claude Code, Codex, an API key, pi, an ACP agent.

Press **Space on the Model row** to list every model in the same screen, grouped as Ready is:

- **MendCode's own engine**: the ChatGPT subscription's models once `/connect chatgpt` signed in, then every model of each provider with a key, first-party providers first.
- **External harnesses · their own login**: Claude Code's Fable, Haiku, Opus and Sonnet, the Codex harness, pi, and each ACP agent.

Each group's heading says how many models it has, who runs them and whose login or key pays.

| Key | In the model list |
|---|---|
| Up / Down | move |
| Enter | pick the model and go back |
| `r` | check again |
| Esc | go back without changing it |

The own-engine group ends with two actions. Enter runs the flow, and closing it comes back to the list, checked again, with the new models in it:

- `+ Sign in to ChatGPT · /connect chatgpt` (while ChatGPT is not signed in)
- `+ Add an API-key provider · /connect`

A harness that was found but lists no model says what would list them:

- `not signed in · claude auth login`
- for Codex on MendCode's engine: `full tier · /tier thread_mcp on codex lists its models`. Its `codex:` models come with the [thread bridge](thread-mcp.md), which is off by default.

Nothing in the list is saved until the page's final Enter.

### The choices

The page takes the whole terminal. The choices grow to 64 columns, the preview takes the rest of the width, and the action line stays at the foot of the left column.

The preview shows the focused row's sample, drawn by the real components; nothing is sent. Its title names the row it follows (`Preview · permission: ask`). The card and prompt sit at its foot, as the chat stands in a terminal that size.

| Choice | Preview | Saved as |
|---|---|---|
| **Model**: every model found (Space lists them by who runs them) | the chat's status row with that model, under the sample | `models.main.model` |
| **Tier**: `minimalist`, `balanced`, `full` | the real chat transcript at that tier, with what you get and its context cost: about 3.5k / 5.0k / 6.4k tokens of baseline per request (`TIER_BASELINE_TOKENS`) | `tier` and its bundle, as `/tier` |
| **Permission**: `ask`, `edits`, `full`, `plan` | the real approval card for `bun test` (a completed command for `full`, the plan card for `plan`) | `defaultPermission` |
| **Look · Theme**: `system` and the themes | the whole screen repaints in the theme | `theme` |
| **Look · Glyphs**: `auto`, `ascii`, `unicode`, `nerd` | the whole screen redraws with that symbol set (`ascii`: nothing outside printable ASCII) | `glyphs` in the terminal settings (see [customize](customize.md)) |
| **Look · Tools**: `quiet`, `default`, `detailed`, `everything` (`custom` when the three keys were tuned apart) | the sample's tool cards and code map folded or open, as `/customize`'s Tool layout sets them | `toolOutput`, `toolDensity`, `codeMapCard` |
| **Look · Diff**: `unified`, `split`, `auto` | the sample edit as the chat would draw it now, and why. The chat's width decides, not the preview's: `Unified here: split needs 100 chat columns, the chat is 80` | `diffView` |
| **Look · Prompt**: `box`, `top-bottom`, `minimal`, `ascii-box` | the empty prompt in that frame, with the chat's placeholder | `promptChrome` |
| **Look · Pet**: `off`, `mend`, or a picture pet already chosen | Mend on the sample prompt in its compact three-row form (the chat's seven-row sprite would cover the card); a picture pet is named but not drawn | `pet` |
| **Import**: `nothing`, `all 13 MCP servers`, `5 of 13` | none | the selected servers and commands, through `setup.import` |

The Tier row says what its value gives even when another row is focused (`‹ balanced ›  tool cards, code graph, sub-agents`, in fewer words when narrow). Focused, it lists the tiers to switch between.

Every Look row applies at once to the whole screen, not only the sample. Esc puts every one back as it was when the page opened.

Memory, budget and everything else stay in `/customize` and `/setup advanced`; the screen says so in one line.

### Keys

| Key | Does |
|---|---|
| Up / Down, `k` / `j`, Tab | move between rows |
| Left / Right, `h` / `l`, Space | change the value (Space on Model and Import opens their list instead) |
| `r` | check again |
| `p` | show the preview in place of the choices, on small terminals |
| Enter | finish and start chatting |
| Esc | leave with working defaults |

The action line says what Enter will do: `enter  start chatting · GPT-6.1-Sol · balanced · ask · imports nothing`.

### Import

**Import is a choice, never a detour, and the default is nothing.** The row appears only when Claude Code or Codex hold a setup MendCode can take over.

- Left and right switch between nothing and everything.
- Enter or Space opens a list in the same screen: one line per server or command, with a checkbox, its source, and why it would arrive disabled (for example `needs $STITCH_X_GOOG_API_KEY`).
- In the list, Space toggles, `a` selects all, `n` none, Enter keeps the selection and goes back, Esc goes back without changing it.

Under the list, two muted lines say what is read where it is (skills, commands and agents in `~/.claude`) and what is never imported.

Nothing is copied until the final Enter. Then exactly the selected items are written (`setup.import` with `apply` and `only`); an empty selection sends no import at all. Servers whose credentials are not in the environment arrive disabled, as with `/import setup`. See [Import setup from Claude Code and Codex](#import-setup-from-claude-code-and-codex).

### Finishing, leaving and coming back

- **Enter** finishes at once. It saves only the keys that moved, after the tier's bundle, so a tier never undoes a row.
- **Esc** leaves working defaults: nothing is written but `onboarded`.
- **`/setup`** reopens the same screen with the current values. With a tier already saved, the Tier row can stay unset.
- An upgrade or a reinstall keeps the data directory and its `onboarded`, so the screen is not shown again.

When nothing usable was found, neither Enter nor Esc writes `onboarded`. The chat says `no model is set up yet · this setup opens again next launch`, and the next interactive launch opens this screen again, so nobody is left at a prompt no model answers.

The minimalist preset opens no page when a model is found; see [Minimalist preset: no setup](#minimalist-preset-no-setup).

### Small terminals and screen readers

- Below 72 columns the screen stacks.
- Under 60 columns, or under 72 with fewer than 34 rows, the preview leaves the page. `p` shows it in place of the choices, with the focused row's note on top (left and right still change the row); `p` or Esc comes back.
- The subtitle and the key hints say less as the width shrinks, rather than being cut mid-word.
- Screen-reader mode gets a linear text version (see [accessibility](accessibility.md)).
- The setup pages never draw the agent/model bar, which would show the model in use rather than the one being chosen.

### What detection reads

Detection only reads what the app already knows: `models.list`, `providers.list`, `daemon.info` and the read-only `setup.import` preview. It makes no network call, never opens a credential file and never imports anything by itself.

`daemon.info.harnesses` is what Claude Code and Codex say of themselves (`claude auth status --json`, `codex login status`): installed, signed in, and the plan only when the tool reports one (`signed in · max plan`, otherwise `plan not reported`). Their email, organization and tokens are never read out.

Each model option says who runs it and whose login pays:

| Option | Means |
|---|---|
| `MendCode's own engine · your ChatGPT subscription` | MendCode runs it on your ChatGPT plan |
| `runs in Claude Code, hosted by MendCode · your Claude login` | your Claude Code runs it, on your Claude login |
| `your API key · billed per token` | the provider bills your key |

A Claude model in Claude Code and the same model behind an API key (`opencode:claude-opus-5-5`, `anthropic:…`) are different routes with different logins.

### Logins

The two subscriptions take two different routes, and the setup says which.

**Claude** models run in your Claude Code, hosted by MendCode. That is the `claude` installed on this machine, with its own configuration and login (`~/.claude`, or `CLAUDE_CONFIG_DIR` when you set it), exactly as your own `claude` sessions run. MendCode starts it and never reads, copies or changes its credentials.

- Signed in: there is nothing to do.
- Not signed in: the setup shows `claude auth login`, and a turn that fails on "Not logged in" says the same instead of Claude Code's `/login`.

**ChatGPT** runs in MendCode's own engine, with MendCode's own login.

- A new install's first setup (no setup done, no model chosen, no session with a message) writes `ownLogins: true`. From then on the engine signs in to ChatGPT only with `/connect chatgpt` and never reads the Codex CLI's login file (`~/.codex/auth.json`), even when Codex is signed in. The setup lists Codex as found and says its login is not used.
- Before that first setup writes `ownLogins`, a new install's daemon already counts as one, so not even its first start reads Codex's login.
- The Codex harness is separate: its `codex:` models run your own `codex`, on its own login, as Claude Code runs on its own. When the daemon lists them, the setup offers them with `ownLogins` too.

#### Sign in with ChatGPT

`/connect chatgpt` (or `mendcode control-plane auth login --provider chatgpt --method browser --execute`) uses OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for open-source apps. Nothing needs configuring.

1. Run `/connect chatgpt`. The terminal shows a link.
2. Open it in the browser of the machine that runs the daemon.
3. Sign in, pick the workspace, keep the agent's name (MendCode) and allow it to use your ChatGPT plan.
4. The browser comes back to `127.0.0.1:1455` (another free port when that one is taken) and the terminal says `ChatGPT connected`.

The first sign-in registers a client of your own (`oaiapp_…`), kept with this install's host id in `<dataDir>/chatgpt-host.json` and reused on later sign-ins. The tokens go to `<dataDir>/chatgpt-auth.json` (mode 600), after the ID token's signature, issuer, audience, nonce and expiry are checked.

Good to know:

- The link stays open 15 minutes; then the login fails as timed out and nothing is saved. Ctrl+C or `providers.auth.action cancel` stops it.
- Declining the plan permission, or a grant without it, fails with "ChatGPT plan use was not allowed" and saves no tokens. Signing in again offers it.
- The access token lasts an hour and is renewed with the refresh token (30 days, replaced on each renewal). A refresh token OpenAI no longer accepts clears the login and asks you to sign in again; a network or server failure keeps it for the next try.
- There is no device code on this route: a daemon on a machine without a browser cannot sign in this way.
- Requests go to `api.openai.com/v1/responses` and count against your plan. ChatGPT → Settings → Usage shows MendCode and can limit or revoke it.
- That route has no native compaction (MendCode's own summary is used), no hosted image generation and no `/fast` priority, and drops the request fields it refuses.

A Codex-style OAuth client (`MENDCODE_OPENAI_OAUTH_CLIENT_ID`), when you set one, replaces it: browser and device code against the subscription backend.

#### Older installs

An install set up before `ownLogins` existed keeps the Codex CLI's ChatGPT login as a fallback when there is no `/connect chatgpt`, so an upgrade changes no session's model, engine or login.

`ownLogins` is set on the machine that runs the daemon; a remote terminal cannot change it. `ownLogins: false` goes back to the fallback.

### Minimalist preset: no setup

When the install receipt asks for it (`install.sh --tier minimalist`, see [releases](release.md#starting-tier)) and setup was never completed with no tier saved, the first launch opens straight to the prompt: no setup page and no welcome.

That first launch:

1. applies the minimalist tier, as `/tier minimalist` does;
2. runs the same detection, without the import preview;
3. saves the model the page would have recommended as `models.main.model` (a model already chosen stays);
4. records `onboarded`.

If nothing usable is found it opens the setup page instead, with the minimalist tier, so the page says what is missing and how to sign in, and the first launch is not recorded. If the daemon does not answer, nothing is written and the next launch tries again.

It happens once: with `onboarded` or a `tier` saved the receipt is ignored, so changing the tier later is `/tier`.

The `balanced` and `full` presets, and a start with no receipt, keep the setup page. A preset only selects the Tier row's starting value: Enter applies it, Esc leaves the page and still applies it, and picking another tier on the row beats it.

## Advanced setup page

`/setup advanced` opens the full welcome wizard, the older long page.

- Checks and Choices use the shared bordered grid, followed by a real home preview; below 70 columns they stack.
- Header hints drive row selection, changes and completion.
- Welcome mode, home identity, roles and recipes, prompt context, permissions, memory and API budget choices persist through the daemon or terminal settings.

### Presets and tier

The chosen preset is saved as the `setupPreset` setting (`default` when never set).

| Preset | Does |
|---|---|
| `minimal`, `full` | set prompt mode, memory use and generation, approval and terminal density and presentation; keep models, providers and budget policy |
| `default`, `custom` | keep the current choices |

Role details stay in `/model`; prompt families use the existing `/prompt-mode` selector.

The Tier row selects `minimalist`, `balanced` or `full` (or none): a bundle of the chat view, prompt mode, density and which feature modules are on, shown with what the next tier adds or removes. It is separate from the presets above and never writes them; see [tiers](tiers.md).

### Helper

The Helper row opens a tool-less side conversation in the setup page.

| Key | Does |
|---|---|
| Enter | send |
| Esc | back to the choices |
| Ctrl+L | clear its context |
| Arrows, Home / End, Backspace | edit the draft |

- Context survives navigation and reopening within this terminal, is bounded to twelve prior messages per request, and is not added to the coding session or saved to disk.
- Unavailable models or logins and provider failures appear in the panel.
- Calls have a 30-second deadline and obey the same USD and expensive-model gates as agent calls.
- Nothing is sent until you ask; replies never apply settings automatically.

### Intro and readiness

`/intro` replays v1's signal, mascot, wordmark, identity and handoff phases with native terminal rows. Any key skips and restores the previous page. Reduced motion, `TERM=dumb` and `NO_COLOR` show a brief static identity. Replay never changes onboarding or settings.

`control-plane setup status|plan|doctor [--json]` asks the daemon for current readiness:

- `plan` writes only `<dataDir>/setup/plan.json`, with suggested v2 commands. It does not install packages, modify shell profiles, configure providers or call them.
- `doctor` exits 1 for readiness blockers.
- No v1 binary or config files are loaded.

## Import setup from Claude Code and Codex

`/import setup [claude-code|codex] [apply]` reads the other tool's setup and shows what MendCode can take over.

- Without `apply` it opens a preview page. Nothing is written; the page says how to add everything (`/import setup apply`) or to pick (`/setup`). Esc returns to the page it was opened from.
- With `apply` it writes.

It is local only (a remote terminal is refused, because the daemon reads the files) and never in the read-only command set.

The same daemon code serves `/setup`'s picker: the `setup.import` command takes an optional `only` list of item keys (`kind:tool:scope:name`), and `apply` then writes just those. No `only` means everything new; an empty list means nothing.

### Sources

| Tool | Reads |
|---|---|
| Claude Code | `~/.claude.json` (user and per-project `mcpServers`, `CLAUDE_CONFIG_DIR` respected) and the project's `.mcp.json` |
| Codex | `~/.codex/config.toml` and the project's `.codex/config.toml` (`mcp_servers`, `CODEX_HOME` respected) |

### What is taken over

| Taken over | Where it goes |
|---|---|
| MCP servers (stdio and http/sse) | `<data dir>/mcp.json` (user scope) or `<project>/.mendcode/mcp.json` (project scope: a project's own `.mcp.json`, Codex project config, or a Claude per-project entry) |
| Codex prompts (`~/.codex/prompts/*.md`) | `<data dir>/commands/<name>.md`; a prompt using inline shell (`` !`cmd` ``) is left for you to copy after review |
| Global instructions (`~/.claude/CLAUDE.md`, else `~/.codex/AGENTS.md`) | `<data dir>/AGENTS.md`, only when it does not exist |

Nothing existing is overwritten: an entry with the same name is kept and listed as `kept yours`. Running it again changes nothing.

**Read where it is, not copied:** MendCode already reads `.claude/skills`, `.claude/commands`, `.claude/agents`, `.agents/skills` and a project's `CLAUDE.md` or `AGENTS.md` in place.

**Never imported:** permission rules and approvals, hooks, model and provider settings, login tokens and API keys, Codex skills.

### Secrets

Secrets are never copied.

- An env var or header holding a credential (a secret-looking name, or a value the redactor recognizes) becomes a `${NAME}` reference. The server is imported disabled, and the page names the variable to set for the daemon (`set $API_TOKEN`).
- A command, argument list or URL that carries a credential is skipped.
- Servers marked disabled in Codex stay disabled.

Decision taken: preview first, explicit `apply`, and imported servers with a missing secret start disabled. There is no `control-plane` form yet.

## Tutorial

`/tutorial` teaches by doing. A lesson rail stands beside a **practice chat**: the real terminal app (`createApp`) talking to a scripted engine instead of the daemon. The practice chat is marked `practice · nothing here is real or saved`.

The rail shows the lesson's title, one sentence of why, what to do, progress such as `3/13`, and the steps checked off as they happen.

### Lessons

In order:

1. Send a message and watch the streamed answer with its tool card.
2. Slash commands: open the menu, move through the groups, run one.
3. `@` to attach a file.
4. Approve a command: allow once, for the session, deny.
5. Answer a question.
6. Steer, queue and interrupt a running turn.
7. Switch model and effort.
8. Sessions: open the list, close it, start a new chat.
9. Tool cards, `/changes` and `/undo`.
10. History recall with the up arrow, and bringing a discarded draft back.
11. The right panel: open it, change the preset.
12. Change a setting in `/customize` and see it live.
13. Where help is: `/help`, `/doctor`.

A lesson completes on the real event, never on a timer: a step is checked when the practice chat sent the command, opened the page, changed the setting or answered the request that step is about. Enter on a finished lesson goes to the next one.

The hint under each lesson names the keys you actually have (from `keybindings.json`). A key you unbound is left out and its slash command is named instead. The same bindings work in the practice chat.

### Keys

| Key | Does |
|---|---|
| `alt+m` | **show me**: the tour performs the lesson itself, typing and pressing keys with each key named (`▶ f2`) |
| `alt+s` / `alt+n` / `alt+b` | skip, next, back |
| `alt+q` | leave (also `/exit`, or `ctrl+c` twice in the practice chat) |
| anything else | goes to the practice chat, `esc` and `ctrl+c` included |

### Progress and layout

- Progress is kept in the terminal settings (`tutorialDone`), so `/tutorial` resumes after the last lesson done.
- `/tutorial restart` begins again; `/tutorial all` includes the lessons the tour left out.
- Lessons adapt: a `minimalist` user is not taught the right panel, and the panel lesson only appears when the practice chat is wide enough to hold it (about 147 columns; narrower, the panel would cover the chat).
- The tour ends on a cheat sheet of your own keys and three next steps.
- From 110 columns the rail is a 36-column column on the left. Below that the page stacks: a three-row header (title and why; the action and hint; the practice marker with `[ ][ ]` step progress) above the practice chat, which fits 80x24.
- Screen-reader mode shows the lesson as plain sentences, then the practice chat (see [accessibility](accessibility.md)).

### The practice chat is isolated

The engine (`apps/cli/src/tutorial/engine.ts`) replays fixed turns in memory: a read, an edit with a diff, a command that asks, a question, a long walk. It is not the daemon and not a fake of it on the wire.

- It starts no process, opens no socket, calls no model, spends no tokens and adds nothing to the context.
- The practice chat is built with no data directory, so it cannot read or write your profile, drafts, stash, scratchpad or keybindings. Its sessions, prompt history, queue, settings and project file exist only in memory and vanish with the tour.
- Nothing it sends reaches the daemon, so no session, memory or file of yours changes.
- The only thing the tour writes is the progress line in the terminal settings. The global theme is put back when the tour closes.

`apps/cli/test/tutorial.test.ts` asserts all of this, comparing the data directory before and after a run.

The practice code loads only when `/tutorial` opens (`lazy-pages.ts`, `footprint.test.ts`), never pulls in zod or the protocol schemas, and does not use `fetch`, `Bun.spawn` or `child_process`. The practice chat has no extensions loaded, so custom [views](views.md) do not apply inside it; the tutorial and setup pages themselves draw through the `page` slot like every other page.

### Frames

- `bun scripts/render-onboarding-frames.ts <dir> [before|after] [WxH...]` renders the first-run screen.
- `bun scripts/render-frames.ts .agents-frames/B61 --b61 100x30 180x50` renders the older set.

Fixtures use local services and fake model replies, with temporary data directories.

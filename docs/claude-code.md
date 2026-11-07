# Claude Code

Run a session on your own Claude Code instead of MendCode's native engine. Pick a Claude model in `/model`, or in a role, recipe or profile for `main`; that session's turns go to `claude`.

## Requirements

1. Check that Claude Code is installed: `claude --version` must work.
2. Log in with `claude auth login`.
3. Pick a Claude model in `/model`.

| Environment setting | Effect |
|---|---|
| `MENDCODE_CLAUDE_BIN=/path/to/claude` | set for the daemon when `claude` is outside your PATH |
| `MENDCODE_CLAUDE=0` | hide the Claude models |

The models appear only when `claude` answers. The daemon asks at startup; a list requested meanwhile waits at most two seconds for the answer.

A negative answer is asked again once it is ten seconds old. A slow first start therefore does not hide the models until the next restart.

### Choose an alias

These are the CLI's aliases. Each always means the latest of its family:

| model | runs |
|---|---|
| `claude-fable` | `claude --model fable` |
| `claude-opus` | `claude --model opus` |
| `claude-sonnet` | `claude --model sonnet` |
| `claude-haiku` | `claude --model haiku` |

### Choose effort

Effort (low, medium, high, xhigh) is passed as `--effort`. `minimal` becomes `low`.

When you pick none, the default is `effortLevel` from your Claude Code settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR`). The footer names the level the session runs at.

A level MendCode has no name for (`max`), or no setting, leaves the models without a default; Claude Code decides.

The footer's `effort` carries no `:JEV` for these models. Adaptive reasoning applies to the daemon's own generations only ([reasoning](reasoning.md)).

### Pin a model version

Use a full id of one of those families to pin the session:

- `--model claude-haiku-5-5`;
- `/model claude-opus-5-5`;
- a dated id such as `claude-haiku-4-5-20251001`;
- the same id in a role or profile for `main`.

The id is a family alias followed by a version (`-5`, `-5-5`) and optionally an eight-digit date. It goes to `claude --model` unchanged and takes the family's efforts.

It reads `Haiku 5.5` and appears in `/model` beside its alias while a session or role uses it.

MendCode keeps no version table. A version Claude Code does not have fails on the first turn with Claude Code's own error. Anything else, such as `claude-nonsense` or `claude-haiku-fast`, is an unknown model.

### Resolved names and context windows

An alias reads by its family (`Opus`) until Claude Code reports the resolved version. The daemon remembers it per alias in `<dataDir>/model-resolutions.json`, written atomically as a display hint only; requests keep sending the alias.

The next launch and every other session then show `Opus 5.5` in the model list, `/setup`, status line and bottom bar. The model sees it too: `ai_config` lists `claude-opus` with `resolved: "claude-opus-5-5"`.

- A different version reported after an upgrade replaces it.
- An alias that never answered on this machine stays `Opus`.
- A session pinned to a full id does not change its alias's display.

The model list shows a 200K context window for every Claude model until its first answer states the real one, 1M for some. The daemon saves that figure in the same file and lists it from then on.

A session's context percentage never uses the listed figure. It appears after the first answer and is measured against the window that answer stated.

## How it works

MendCode drives the unmodified `claude` binary through the same stream-json protocol the official Agent SDK uses:

Claude Code runs its own agent loop, tools, `CLAUDE.md`, skills, hooks, output style and MCP servers. It reads your normal Claude settings: user, project and local.

### Prompt additions

Its system prompt stays its own. MendCode adds a short note after it with `--append-system-prompt`:

- what this terminal draws, using the same "Terminal rendering" text a native session gets in that prompt mode;
- the one-line `mendcode docs` pointer for questions about MendCode itself;
- that a changed MCP server is there on the next message.

The drawing text helps the model use a diagram or chart when useful:

| Prompt mode | Drawing text |
|---|---|
| `focus` | one sentence |
| `guide`, `full` | Markdown, Mermaid and callout syntax, and when to use each |
| `minimal` | drawing lines and the pointer left out |

Codex, pi and ACP agents get the same two additions ([pi](pi-engine.md#how-a-turn-runs), [ACP](acp-engine.md#agent-transport)). Codex receives them as its thread's `developerInstructions`, a developer message after its own instructions.

### Login and process lifetime

Claude Code uses its own login. MendCode never reads, copies or forwards Claude credentials. There is no proxy or relay.

New and old installs use your Claude Code configuration and login (`~/.claude`, or your `CLAUDE_CONFIG_DIR`; [setup](setup.md#logins)). `ownLogins` changes only ChatGPT's login.

Setup reads `claude auth status --json` for installed, signed in and the plan (`subscriptionType`, only when reported). A turn that fails on "Not logged in" says `claude auth login`.

One `claude` process serves one session and stays up between turns. It stops after 10 idle minutes or when the model or effort changes.

The next turn resumes the same Claude Code conversation (`--resume`), also after a daemon restart.

## What MendCode does

### Turns and thinking

Text, thinking and tool calls stream into the transcript. Chats saved before tool cards keep their plain cards.

| Tool call | Card |
|---|---|
| Command | shell card |
| Read | its lines |
| Search | grouped by file |
| Write | what it did |
| Edit | the diff Claude Code made, with line numbers and added and removed rows in colour |

Claude Code leaves out thinking text unless asked. Each process starts with `--thinking-display summarized`; what streams is the API's summary of the thinking.

If `claude` does not know the flag, it exits at start. The engine starts it again without the flag and keeps it off for that install; Claude Code keeps thinking text to itself.

The working row still says `Thinking...` while such a block is open. The transcript gets no card for it; `run --thinking` prints nothing for it either.
### Follow sub-agents

Claude Code's own sub-agents (its Agent tool) show like MendCode's. Each working agent gets a row in the Agents strip above the prompt:

- what it was asked and its agent type;
- `await` or `bg`;
- the tool it is running and how many it has run.

In the `full` tier, the row also names its model. It starts with the requested one (`model: "haiku"` reads `Haiku`), then uses the version named by its first message (`Haiku 5.5`).

A call naming no model shows none until that message, never the session's own. Under the call, one line shows what it is doing; when it ends, it shows tools, time and tokens.

#### Open an agent's thread

1. Press `ctrl+x ↓` or click its row. Its thread replaces the chat.
2. Use `←` `→` to change sibling.
3. Press `↑` or `ctrl+x ↑` to return to the conversation at the row you left.

The header shows its name in its colour, `2 of 4 · ←→ · ↑ back`, type, `bg` or `await`, activity, tools and time. The thread contains its prompt, each tool call and its report.

A full border in the agent's colour distinguishes the thread from the conversation: `╭─ sub-agent ─╮` over its header, `│` down both sides, `╰─╯` under its view.

The Agents strip stays below it. The open agent's row is marked `▸` and kept even after it ends. There is no `ctx` column: storing Claude Code's per-call sub-agent usage with every step would grow the session's disk.

The thread is read-only. Messages typed there go to the session; the empty prompt says `read-only thread · messages go to the session`, with its rules and lead in the sub-agent's colour.

The header names the owner: `of <session title>`. The `minimal` tier has no border, only `◆ name · state · of <session>` at the top and the keys back.

The thread has its own prompt. The conversation's draft waits until you return. Its queue shows only messages sent from that thread; `↑`, `alt+↑` take only those back.

#### Background sub-agents

A background sub-agent (`run_in_background`) keeps filling its thread after the starting turn ends and during later turns. Each tool and report arrives under that turn's call as it happens; up to 8 earlier turns are followed per Claude Code process.

Its call says `running in the background` instead of Claude Code's note to its model. It stays in the Agents strip, including during later turns, while Claude Code still runs it.

A sub-agent's work never stands for the main agent:

- the working row names the main agent's own step;
- a message queued `After tools` waits only for the main agent's tools;
- a sub-agent's long command, reported by Claude Code as its task, stays in its thread instead of becoming a notice.
### Background commands and agents

Background work appears above the prompt while running, in `/agents` and in the `ctrl+t` dock's Jobs.

| View | Above the prompt |
|---|---|
| minimal and balanced | one muted row, `◇ background command · <its description> · 3m · /ps`, or counts by kind |
| full | one row per item, up to three then `+N more` |
| Agents strip showing sub-agents | commands join that tree as rows such as `└ bun run dev  cmd  11m 13s`; the head counts them and names `/ps` |

The process stays alive meanwhile. No automatic restart, `/restart` or `/daemon restart` stops it. A terminal hosting the daemon waits for it before closing.

#### Long inputs and stopping

An agent call opens its card as soon as its prompt starts being written. Thinking that streams no words still counts as activity; neither reads as `no response`.

Any long input, such as a whole file or script, opens its card while the model writes. Every 2,000 characters, the card reports progress such as `writing 84 lines · 6.2 KB`; the working row says `Writing...`.

Once the input is whole, the tool runs and both return to the tool's own words.

Esc gives Claude Code three seconds to stop the turn, then ends it here. Anything that turn still sends is dropped, never mixed into the next turn.

#### Completion notices

When background work ends after its turn, Claude Code answers on its own. MendCode shows a conversation notice with the command's summary and output file, followed by Claude's answer. Nothing is sent twice.

A message you send before that notice runs goes as usual. Only a task of the running process gets a notice.

A task killed when MendCode ends its process, or left by an earlier process and reported on resume, is not queued: Claude Code does not answer it.
### Use MendCode's tools

Feature `harness_tools` is available in balanced and full; use `/tier harness_tools on|off`. Claude Code keeps its tools and also gets MendCode's as `mcp__mendcode__<tool>`:

- the [code graph](code-graph.md): `graph_find`, `graph_callers`, `graph_file_api`, `graph_map`;
- [computer use](computer.md), when on;
- memory, `customize_ui`, loops, worktrees and the rest of the session's tier.

Not passed on: files, shell, code search, questions, plans, sub-agents and skills that Claude Code handles itself. MendCode's own `mcp.json` servers are not passed on either; Claude Code has its own MCP configuration.

#### Web tools

MendCode's [`webfetch` and `websearch`](tools-web.md) are passed on despite Claude Code having its own. Claude Code refuses some sites, including reddit.com, and has no search on some plans.

It is told to call MendCode's tools when its fetch or search refuses a site or is missing. They run in MendCode from your machine, using your search key or ChatGPT login.

#### Approvals and bridge

A call runs in MendCode as part of the turn. It gets the same approvals, plan-mode refusal, secret masking, output limits and card as a native call. Claude Code is not asked a second time.

The daemon serves a loopback MCP server (`127.0.0.1`, random port, no browser origins). It starts `claude` with `--mcp-config <private file>`.

One bearer per session is kept in memory and a `0600` temporary file. It runs nothing unless that session has a running turn. Your Claude settings are never edited.

Claude Code lists MCP tools through its own tool search, so their schemas cost nothing until used.

#### Sub-agent instructions

Claude Code's sub-agents (Explore, general-purpose, yours) have their own system prompts without server instructions. MendCode registers a `SubagentStart` hook at `initialize` and supplies the same instructions as `additionalContext`.

They therefore reach for the code graph before `grep`/`sed`. Nothing is added when the feature is off or the session has no MendCode tools.

With [graph autopilot](code-graph.md#autopilot) on (full tier; nightly, dev and local builds by default), instructions also say:

- MendCode builds and refreshes the graph itself; never skip it for lack of one.
- A "still building" answer means use text search meanwhile.

#### Images

`mcp__mendcode__image_gen` is MendCode's [`image_gen`](tools-web.md#image_gen-permission-write). It uses the same approval, wait canvas and finished image card as a native session.

Native ChatGPT sessions use the provider's hosted image tool instead. Claude Code has none, so `image_gen` works here without an `image_generation` setting, through your ChatGPT login (MendCode's own or the Codex CLI's) or a saved OpenAI provider key.

It uses model `gpt-image-2.6-sunburst` and saves images under `<dataDir>/generated_images`. `image_generation.enabled: false`, `MENDCODE_IMAGE_GEN=0` or `--offline` remove it.

Images attached to the message are the "recent images" an edit can take. One line of server instructions tells the model it can make images.

#### Codex bridge

A `codex:<model>` session on the native daemon gets the same tools, gated the same way, as its `mendcode` MCP server. This does not apply to the older daemon started with `--engine codex`, whose one process serves every session.

Its `codex app-server` process belongs to the turn. It starts with `-c mcp_servers.mendcode.url=<bridge>` and `bearer_token_env_var="MENDCODE_MCP_TOKEN_MENDCODE"`.

The bearer is only in that process's environment, never its arguments or traces. Its name contains `TOKEN`, so Codex keeps it out of model commands. With `/env` credentials, its name is in `shell_environment_policy.exclude`.

`default_tools_approval_mode="approve"` stops Codex asking about calls through its default MCP elicitation. MendCode asks once when running the call; any Codex elicitation is accepted without the user, while another server's is declined.

`tool_timeout_sec=86400` allows waiting on approval cards or long computer-use steps. Codex's own default is 60 s.

Codex 0.162 does not put MCP server instructions in the model prompt. They go into the thread's `developerInstructions` after MendCode's note, in every prompt mode as Claude's server instructions do; `minimal` still leaves the note out.

Those instructions say tools are nested under `exec`: `await tools.mcp__mendcode__graph_find({ query })`, with the rest in `ALL_TOOLS` and no ToolSearch. MendCode draws its own call card, not Codex's.

### MCP changes

Claude Code reads servers when its process starts. A turn that ran `claude mcp add|remove…` or wrote `.mcp.json` / `.claude.json` ends that process.

The next message starts a new process that resumes the conversation with the new server's tools.

### Approvals and questions

When Claude Code asks permission, MendCode shows its normal approval.

| Choice or mode | Effect |
|---|---|
| "Always" | keep Claude's suggested rule for this session only; never write it to Claude settings |
| `edits` | approve file changes |
| `full` | approve everything |
| `plan` | refuse changes |

Claude's AskUserQuestion becomes a MendCode question. One question is shown alone; several, up to four, become one batch with tabs.

Each answer goes back under its question. A multiple choice is its labels joined with ", ".

The desktop notice "Claude needs your permission to use AskUserQuestion" is not MendCode's. It comes from a `Notification` hook in your Claude settings, run by Claude Code for every permission request, including this one.
### Task lists and plans

TodoWrite and TaskCreate/TaskUpdate, kept per Claude Code process, become MendCode's list card (`todo d/n`). The progress row above the prompt, dock and Todos card show them; the item in progress reads as its `activeForm`.

A sub-agent's TodoWrite stays in its thread ([the visible plan](layout.md#the-visible-plan)). Codex's `update_plan` and an ACP agent's plan are drawn the same way.

ExitPlanMode opens the same [plan review](plan-review.md) page as a native session:

- Enter applies and leaves plan mode with full access; `m` picks another access.
- Accept, edit and comment, reject and Esc keep plan mode and answer Claude with the change you requested.

Claude Code has no destination agent, so only `build` is shown.

### Permission modes

| MendCode | Claude Code |
|---|---|
| `ask` | default |
| `edits` | acceptEdits |
| `full` | bypassPermissions |
| `plan` | plan |

The mapping follows mode changes between turns. Bypass mode still lets Claude Code raise its safety checks, such as a dangerous `rm` or protected path.

In `full` access MendCode allows those unattended. With `engineSafetyPrompts` set to `true`, they reach you as an approval with Claude's reason: allow once or reject ([permissions](permissions.md#commands-the-engine-flags-in-full-access)).
### Stop or send now

Esc interrupts the Claude turn. Claude Code also stops the session's background agents and will not resume them: `SendMessage` answers that the agent "was stopped by the user and won't be resumed".

Each stays in the Agents strip as `stopped by you · /relaunch` until a turn begun after the stop ends.

Use `/relaunch`, or `/relaunch <words of its description>`, to ask Claude to start it again as a new agent with the same type and prompt. The message includes how far it got: tool count and last tool.

An agent Claude Code backgrounds on its own without `run_in_background`, whose result says `async_launched`, counts as a background agent too.

**Send now** on a queued message (`ctrl+s`, its `SEND` button) does not stop agents. The message enters the running turn like Claude Code's own send-now:

1. The step at hand ends; a command it was waiting on moves to the background.
2. Background agents keep running.
3. Claude answers the message as its next turn.

### Process restarts

Background agents live inside the `claude` process and end with it.

| Cause | Restart behavior |
|---|---|
| MCP change (`claude mcp add`, `.mcp.json`) | wait until no background task is running |
| New model or effort | restart the process |
| Idle process | restart after 10 min with nothing in the background |
| `/env` credentials | wait like an MCP change |

Each end is logged to daemon stderr with its reason and background-task count: `[CLAUDE]: <session> process ended: …`.

The Agents strip drops those tasks at once. No row stays behind for a stopped agent.
### Fast mode

With `/fast` on, Opus 5.5, Opus 5, Opus 4.8 or the `opus` alias starts with `--settings '{"fastMode": true}'`. This is Claude Code's own fast mode, for that process only, never saved to Claude settings.

Toggling it restarts the process like an effort change. On other models the footer mark reads `n/a` and `/fast` says why.

### Quota and usage

Your Claude subscription's 5h and 7d windows appear in `/usage` and the footer, from Claude Code's rate-limit events.

Tokens are counted under provider `claude`. No cost is shown because the subscription has no per-token charge.

During a turn, the working row updates its output-token count live. That count is not stored; the exact figure arrives with the turn's usage record.

### Cache lifetime

Cache lifetime is opt-in, off in every tier. Enable `claudeCacheTtl: true` in `/settings`, Behavior, row `claude ttl`, with `promptCacheTtl: "1h"`.

Each new `claude` process then gets `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h` in its environment.

These are the two variables [Claude Code documents](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself): main conversation, and everything else (sub-agents, workflows, compaction). They require Claude Code v2.1.242 or later; older versions ignore them.

At `5m`, nothing is passed and Claude Code keeps its own defaults:

| Login | Main conversation | Sub-agents |
|---|---|---|
| Subscription within plan usage | an hour | 5 minutes |
| API key or cloud provider | 5 minutes | 5 minutes |

A running process keeps what it was started with.

## Per-turn selections and forks

`session send` and `--command` accept `--model`, `--agent` and `--variant` on a Claude Code session, or to borrow a Claude model for one turn of a native session. They apply to that turn only and leave the saved model and agent alone.

### Model, effort and variant

| Selection | Effect |
|---|---|
| Model | the turn runs on it; the `claude` process restarts, resuming the Claude session, then restarts on the saved model next turn |
| `--effort LEVEL` | documented spelling on `run`, `session create` and `session send`: `low`, `medium`, `high`, `xhigh`, as the model lists them |
| Variant naming a model effort | accepted as that effort; `--effort` is preferred |
| Other variants, or a model without efforts (Haiku) | refused; Claude Code has no provider variants |

### Agent ceiling

Claude Code runs its own agent loop. A MendCode agent applies as a permission ceiling: the `plan` agent makes the turn read-only. Its instructions go before the message Claude receives.

The agent's tool allow/deny lists do not bind Claude's tools. Subtask commands need the native task tool and are refused.

### Fork a conversation

`session fork --message-id` and `/fork` cut the copied transcript as for native sessions. Claude Code keeps its own conversation, which is not forked.

The fork's first Claude turn therefore starts with the copied conversation as a budgeted handoff:

- newest turns, original request and command outcomes;
- `handoffTokenCap`, default 16,000 tokens;
- secrets as markers.

Later turns do not repeat it. A daemon whose engine fixes its own model (Codex, faux) still refuses per-turn selections.

## Limits

### Switching engines

Switching between a native and Claude model, or an ACP agent, keeps each engine's history. An engine that missed turns gets them before your next message as a budgeted handoff, never summarised by a model ([sessions.md](sessions.md#portable-handoff-between-engines)).

`/model` says what will be handed over. Making Claude the default moves no session that already ran. A switch while a native turn runs applies next turn ([sessions.md](sessions.md#the-default-model-and-running-sessions)).

### Read context usage

Claude Code keeps the request itself. `/context` reports what MendCode knows:

| Measurement | What it shows |
|---|---|
| Last call's measured context | exact |
| MendCode's transcript by role | user, assistant, tool results, at chars / 4; each image at 1,500 tokens |
| Rest of the measurement | one unsplittable line: `Claude Code base (system + tools + instructions)` |

Before the first answer, used context shows `—`, not a guess. Codex sessions get the same report.

The denominator in the footer, sidebar and `/context` is the session's compaction point: the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` its `claude` process started with.

A process started before a setting change keeps showing its own value; the next turn restarts it with the new one. The model window, 200K or 1M, is listed separately as `Model window`.

### Compact a conversation

MendCode never compacts Claude Code sessions on its own; Claude Code manages its context. `/compact`, with any instructions, goes to Claude Code as its own `/compact`.

The transcript gets a compaction card with the summary Claude Code continues from. If there is no Claude Code conversation yet, or the model switched to one without session history, `/compact` does nothing and says why.

With `claude_compact` (balanced and full; `/tier claude_compact off`), Claude Code compacts at MendCode's point. Each new `claude` process gets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set to the absolute point MendCode's models use:

- `MENDCODE_COMPACT_AT_TOKENS`;
- the model's `modelContext` `compactAt`;
- `compactAtTokens`;
- `compaction.token_limit`;
- otherwise 200,000 tokens.

Claude Code compacts a summary's room before that point. A value already in the daemon's environment is kept.

Without the feature, Claude Code waits for its own window, 1M for Opus. Every tool call re-reads the whole context from cache: 400k costs twice 200k on each call.

### Delegate beyond Claude

Claude models are for whole sessions; Dream and compaction use native models. Full-tier `task {engine:"claude", model:"claude-sonnet", ...}` can launch a daemon-owned Claude child.

The opt-in [thread MCP bridge](thread-mcp.md) exposes delegation and thread verbs inside Claude/Codex processes. From an Opus Claude Code session, `delegate_task` starts a sub-agent on:

- a native model, such as `gpt-6.1-terra` on your ChatGPT login;
- a Codex model;
- an ACP agent.

Bridge instructions name those models because Claude Code's Agent tool lists only Claude's. Without the bridge, one line tells the session how to enable it: full tier, `/tier thread_mcp on claude`.

### Messages, silence and attachments

A message sent during a turn enters at its next tool result, as in Claude Code. Claude reads it after the step at hand; one taken only after the turn's answer is done is answered in the same turn.

A saved `/queue` policy wins.

A quiet turn is never cut. Claude Code times out and retries its API calls itself; a long think over images or at high effort can be silent for minutes.

Esc stops it. The working row shows no `no response for` hint either.

Images are sent as attachments. Other files are named in the message but not sent.

## Started from Claude Code

A daemon started from a Claude Code shell would otherwise pass that session's variables to every command, engine and app it starts. A `claude` opened there would think it was that session's child and disable transcript saving.

This includes an agent running `mendcode --dir X session list`, `mendcode daemon restart` or `mendcode __daemon`. Those variables are never passed on; you need not unset anything by hand.

### Which variables are removed

- **Always dropped** (set by Claude Code 2.1.314 in its tool shells or on its own process): `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_INVOKED_SKILLS`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, and `CLAUDE_CODE_SSE_PORT` (the IDE window of that terminal, which Claude Code itself drops for a detached process).
- **Dropped only with Claude Code's value**: `AI_AGENT` when it starts with `claude-code`; `GIT_EDITOR=true` and `TRACEPARENT` when `CLAUDECODE=1` is set too.
- **A tuios pane's**: a terminal in a [tuios](https://github.com/Gaurav-Gosain/tuios) pane that starts the daemon would hand it that pane's identity and token, so every command of every session would speak to tuios as that one pane. `TUIOS_ENV`, `TUIOS_HOST`, `TUIOS_SOCKET`, `TUIOS_SESSION`, `TUIOS_WINDOW_ID`, `TUIOS_PANE_ID`, `TUIOS_PANE_TOKEN`, `TUIOS_PANE_GRANTS`, `TUIOS_PANE_TTY` and `TUIOS_RESTORED` are dropped too, except in a terminal that hosts the daemon in its own process: it is that pane. A Rex block's `REX_SESSION` and `REX_BLOCK` are dropped the same way; `REX_SERVER` and `REX_BIN_DIR` stay.
- **Kept**: everything you set for the engines: `ANTHROPIC_*` (`ANTHROPIC_API_KEY` enables the [provider](providers.md), `ANTHROPIC_BASE_URL`), `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK` and the other `CLAUDE_CODE_*` settings, cache lifetimes.

### Restart and environment cleanup

`mendcode daemon restart` starts the next daemon itself, with its own environment and folder. While it runs, at most 15 s (`<dir>/daemon-restart`), open terminals and `mendcode` commands that lost their daemon wait for it instead of starting another.

| Launch path | Cleanup |
|---|---|
| CLI | starts the daemon without inherited session variables |
| launchd and systemd services | never had them |
| Daemon program started with them | restarts once in place, same pid, without them |
| `daemon start --foreground`, `serve`, `web`, compiled terminal hosting the daemon | also restart without them |

Removing variables only from a running process would not suffice. Bun gives a child started without an explicit environment the one the process started with.

On Windows and in a terminal run from source that hosts the daemon, variables are removed from the process only. Every child given that environment honours it.

The daemon log names what was dropped, never a value: `[ENV]: dropped inherited session variables: CLAUDECODE, ...`.

## Debugging

`MENDCODE_CLAUDE_TRACE=/tmp/claude.jsonl` writes every protocol line, in and out, capped at 2 KB each.

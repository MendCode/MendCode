# Custom agents, sub-agents and task status

An agent is a markdown file: frontmatter that configures it, and a body that is added to the system prompt of every model
call it makes. Ported from v1 (`agent/agent.ts`, `.mendcode/agent/*.md`) onto v2's extension layers. Code:
`packages/packages/src/agents.ts` (reading and validating files), `packages/engine-native/src/agents.ts` and `engine.ts`
(running as an agent), `packages/daemon/src/agents.ts` (layers, trust, the commands).

## Files

`agents/<name>.md` in every extension layer, lowest precedence first, like skills, commands and custom tools:

| Layer | Folder | Trust |
|---|---|---|
| a user package | `~/.mendcode-v2/packages/<pkg>/agents/` | always |
| the user's own | `~/.mendcode-v2/agents/` | always |
| a project package | `<project>/.mendcode/packages/<pkg>/agents/` | project must be trusted |
| the project's own | `<project>/.mendcode/agents/` | project must be trusted |

A later layer wins a name, and only then is the 100-agent cap applied (the lowest-priority layers drop first); `agents.list` carries `overridden` entries and the dropped ones appear under `problems`, and `/doctor` prints both. **Trust** is the one custom tools use (`tools.trust`, `/tools`, the `trustedToolDirs` setting):
an agent file of a cloned repository adds text to the system prompt and can widen tools and permission, so it does nothing
until the user trusts the directory. `agents.list` still shows an untrusted agent (`trusted: false`) so the user can see
what trusting would enable; it cannot be selected, is not offered to `task`, and never replaces a trusted agent of the
same name. Taking the trust back stops a selected project agent from applying at the next turn.

```markdown
---
name: reviewer            # default: the file name; lowercase letters, digits, _ and -
description: Reviews a diff without touching it   # required, at most 300 characters
mode: primary             # primary | subagent | all (default all)
model: gpt-6-sol          # optional, a catalog model id (`<provider>:<model>` for API providers)
effort: high              # optional: minimal | low | medium | high | xhigh
tools: [read, grep, glob] # optional allow list; a trailing * matches a prefix (mcp__github__*)
deny: [shell]             # optional, removed after the allow list
permission: ask           # optional cap: plan | ask | smart | edits | full
---
You review code. Read what changed, run nothing, edit nothing. Report findings as a list…
```

Lists may be inline (`[a, b]`), comma separated, or a block of `- item` lines. Nested YAML maps are supported. The body
(at most 16 000 characters), or `prompt`, supplies the prompt. Files over 32 KB and invalid fields appear under `problems`.
`build` and `plan` can be overridden; other active agents require a description. Disabled stubs do not.
`temperature`, `top_p` and `options` tune generation; unknown fields join `options`. `variant` applies when the agent sets
its own model. `steps` (deprecated alias `maxSteps`) reserves the last model call for a response without tools.
`hidden` omits picker/cycle entries; `disable` prevents execution. `color` accepts a six-digit hex color or a theme role
(`primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`) and colors the picker and footer.
See [advanced configuration](advanced-config.md) for daemon-owned overrides, defaults and output limits.

## Primary agents

`agents.list { directory?, sessionId? }` (read-only) answers an `AgentsReport`: `{ directory, agents, current?, problems }`
with the built-in `build` and `plan` first. `current` (with a session) is `plan` while the session is in plan mode, else the
selected agent when it still runs, else `build`.

`session.agent.set { sessionId, agent }` (`agent: null` = `build`) selects the session's primary agent from its next turn
and answers the same report. The choice is stored with the session. Refused with `target_mismatch` for an unknown agent, a
`mode: subagent` one, or an untrusted project one. Like `session.model.set` it raises no event: the ack is the answer.

- **`build`** is today's behaviour: every tool, the session's own model and permission mode.
- **`plan`** is plan mode. Selecting it sets the session's permission mode to `plan` (every client sees
  `session.permission`), and selecting any other agent, `build` included, leaves plan mode (back to `ask`), as approving a
  plan does. So the picker can never show one agent while the session runs as another; plan is not stored as an agent.
- **A custom primary agent** changes, for that session's turns:
  - the system prompt: `# Agent: <name>` and the body are appended after the project prompt (before the secrets note, so
    a stable prefix stays cacheable); `/context` shows it as `system · agent <name>`;
  - the tools: `tools` keeps only the listed ones, `deny` removes more. `plan_submit` and the `secrets` marker tool stay
    whatever the lists say, so plan mode and pasted secrets keep working. A tool the agent lacks is unknown to it even if the
    model calls it anyway. The same applies to MCP, custom and extension tools, by their names;
  - the model: `model` replaces the session's (and the `plan`/`subagent` role settings) for the agent's calls, with its
    `effort`, or the model's default effort when none. `effort` alone keeps the session's model. An effort the model does
    not support falls back to the model's default, as for any choice. Usage is recorded under the agent's model;
  - the permission: `permission` is a cap. The effective mode is the session's, lowered to the cap, never raised
    (order: `plan` < `ask` < `smart` < `edits` < `full`): an agent with `permission: ask` asks for writes even in `full`
    mode, and one with `full` does not lift a session in `ask`. `plan` makes the agent read-only (model role `plan`;
    `plan_submit` can be reviewed but an approval does not lift the cap).

Agents apply to the native engine. Sessions on Claude Code or Codex models run in those engines' own processes and ignore
agents. Files are read at each turn, so an edit applies to the next turn without restarting the daemon.

**Claude agent files** (`.claude/agents/*.md`, read when foreign resources are on) are converted, never widened:
`tools` becomes an allow list of MendCode tools (`Bash` is `shell`, `Skill` is `skill`); names that are not tools here are
dropped, and a list left with none grants no tools (it is not "every tool"). An entry with a qualifier (`Bash(git status:*)`)
grants nothing, because the bare tool would be wider; a qualified `disallowedTools` entry denies the whole tool.
`permissionMode: plan` and `acceptEdits` cap the agent at `plan` and `edits`; `bypassPermissions` is never granted by a file,
and `default` adds no cap. `model` and `effort` apply when the model is in the catalog (`sonnet`-style aliases and `inherit`
use the session's model). Fields with no equivalent (`skills`, `hooks`, `maxTurns`...) are ignored. Everything that could
not be honoured is listed as a `warning:` in the `problems` of `agents.list`, with the file.

The terminal supports `/agent`: ↑↓ selects a trusted primary agent, Enter applies it, and Esc returns to chat. The list shows names, short descriptions and `(current)`. `/agent <name>` selects directly; an unknown name shows `unknown agent: <name>`. A successful change shows `agent: <name>` in a toast. `/agents` remains the running-activity page.

## Sub-agents

The native engine delegates through the daemon. Every task owns a durable child session and transcript, with a `task_id` (the child session id), parent/root ids, depth, generation and lifecycle state. `general` handles research and multi-step work without todo management; `explore` is read-only: file search, reading, shell, web and, while the code graph is on (`codegraph`, balanced and full), `graph_find`, `graph_callers`, `graph_file_api`, `graph_map` and `code_search`. It is told to locate with the graph before reading files and to return locations (`path:line`), relations and evidence rather than an inventory. `agent.explore.deny: ["graph_*", "code_search"]` takes the graph tools away from it. Trusted custom subagents can replace these profiles.

`task { description, prompt, agent?, subagent_type?, task_id?, model?, variant?, background?, isolation?, fork? }` runs in the foreground by default. `subagent_type` aliases `agent`. The tool's description names a bounded catalog, sent on every request: the first `subagentCatalog` sub-agents (default 6; `general` and `explore` first, then the installed ones by name), one line each cut to 80 characters, then `+N more: agent "?" lists them`. `agent: "?"` runs nothing and answers every name with its whole description; an unknown name is refused with the available names. So installing many agents does not grow every request, and an agent's prompt only reaches the child that runs it. `subagentCatalog: 0` names none (only the count). The catalog exists only where `task` is offered (`subagents`, balanced and full), so minimalist pays nothing. Use `task_id` to continue the same saved conversation after completion, cancellation or restart. An active child cannot be resumed, and another parent cannot resume it. `model` may use `model#variant`; a conflicting explicit variant is refused. An explicit model starts a fresh model choice; resuming without an override keeps the child's choice. So `task_id` with `model` moves a child to another model with its whole history: after a provider's usage limit, or to finish on a cheaper one; later resumes stay on it. Agent model/effort and the `subagent` role supply defaults. A Claude model on the user's Claude login (Opus, Sonnet, Haiku through Claude Code) is delegated to with `engine: "claude"` and its exact id; asked without it, the refusal says so, so the model does not settle for another provider's copy of the same model.

**Sub-agent model.** A task's model is, in order: its own `model`, the agent profile's `model`, the `subagent` role
(`/model roles`), then the session's model. With `cheap_subagents` (balanced and full; `/tier cheap_subagents off`
turns it off) and no `subagent` role, a session on a large model (Opus, Fable, Sol, Pro, Ultra, Max) delegates to the
same provider's mid tier instead: the ChatGPT subscription's Luna, a key provider's Sonnet, mini or Flash (else Haiku,
lite or nano). A session already on a mid or small model, or a provider with nothing cheaper, keeps its own. Claude
Code's own Agent tool gets the same rule through `CLAUDE_CODE_SUBAGENT_MODEL`: the `subagent` role when it is a Claude
Code model (`claude-haiku` → `haiku`), else `sonnet` under an Opus or Fable session, set when its process starts and
never over a value the daemon's environment already has. pi's subagent extension inherits the session model unless an
agent names one; minimalist does the same here.

Children inherit the caller's effective permission, lowered by their profile's cap. Their tools follow the profile's allow/deny lists and exclude main-only controls. Nested `task` calls are offered when the profile allows them, with daemon admission limits from `settings.set`: `subagentDepth` (default 1, 0 disables), `subagentMaxChildren` (4) and `subagentMaxDescendants` (16). The last two are also in `/settings` under Subagents (`at once`, `whole tree`), and the limit error names the current number and that row. Counts include only queued, running and approval-waiting children, so a finished task frees capacity. Restart marks unfinished children interrupted; it never silently reruns a prompt. A child works in its parent's directory unless the parent asks for isolation (below): there is no automatic worktree per sub-agent (the `worktree` tool is the main session's, and a child session cannot change worktree), and no scratch folder per session (`/scratch` is one private note per project, 8,000 characters, that never reaches a model). A conversation tree can start at most 256 children over its whole life, finished ones included (`subagent accumulated-spawn limit reached`; continue an existing `task_id` instead).

**Worktree isolation** (full tier, feature `task_worktree`; `/tier task_worktree off` removes it). `task` (and `task.run`) takes `isolation: "worktree"`: a new child gets a detached git worktree of its parent checkout's `HEAD` under the daemon data directory (`tasks/worktrees/<id>`), at the same subfolder the parent works in, and its session lives there, so its edits never touch the checkout. Uncommitted changes of the checkout are not in it. Agents and their trust still come from the parent's project. When a generation ends, whatever it changed is committed on `mend/task-<id>` (the same commit-and-measure step a script workflow's worktree agent gets) before the task counts as ended, and its result ends with one line for the parent: `[worktree] <path> · branch mend/task-<id> @ <commit> · N files +I -D · not merged; review: git diff <base> mend/task-<id>`. `task.list` carries it as `worktree { path, base, branch, commit, files, insertions, deletions, changed }`. Nothing is ever merged into the checkout and nothing is removed: merge or cherry-pick the branch yourself, then `git worktree remove <path>`. Resuming the child (`task_id`) keeps its worktree, and every generation adds its commit to the branch. Refused without a git checkout with a commit, in plan mode, in safe mode, and outside the tier; the argument is in the `task` schema only while the feature is on, so balanced pays nothing for it.

### Forked sub-agents

**Fork** (feature `task_fork`, full tier, opt-in: `/tier task_fork on`; off with every tier until then). `task` (and `task.run`) takes `fork: true`: a new child starts from the parent's conversation instead of a fresh context, as Codex's `preserve_fork_prefix` does. Its first request is the parent's latest main request, byte for byte (the same system prompt, tool list, model, effort, parameters and messages, old tool outputs pruned as they were sent, under the same prompt-cache key), plus one user message: a short note that the conversation above is the parent's and that the task below is the child's own, then the agent's instructions when `agent` names one, then `prompt`. So the provider reads that whole prefix from its cache and the prompt only needs the task. The child keeps its own permission, depth and admission limits, and its agent's tool lists; the parent's main-agent tools (`question`, `plan_submit`, `sidebar` and the rest) stay in the list so the prefix matches, and fail with `unknown tool` if called. Later calls of the child keep the parent's system prompt, tools and key, while its own messages grow behind the inherited ones. The task's answer starts with `context: forked`.

A fork needs the parent's latest main request on record and the same model, because a cache is read only by the model that wrote it. Otherwise the child runs fresh and the answer starts with `context: fresh (fork unavailable: <why>)`: another `model`, a `variant`, another `engine`, `isolation: "worktree"` (the child works elsewhere), a resumed `task_id`, no main request on record (a daemon restart, plan mode, a compound session) or a parent history changed since that request. A child whose fork is decided only when its turn starts (the daemon's task registry) can still run fresh if the parent compacted in between. Its session runs on the parent's model whatever the `subagent` role says, so its compaction and record name the model it really used; `task.list` marks it `fork: true`. The inherited prefix is kept in memory: after a restart, a resumed fork child runs with its own system prompt and tools on its saved history, and a compaction of the child ends it.

The trade-off: a fork carries the parent's whole context, so every one of its calls reads that context again, cached or not. Cached input costs less (on OpenAI about a tenth) but still counts against the context window and the per-call read; a long child of a big parent pays the parent's size on every step, where a fresh child pays only its own. Fork when the task needs what the parent already read or decided; start fresh for independent work. Measured live on 2026-10-18 with chatgpt/gpt-6-luna (effort low), parent reading two files and then delegating the same task (list the lines of `child-tasks.ts` that use one set), twice each: the fork's first and only call read 22,400 tokens from the cache and 188 uncached, and answered from context; the fresh child's first call read 13,667 uncached (its own system prompt and tools) and 0 cached, then grepped the file and needed a second call (13,568 cached, about 605 uncached). Per call the fork read more (22,588 against 13,667 and 14,175), in total it sent 188 uncached tokens against about 14,270.

Full tier also accepts `engine: native|claude|codex|pi|acp:<name>` on `task` / `task.run` for a configured model on that engine. External child engines refuse agent tool/path restrictions they cannot enforce. The opt-in [thread MCP bridge](thread-mcp.md) offers `delegate_task` inside Claude/Codex processes, with the same task registry and caps.

`background: true` returns the id immediately. `/tasks` opens the current parent's child list, one short row each (`state · description`); the selected child's panel adds, each only when known, what it ran on (`Model`), what it spent over all its runs (`Usage`: `48.2K in · 1,204 out · $0.04`, tokens read fresh and cached, tokens written, and the cost when every call had a price), the files its edit tools wrote (`Files`, the first 20) and, for an isolated child, its `Worktree` and `Branch`, then the result. `task.list` carries the counts as `stats { input, output, costMicros?, files }`, written when a generation ends. ↑↓ selects, Enter opens the actual child chat, `x` cancels, `b` detaches, `w` waits briefly, PgUp/PgDn scrolls the saved result, `r` refreshes, Esc returns. Ctrl+X Down opens the first child (or first sibling from a child). In a child with an empty prompt, Right/Left cycles siblings in v1 ID order and Up returns to the parent; a nonempty draft keeps normal cursor/history keys.

While the open session has sub-agents, the chat shows them live as a tree hanging from the working line: one row each with what it was asked, `await` (the session waits for it) or `bg` (background), what it is doing now (the tool in flight, `thinking`, `needs you: …`, `queued`, `paused`) and how long it has run. The agent's name is a column only when the rows differ in it. Rows have no spinner of their own, so they never read as more working lines, and they stop short of the session pet, which stands on the prompt beside them. While the session rests and its sub-agents still work, a head line takes the working line's place: `Agents  2 running · 1 needs you`, with the key that opens one (`ctrl+x ↓`). One that ends stays 8 seconds with its outcome (`done`, `failed`, `cancelled`, `interrupted`) and the time it took. Four rows at most, then `+N more · /tasks`; under 60 columns the mode is dropped. The tree is drawn by the terminal from `task.list` (asked again on each `task.changed` of the session) and the `session.activity` push, which carries a sub-agent's session from the moment it waits on you until it ends (that is the `needs you` the row shows); a view can restyle it as the `bar` slot's `agents` variant. A click on a row opens that sub-agent. So does a click on its `Task` card in the chat (`ctrl+o` still opens the card's result). Each sub-agent has a colour of its own, the same on its card and on its row. In the `full` tier the row (when the window is wide enough) and the `Task` card also say what the sub-agent runs on, as the daemon resolved it when it launched it: model, provider, engine, effort and `fast` (`GPT-6-Luna · openai · native · low · fast`); `minimal` and `balanced` leave it out. `task.list` carries it as `run` on each record.

`/tree` shows the children as nodes under their parent next to the forks, with agent, model, state and the first line of the result, and the right-bar `agents` card is the same tree below the open session ([sessions.md](sessions.md#lineage-tree)).

`/bg` (`/background`) persists detachment without cancelling the session and opens a fresh home in Agent View. `/agents` adds a Background tab (`3`) for registered sessions, including completed children, approval state, saved summaries, metadata and writer presence. Enter reopens the transcript; `a` opens pending input, PgUp/PgDn scrolls details, `r` refreshes. Panels use the available terminal width and stack on small terminals.

Background completion, failure, cancellation and interrupted recovery create one durable owner notification per task generation. Notifications are batched (up to 16) into a single notice per owner. A stable queue id prevents replay after a crash between enqueue and acknowledgement. A busy owner on the native engine reads it inside its running turn, after its next tool result (one message together with any background-shell notices that wait, in the order they happened, and without changing the turn's authority); when the turn ends first, is paused, waits on an approval, or the engine has no such point, the owner receives it at its idle boundary. A completion the owner's model already read with `task_status` (`get` or `wait`) is not announced again. Cancelling the owner dismisses pending notifications and suppresses late ones until the user resumes. Child results are quoted as untrusted evidence and secrets are redacted before crossing sessions. `subagentOwnerWake` defaults on and can be disabled in `/settings` or `settings.set`; foreground completion never creates a notice.

RPCs: `session.children`, `session.background.list/register/remove`, `session.background.writer.acquire/release` and `session.agent-view.metadata.list/get/patch`. Metadata supports title, tags, group, priority, notes, pinned and archived; null resets a field, and an empty record is removed. Writer leases are nonexclusive last-writer presence (30 seconds by default), tied to the calling client rather than supplied identity. The CLI renews its presence and releases on navigation or exit; expiry hides stale presence. Mutating background/metadata operations remain local-only.

`session.agent-command.list` accepts no session for the global inbox, or `incoming: true` for a target; `session.agent-command.list-by-session` lists incoming commands. `session.agent-command.patch` lets a subscribed target update valid lifecycle transitions and result/error fields. Existing create/review commands retain same-project scope and target approval. HTTP translation is a separate bridge; these are daemon protocol operations.

## Agent control: pause, resume, stop

`session.control { sessionId, action: pause | resume | stop }` controls one session (a main session or a sub-agent's child session); the ack is `{ paused, cancelledTurn, cancelledChildren }`.

- **pause** never cuts a running turn. The turn finishes, then nothing new starts (queued prompts, notices, owner wakes, goal steps) until resume. Prompts sent meanwhile queue; the session reads `queued` with `paused`. The flag is in memory: a daemon restart clears it (a recovered queue is held anyway until the user acts). A paused session is never evicted from memory.
- **resume** clears the pause and any user-cancel/restart hold, starts the next queued entry and lets an active goal continue.
- **stop** cancels the running turn and every running child task under the session (nested ones included, at most 64), which holds the queue like Esc does. Resume releases it. With nothing running it is a no-op.

`session.activity` events and `session.list` rows carry `paused: true` while paused (additive field), so every client can show it.

Decisions taken on authority: the person at the terminal is the authority, so these three controls are direct. Over a remote token they are refused for read-only peers (not in the read set) and allowed for full-access peers, exactly like `turn.cancel`. Session-to-session `pause`/`stop` agent commands (`/agents pause|stop <id>`) remain approval-gated: they run only after the target session's own client accepts the request (`a` in the inbox), only inside one project, and never from a remote peer. A requesting session cannot resume the target; the user does that.

Terminal: in `/agents` (Running or Background tab) `p` pauses the highlighted session or resumes a paused one, and `x` then `x` again stops it (any other key drops the confirmation). A paused session stays listed as `paused` (`working · pausing` while its turn runs). `/pause [id]`, `/unpause [id]` and `/stop [id]` act on the current session or an exact id; the chat queue panel reads `Paused` with `/unpause to continue`. CLI: `session pause|resume|stop <id>` (`--json` envelope). Frames of the page are unchanged apart from the extra hint and label.

## `@agent` mentions (C7)

Typing `@` in the prompt offers the usable sub-agents (not primary, trusted, visible, enabled) above the files, tagged `agent`.
A prompt that contains `@name` for a sub-agent of the project reaches the model with an `<agent-mention>` note telling it to run
that agent through the `task` tool (`agent: "name"`); the transcript keeps the text as typed. `@name` for anything else is left
alone, at most four mentions count, and a broken agent file never blocks the prompt. The daemon does this for every client,
and only while sub-agents are on (`subagents`: balanced and full); minimalist has no `task` tool, so it adds no note.

**Addressing a child.** A prompt that *opens* with `@name message` while this session already has a child of that agent (the
newest one) goes to that child instead of the parent's model: it continues the child's own conversation (`task_id`) as a
background generation, so the parent is told when it ends like any background child, and the parent's model is not called
for it. The prompt's reply says what happened, and the terminal shows it as a toast:

- `@explore · delivered: its task resumes in the background and reports back`: the child was idle and runs now;
- `@explore · queued: its task gets it when its current step ends`: the child is still working; the message waits (up to 4
  per child, then the prompt is refused) and resumes it the moment its current generation ends. Held messages are also kept
  in `<dataDir>/agent-mentions.json` (0600): a restart interrupts the child, and the restarted daemon resumes it with them. If
  the resume fails, the parent gets a notice with the text.

The reply carries `mention: { agent, taskId, delivery: "delivered" | "queued" }`. A mention anywhere else in the prompt, a
name with no child yet, or `agentMentions: "delegate"` (setting; default `address`) keeps the note above.

## Prompt fragments (`prompts/*.md`): not added

A `/prompt-name` expansion of a markdown file per layer is exactly what `commands/*.md` already is (`$ARGUMENTS`, positional arguments,
`argument-hint`, nested folders as `name:space`, the same layers, `commands.list` / `commands.expand`, `/name` in the
prompt), so a second folder would be a duplicate with a different name. Put fragments in `commands/`. Packages carry
`commands/` and `agents/`; the package manifest needs no new field for agents (markdown, nothing to declare like
`extensions`), and `packages.list` counts them in `contents.agents`.

Commands also accept JSON templates and agent/model/subtask attributes. `/init` guides repository instructions; `/review` opens a saved child. See [commands.md](commands.md) for execution, shell/file expansion and MCP prompts.

## `task_status`

`task_status { task_id?, action?, timeout_ms?, id?, tailChars? }` adds child inspection without changing shell/workflow calls:

- `action: list` lists this parent's children; `get` returns one child's state and result.
- `wait` waits once, default 30 seconds, capped at 300 seconds; it reports `wait_timed_out`.
- `cancel` cancels the exact child. A foreground parent cancellation also cancels its child; background children continue independently.
- Existing `id` routes to shell tasks (`bg_…`) or workflow receipts. With neither id nor action, the tool includes children alongside shell/workflow status.

Protocol: `task.run`, `task.list`, `task.status` (`get`, `wait`, `cancel`, `detach`) and `session.detach`. Client `tasks(sessionId)` lists typed child records.

## Ported from v1, and left out

Ported: agent files with description/model/prompt/permission, primary and subagent modes, tool allow/deny, the `build`/`plan`
pair, general/explore subagents, durable resumable tasks, model/variant overrides, configurable hierarchy, background execution, layered discovery with project trust.

Left out: a separate `agent generate` command (`agent create --generate` does it) and overriding `build` or `plan` by config.
`default_agent` (setting; a project may set its own `defaultAgent`) is the primary agent a new session starts with, `build`
when unset or unknown; `temperature`, `top_p`, `steps` and `color` are agent-file fields (above).

Plan transitions support a persisted, trusted primary destination (`planExitAgent`) and honor `hidden: true`
for destination selection. See [Plan review](plan-review.md) for acceptance, apply, editing and planning-only packets.

### Granular agent permissions

An agent can use a v1 permission mapping instead of a mode cap (two-space tool keys, four-space patterns):

```yaml
permission:
  read:
    "*": allow
    "*/private/*": deny
  bash:
    "git *": ask
```

Inline JSON maps and `permission: allow|deny` also work. Rules keep their order and follow global tool/path rules;
last match wins. Existing v2 mode scalars (`plan|ask|smart|edits|full`) retain their cap meaning. Use
`permission: {"*":"ask"}` for v1's all-tools ask shorthand. To combine a mode cap with patterns, keep the mode
in `permission` and add a JSON `permissionRules: [{"permission":"read","pattern":"*/private/*","action":"deny"}]`.
Invalid actions or malformed maps report an agent-file problem and never load permissively. The daemon carries
`permissionRules` in agent reports and the native engine applies them to primary and child agents.

## Agent CLI (B66)

`agent list` prints builtins first, then custom agents with their modes, permission rules and project trust. `--json`
uses the standard CLI envelope and includes file problems. Listing never calls a provider.

`agent create` asks for Location (project or global), Description, permissions (Space toggles, Enter confirms), and
mode (`all|primary|subagent`). Esc/Ctrl+C cancels before writing. For unattended creation provide every choice:

```bash
mendcode agent create --dir /tmp/mend-data --path /tmp/mend-data \
  --description "Review diffs" --name reviewer --mode all --permissions read,grep --model chatgpt/gpt-6-luna
```

`--path DIR` writes `DIR/agents/<name>.md`; otherwise project scope uses `<cwd>/.mendcode/agents` and global scope uses
the daemon data directory. A custom path is discovered only if it is an existing extension layer. `--permissions`
(`--tools` alias) accepts v1 permission keys; unselected keys receive explicit denies. An empty CLI value means all,
as in v1; deselecting everything in the wizard denies all listed keys. Names default to a slug of the description;
`--name` overrides it. Existing files, final symlinks and built-in names are refused. Project creation does not grant
trust. `--model` / `-m` validates `provider/model` against the catalog and saves its native model id in frontmatter.

By default creation is deterministic: the description becomes the system prompt, and the response identifies
`generation: "deterministic", callsProviders: false`; no provider is called.

`--generate` (off by default, local only) asks the model to write the identifier, a "Use this agent when..." line
and the full system prompt from the description. The model is `--model` when given (also saved in the frontmatter),
else the main model; the call goes through the usual budget guard. The identifier is slugified and suffixed (`-2`) if
taken or built in; `--name` overrides it. The when-to-use text becomes `description` (examples removed, cut to 300
characters), the system prompt the body; secrets in the answer are redacted. If there is no native engine, the
model is unavailable, the call fails or the answer is unusable, the plain template is written instead and the
response carries `fallback` (the CLI prints it as a warning on stderr). Success reports `generation: "model",
callsProviders: true`.

`debug agent <name>` shows the trusted agent, prompt and resolved tool availability. `--tool ID --params '{...}'`
executes a native tool with those JSON object arguments and persists a debug
session/transcript. Explicit invocation supplies approval; global/agent/path denies, plan caps and extension hooks
still apply. Tool errors exit 1. Hosted tools use their existing daemon ports; `task` needs a configured model and
reports `callsProviders: true`. Interactive questions/plan decisions are refused by headless debug. Creation and debug
are local only and never read-only remote commands.

`--dir` / `--data-dir` selects daemon storage. Frames: `bun scripts/render-frames.ts .agents-frames/B66 --b66 100x30 180x50`.

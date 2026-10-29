# MendCode

[![CI](https://github.com/MendCode/MendCode/actions/workflows/ci.yml/badge.svg)](https://github.com/MendCode/MendCode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MendCode/MendCode?include_prereleases&sort=semver)](https://github.com/MendCode/MendCode/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A coding agent for the terminal. One daemon keeps your sessions; any number of terminals attach to them. It runs its own
native engine with the models you connect, or drives Claude Code, Codex, ACP agents and pi behind the same screen. It indexes
your code into a graph so the model reads less, packs long conversations instead of forgetting them, and reviews your pull
requests.

## Install

macOS and Linux:

```sh
curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh
```

Windows (PowerShell 5.1 or newer):

```powershell
irm https://github.com/MendCode/MendCode/releases/latest/download/install.ps1 | iex
```

Then run `mendcode`. The first launch walks you through [/setup](docs/setup.md) (models, permissions) and [/connect](docs/connect.md)
(credentials). Claude Code, Codex and the other external engines need their own install and login.

The binary goes to `~/.local/bin/mendcode` (`%LOCALAPPDATA%\Programs\mendcode` on Windows). The installer checks the binary's
SHA256 and, when [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) is installed, the signature of the release
workflow; `MENDCODE_REQUIRE_SIGNATURE=1` refuses to install without that signature. Download and read the script first if you
prefer: it is attached to every [release](https://github.com/MendCode/MendCode/releases).

### Channels

| Channel | What it is | Install |
|---|---|---|
| `stable` | Tested releases, `vX.Y.Z` | the commands above |
| `beta` | The next release before it ships, `vX.Y.Z-beta.N`; a newer stable when there is one | `... \| sh -s -- --channel beta` |
| `nightly` | Built from `main` every day it changes, `vX.Y.Z-nightly.YYYYMMDD.RUN`; a newer beta or stable when there is one | `... \| sh -s -- --channel nightly` |

On Windows set `$env:MENDCODE_CHANNEL = 'beta'` (or `nightly`) before the `irm` line. One exact release:
`MENDCODE_VERSION=v0.0.1 sh install.sh`. A starting tier for the first launch: `--tier minimalist|balanced|full` (default
`balanced`, [tiers](#tiers)).

### Update, switch, roll back

```sh
mendcode upgrade                     # newest release of your channel
mendcode upgrade --channel nightly   # switch channel (remembered); --channel stable goes back
mendcode upgrade --check             # only say whether there is a newer one
mendcode upgrade --rollback          # back to the previous binary
```

`mendcode update` is the same command. The footer says when a newer release of your channel is out. `upgrade` replaces only the
binary; your sessions stay in the data directory ([upgrade](docs/upgrade.md)).

### Uninstall

`mendcode uninstall` lists exactly what it would remove and asks first; `--keep-data` and `--keep-config` keep your sessions or
your settings ([uninstall](docs/uninstall.md)).

## Status

Version 0.x: expect changes between releases, and back up your data before upgrading.

- **Verified on macOS** (Apple silicon): the measurements below and the script-workflow sandbox were run there. The Linux and
  Windows binaries are built and smoke-tested by the release pipeline; the Linux sandbox profile for script workflows has not
  run on real Linux machines yet, and Windows has no script host and no daemon smoke test ([workflows](docs/workflows.md#security-model), [releases](docs/release.md)).
- **Tested against fake transports, not real accounts:** Claude Code, Codex, ACP and pi as engines, the GitHub automation,
  the Telegram bridge and MCP OAuth ([GitHub](docs/github.md), [channels](docs/channels.md), [MCP OAuth](docs/mcp-oauth.md)).
- **Your data:** `--dir`, else `MENDCODE_V2_DIR`, else `~/.mendcode-v2`. To back it up, quit every terminal, run
  `mendcode daemon stop` and copy the whole directory (the database with its `-wal` and `-shm` files, `blobs/`, and `keys/`, which
  the encrypted secrets need) ([storage](docs/storage.md), [secrets](docs/secrets.md)).

## Build from source

With Bun (CI pins 1.3.13) and the pinned pnpm 11.17.0 ([package.json](package.json)):

```sh
pnpm install --frozen-lockfile --config.minimumReleaseAge=10080
bun apps/cli/src/entry.ts --dir "$(mktemp -d)"   # disposable data; reuse a --dir to keep sessions
bun run build                                    # dist/mendcode-next for this machine (--target, --outfile)
```

`sh scripts/install-dev.sh` installs a `mendcode-next` wrapper in `~/.local/bin` that runs the checkout. Releases: pushing a `v*`
tag runs [release.yml](.github/workflows/release.yml), which runs the whole test gate, builds the five binaries (macOS and Linux
x64/arm64, Windows x64), signs them with keyless cosign, attests them and attaches an SBOM; [nightly.yml](.github/workflows/nightly.yml)
tags `main` once a day when it changed. There is no Apple notarization or Windows code signing yet ([releases](docs/release.md)).
See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change.

## Replaceable views

Every terminal surface is drawn through one of 22 view slots, and the built-in look uses the same contract ([views](docs/views.md)):

- Transcript: `message.user`, `message.assistant`, `message.reasoning`, `tool.card`, `tool.row`, `compaction.card`, `turn.status`.
- Prompt area: `approval`, `question`, `prompt.frame`, `bar`.
- Chrome: `topbar`, `footer`, `notice`, `home`, `sessions.sidebar`, `panel.widget`, `slash.menu`.
- Pages and overlays: `page`, `page.status`, `overlay`.

Not replaceable: the prompt editor, the tasks and scratchpad dock, and the live compaction panel (their frame and surroundings are slots). Page bodies reach a view already drawn: a view restyles the rows, there is no typed model per page. Views are synchronous and data-only, keys and approvals stay with the terminal, and a view that throws or runs over 4 ms is replaced by the built-in. **Views run in the terminal process with your permissions and are not sandboxed**; installing one is trusting its author. Project views need a trusted project; remote and `--safe-mode` terminals load none. Start with `mendcode-next view scaffold <slot>`.

## Script workflows

A script workflow is a short JavaScript program that decides at run time which agents to start; static JSON plans work as before ([workflows](docs/workflows.md#script-workflows), [examples](examples/workflows)). Tier: balanced and full.

- **API:** `agent`, `parallel`, `pipeline`, `check`, `ask`, `merge`, `memo`, `phase`, `log`, `sleep`, `args`, with a literal `export const meta` for name, phases, budget and completion contract. Start with `/workflows run`, `workflow run` or the `workflow_script` tool, which asks before every start.
- **Journal and resume:** every call is journaled. After a daemon restart or `resume`, finished calls replay from the journal and are not run again; tested by killing a real daemon mid-run.
- **Budgets:** `agents`, `tokens`, `usd`, `minutes`. A cap pauses the run; `workflow budget` raises it and `resume` continues.
- **Per agent:** `engine`, `model` and `effort` are checked before any session starts. Engines other than native need the full tier and an exact model.
- **`merge`:** combines the branches of `worktree` agents on an integration branch for review; nothing is merged into your checkout without an explicit `apply` approval.
- **Isolation:** the script runs in a separate OS-sandboxed process with a stripped scope, a watchdog and a memory limit, never in the daemon. Verified on macOS (Seatbelt); the Linux bubblewrap profile is not yet verified; Windows has no script host.

## Markdown renderer

The `full` message renderer (balanced and full views) draws code blocks with a language header and a `copy` button (click, or `ctrl+x Y` for the block nearest the middle of the screen), four table styles (`box`, `rules`, `grid`, `minimal`), four heading styles (`banner`, `bold`, `underline`, `uppercase`), `> [!NOTE]`-style callouts, task lists and footnotes. 28 colour slots can be overridden one by one with `markdownColors` or a theme file. `markdownCopyHints` (`auto`, `code`, `all`, `off`) chooses which blocks show a visible `copy`. Limits: right-to-left text is reordered per paragraph, heading, list item and quote, not with full bidi (no isolates or embeddings, no Arabic shaping), and tables and code stay left-to-right. The minimal view and the `markdown` and `plain` renderers keep the classic look. See [markdown design](docs/design/markdown-parity.md) and [customization](docs/customize.md).

## Process modes

`processMode` (`--process`, `MENDCODE_PROCESS`) is `auto` by default in every tier (same as `solo`): the terminal hosts the daemon in its own process and hands it to a detached daemon when something needs one, such as a second terminal or standing work. `daemon` keeps the terminal and the daemon as two processes. The trade-off, as the [design](docs/design/memory-single-process.md) states it: less RAM, a hard-killed terminal interrupts its running turn, slower first frame. Measured with the real CLI in a pseudo-terminal, empty session: 124 MB against 167 MB (see [measurements](#measurements)), first frame 194 ms against 105 ms with a daemon already running (load 2.4 to 2.7). Run `bun scripts/perf.ts --mode daemon,solo` to repeat it ([performance](docs/performance.md)).

## Terminal details

- **Memory notices:** each memory write is one muted transcript row (`Memory saved · project · "…"`) with a `/memory undo` hint, or a one-line toast when the write is not in the visible transcript. `/memory undo` deletes the newest memory this session saved, and again the one before; edits and removals are not undone ([memory](docs/memory.md#memory-consent-and-notices)).
- **Prompt history:** up and down arrows recall sent messages, commands, `!` shell lines and discarded drafts, per project; `alt+r` or `/prompt-history` searches them by kind. Text that leaves the prompt unsent (12 or more characters, or several lines) is kept as a draft ([editor](docs/editor.md#discarded-drafts)).
- **Slash menu layouts:** `tabs` (default), `groups`, `columns`, `flat`; minimalist defaults to `flat` ([customization](docs/customize.md)).
- **Right panel:** `/panel` opens the `pulse` cards; presets are `pulse`, `crew`, `ledger`, `focus`, `full` and `galaxy` (full tier only). Balanced and full tiers ([panel](docs/sidebar.md)).
- **Empty sessions:** a new chat reuses the project's empty session, so there is at most one per project ([sessions](docs/sessions.md#empty-chats)).

## Tiers

Use `/tier minimalist`, `/tier balanced` or `/tier full`. Minimalist selects compact presentation and a minimal prompt; balanced selects comfortable presentation and a focused prompt; full selects the full prompt. [Tiers](docs/tiers.md) are separate from setup presets.

Included means the tier enables the feature, subject to its own controls. Opt-in means the tier permits it but an explicit switch/action is still required. Kernel features are independent of tiers, with their own disabling controls and safe-mode restrictions. `/tier <feature> on|off|default` overrides non-kernel features; `--safe-mode` remains a ceiling. With no tier selected, legacy defaults apply.

Generated from [tier-data.ts](packages/protocol/src/tier-data.ts), including every manifest feature. Print the block with `bun scripts/readme-tiers.ts`; verify with `bun scripts/readme-tiers.ts --check` or `bun test scripts/readme-tiers.test.ts`.

<!-- tiers:start -->
| Feature | Minimalist | Balanced | Full | Own switch / action |
|---|---|---|---|---|
| [Slash menu layouts](docs/customize.md) (`slash_menu`) | Kernel | Kernel | Kernel | /customize · slashMenu · slashCommands (minimalist lists 20 commands, flat) |
| [Extensions](docs/extensions.md) (`extensions`) | Kernel | Kernel | Kernel | MENDCODE_EXTENSIONS=0 · --pure |
| [Installed packages](docs/packages.md) (`packages`) | Kernel | Kernel | Kernel | disabledPackages · /marketplace |
| [Package chat tools](docs/packages.md) (`package_tools`) | — | Included | Included | features.package_tools |
| [Shell hooks](docs/hooks.md) (`hooks`) | Kernel | Kernel | Kernel | MENDCODE_HOOKS=0 |
| [MCP servers](docs/mcp-oauth.md) (`mcp`) | — | — | Included | mcp.json |
| [Code graph tools](docs/code-graph.md) (`codegraph`) | — | Included | Included | MENDCODE_CODEGRAPH=0 |
| [Sub-agents (task)](docs/agents.md) (`subagents`) | — | Included | Included | tools.task |
| [Script workflows](docs/workflows.md) (`script_workflows`) | — | Included | Included | tools.workflow_script |
| [Adaptive reasoning (JEV)](docs/reasoning.md) (`jev`) | — | — | Included | experimental.reasoning_auto |
| [Pet companion](docs/customize.md) (`pets`) | — | — | Included | pet |
| [Experimental pet generator](docs/customize.md) (`pet_generator`) | — | — | Opt-in | /pet new (explicit confirmation) |
| [Voice dictation](docs/voice.md) (`voice`) | — | — | Opt-in | voice.enabled |
| [Computer control](docs/computer.md) (`computer`) | — | Opt-in | Opt-in | /tier computer on (macOS; off until then) |
| [Headless browser](docs/browser.md) (`browser`) | — | — | Opt-in | MENDCODE_BROWSER=1 |
| [Code Mode](docs/code-mode.md) (`code_mode`) | — | — | Opt-in | experimental.code_mode |
| [Snip stale output](docs/compaction.md) (`snip`) | — | — | Opt-in | experimental.snip |
| [Worktree tool](docs/worktrees.md) (`worktree_tool`) | — | — | Opt-in | experimental.worktree_tool |
| [Auto-resume at usage limit](docs/usage-limit.md) (`usage_resume`) | Included | Included | Included | /limit cancel |
| [Thread tools](docs/sessions.md) (`threads`) | — | Included | Included | experimental.thread_tools |
| [PR watch](docs/pr-watch.md) (`pr_watch`) | — | Opt-in | Opt-in | experimental.pr_watch |
| [PR reviewer](docs/pr-review.md) (`pr_review`) | — | Opt-in | Opt-in | experimental.pr_review |
| [Command output filters](docs/advanced-config.md) (`output_filters`) | — | Included | Included | tool_output.filters |
| [Context forecast](docs/layout.md) (`forecast`) | — | Included | Included | /footer +forecast |
| [pi engine (RPC)](docs/pi-engine.md) (`pi`) | — | — | Opt-in | pi.json · /tier pi on |
| [Thread MCP bridge](docs/thread-mcp.md) (`thread_mcp`) | — | — | Opt-in | /tier thread_mcp on claude\|codex\|acp:&lt;name&gt; |
| [ACP registry](docs/acp-engine.md) (`acp_registry`) | — | — | Included | /tier acp_registry on |
| [Lossless storage compaction](docs/storage.md) (`storage_compact`) | Opt-in | Opt-in | Opt-in | storage --compact --offline --dir DATA |
| [Suggested review order](docs/changes.md) (`review_order`) | — | Included | Included | /changes · o preview · O apply |
| [Session lifecycle](docs/sessions.md) (`session_meta`) | — | Included | Included | /tier session_meta on |
| [Fan-out comparison](docs/agents.md) (`fanout`) | — | — | Included | /tier fanout on |
| [Pre-limit checkpoint](docs/usage-limit.md) (`limit_checkpoint`) | — | Included | Included | /tier limit_checkpoint off |
| [Graph orientation and impact](docs/code-graph.md) (`graph_context`) | — | Opt-in | Opt-in | /tier graph_context on (off until then: the model calls the graph tools itself) |
| [Focused session handoff](docs/sessions.md) (`handoff`) | — | Included | Included | /handoff &lt;goal&gt; |
| [Instruction includes](docs/prompt-modes.md) (`instruction_includes`) | — | Included | Included | @relative/path in AGENTS.md |
| [Package capability preview](docs/packages.md) (`package_capabilities`) | — | Included | Included | /marketplace preview |
| [Caveman prose style](docs/prompt-modes.md) (`caveman`) | — | Opt-in | Opt-in | /output-style caveman |
| [PDF and repository fetch](docs/tools-web.md) (`webfetch_modes`) | — | Opt-in | Opt-in | webfetch mode |
| [Deferred MCP tools](docs/tool-discovery.md) (`tool_discovery`) | — | — | Included | experimental.tool_discovery |
| [Official package kit](docs/packages.md) (`official_packages`) | — | Opt-in | Opt-in | Explicit local catalog install |
| [Durable orchestration receipts](docs/thread-mcp.md) (`orchestration_receipts`) | Kernel | Kernel | Kernel | clientRequestId on thread mutations |
| [Metric experiments](docs/loops.md) (`autoresearch`) | — | — | Opt-in | On-demand metric-experiment skill |
| [Explicit web routes](docs/tools-web.md) (`web_routing`) | — | Opt-in | Opt-in | On-demand explicit-web skill |
| [Session panel cards](docs/sidebar.md) (`panel`) | — | Opt-in | Opt-in | /panel |
| [Session galaxy](docs/sidebar.md) (`panel_orbit`) | — | — | Opt-in | /panel galaxy |
| [Panel model tokens](docs/sidebar.md) (`panel_models`) | — | Opt-in | Opt-in | /panel ledger |
| [File viewer (click a path)](docs/file-viewer.md) (`file_viewer`) | — | Included | Included | /customize · pathClick · /open |
| [Memory consent and management](docs/memory.md) (`memory_ux`) | Kernel | Kernel | Kernel | memoryEnabled · memoryRequireApproval · /memory |
| [One process per terminal (solo)](docs/design/memory-single-process.md) (`single_process`) | Kernel | Kernel | Kernel | /customize · processMode · --process (auto in every tier: one process while one terminal is open, less RAM; a second client moves the daemon to its own process; solo keeps it in the terminal; daemon keeps the separate process) |
| [Lean tool catalogue](docs/tool-discovery.md) (`lean_tools`) | Included | Included | Included | /tier lean_tools off |
| [Auxiliary tools in every request](docs/tool-discovery.md) (`aux_tools`) | — | Opt-in | Opt-in | /tier aux_tools on |
| [MendCode tools inside Claude Code](docs/claude-code.md) (`harness_tools`) | — | Included | Included | /tier harness_tools on |
| [Plan and goal tools in every request](docs/tool-discovery.md) (`plan_tools`) | — | — | Opt-in | /tier plan_tools on |
| [glob and grep in every request](docs/tool-discovery.md) (`find_tools`) | Included | Included | Included | /tier find_tools off |
| [Screen settings tool in every request](docs/tool-discovery.md) (`ui_tool`) | — | Included | Included | /tier ui_tool on |
| [Orientation block in the first message](docs/tool-discovery.md) (`orientation`) | — | Included | Included | /tier orientation off |
| [Git page (review, commit, worktrees)](docs/git.md) (`git_hub`) | — | Included | Included | /git · git.defaultTab |
| [Git page push and pull request](docs/git.md) (`git_actions`) | — | Opt-in | Opt-in | experimental.git_actions |
| [Quota refresh probe](docs/usage-limit.md) (`quota_refresh`) | Opt-in | Opt-in | Opt-in | /customize · quotaRefresh (off until a provider is listed; each probe spends some of the quota it measures) |
| [Compact while idle](docs/compaction.md) (`idle_compact`) | — | — | Included | /tier idle_compact off · /settings · idle compact |
| [1h cache after long waits](docs/prompt-cache.md) (`wait_cache`) | — | — | Included | /tier wait_cache off · /settings · cache ttl |
| [Notice before a compaction](docs/compaction.md) (`compact_notice`) | — | Included | Included | /tier compact_notice off · /settings · compact notice |
| [Project backlog](docs/sidebar.md) (`backlog`) | — | — | Included | /tier backlog off · /backlog · /panel widget backlog |
| [Sub-agent worktrees](docs/agents.md) (`task_worktree`) | — | — | Included | /tier task_worktree off · task isolation: "worktree" |
| [Sub-agent forks (parent's cached context)](docs/agents.md) (`task_fork`) | — | — | Opt-in | /tier task_fork on · task fork: true |
| [Sub-agents on a cheaper model](docs/agents.md) (`cheap_subagents`) | — | Included | Included | /tier cheap_subagents off · /model roles · subagent |
| [Claude Code compacts at MendCode's point](docs/claude-code.md) (`claude_compact`) | — | Included | Included | /tier claude_compact off · compactAtTokens |
| [Cache countdown (footer)](docs/layout.md) (`cache_countdown`) | — | — | Opt-in | /footer +warm |
| [One tree: sessions sharing a checkout](docs/one-tree.md) (`one_tree`) | — | Included | Included | /tier one_tree off |
<!-- tiers:end -->

## Measurements

Measured 2026-10-04 on a MacBook Pro (Mac16,8), Apple M4 Pro, 24 GB RAM, macOS 27.0 (26A428), Bun 1.3.13, arm64; source revision `631d5ab`. Synthetic offline workloads, temporary stores and HOME, no real providers or other coding tools.

| Measure | Result | Method |
|---|---|---|
| Compiled CLI `help` startup | 99.4 ms | Median of five launches, `compiledTarget` + `measureCliStartup` from [perf.ts](scripts/perf.ts) |
| Bytes per session, 60-session batch | 206,165 | Rounded batch total / 60 after checkpoint, compression and sharing |
| Bytes for 2,000 sessions | 345,800,704 (329.8 MiB) | Database + WAL + blobs after checkpoint; 172,900 bytes/session rounded |
| Daemon RSS, idle / with a client attached | 98 MB / 104–129 MB | `bun scripts/perf.ts` at revision `3066087`, compiled daemon, 0 / 1,000 / 10,000 messages |
| Client RSS, idle / after scrolling and streaming | 63–71 MB / 107–133 MB | Same run, compiled client |
| First frame | 96 ms / 142 ms / 186 ms | Same run as the two-process RSS rows (revision `3066087`, `daemon` mode), 0 / 1,000 / 10,000 messages |
| Scroll frame p95 | 2.5 ms / 4.7 ms / 3.3 ms | Same run |
| Streaming frame p95 | 3.6 ms / 7.5 ms / 5.4 ms | Same run |
| Opt-in one process (`processMode: auto` or `solo`, selected by the minimalist tier; the default is two processes), RSS idle / after use | 113 / 148 MB (0 messages), 133 / 216 MB (10,000) | `bun scripts/perf.ts --mode daemon,solo` on 2026-10-05, load average 5.5 (shared machine, not repeated on an idle one); the same run in two processes, daemon + client: 142 / 195 MB and 148 / 249 MB; real CLI in a pseudo-terminal, 0 messages: 124 MB solo against 167 MB in two processes. [Design](docs/design/memory-single-process.md) |
| Opt-in one process, frame p95, scroll / stream | 4.5 to 8.4 ms / 5.6 to 9.1 ms | Same run as the one-process RSS row |
| Opt-in one process, first frame | 180 ms / 196 ms / 210 ms | Same run as the one-process RSS row, 0 / 1,000 / 10,000 messages ([performance](docs/performance.md#solo-mode-one-process)) |

Disk command: `MEND_DISK_REPORT=1 bun test packages/store/test/disk-budget.test.ts` (5 passed). Each [synthetic session](packages/store/test/synthetic-data.ts) has eight turns, three tool calls/turn, streamed text, model history and file snapshots. Batch sizes share different amounts of data; these are not predictions for arbitrary transcripts or Git worktrees. The [disk test](packages/store/test/disk-budget.test.ts) enforces 210 KiB/session for the small batch and 350 MiB for 2,000 sessions. See [storage](docs/storage.md).

[Performance](docs/performance.md) documents `bun scripts/perf.ts`: compiled client and daemon, faux engine, 0/1,000/10,000 messages, RSS, startup and frame p95. The [budget rules](scripts/perf-budgets.ts) and [tests](scripts/perf.test.ts) fail on regression. Numbers vary with machine load; no historical or competitor measurements are presented here.

## Engines

| Engine | Transport / requirements | Reference |
|---|---|---|
| Native | Built-in model loop; configured providers | [Providers](docs/providers.md) |
| Claude Code | Installed, logged-in `claude`; stream-json | [Claude Code](docs/claude-code.md) |
| Codex | Installed, logged-in `codex`; app-server | [Engine tests](packages/engine-codex/test/engine.test.ts), [thread bridge](docs/thread-mcp.md) |
| ACP | Explicitly configured external ACP agent | [ACP](docs/acp-engine.md) |
| pi | Installed, logged-in pi; RPC; opt-in, full-tier permission | [pi](docs/pi-engine.md) |

External engines retain their own authentication and tool loops. Fake transports establish offline adapter coverage, not live account interoperability.
## Embedding

`mendcode app-server --dir DATA --cwd PROJECT` exposes local JSONL JSON-RPC (`mendcode-app-server@1`): threads, turns, events and approval requests. A typed client is exported by `@mendcode/client/app-server`. Headless `run --format json`, the daemon socket and opt-in HTTP adapter are alternatives. See [embedding](docs/embedding.md) and its [client example](examples/app-server-client.ts).

## Security model

- The daemon applies permission modes and approval rules before tools execute ([permissions](docs/permissions.md)).
- OS sandboxing is opt-in and off by default; approval alone is not confinement ([sandbox](docs/sandbox.md)).
- Remote/peer access is scoped; local-data commands and host execution settings have local-only guards ([remote](docs/remote.md), [audit](docs/security-2026-10-04.md)).
- Recognized pasted secrets become markers with encrypted values; detection does not certify arbitrary text or external-engine files ([secrets](docs/secrets.md), [audit](docs/security-2026-10-04.md)).
- The thread MCP bridge is opt-in per engine, project-scoped and short-lived, with normal approvals and no user-config rewrites ([thread MCP](docs/thread-mcp.md)).

## Docs and development

[Commands](docs/commands.md) · [Customization](docs/customize.md) · [Views](docs/views.md) · [Workflows](docs/workflows.md) · [Memory](docs/memory.md) · [Compaction](docs/compaction.md) · [Worktrees](docs/worktrees.md) · [Packages](docs/packages.md) · [Usage limits](docs/usage-limit.md) · [Upgrade](docs/upgrade.md) · [Uninstall](docs/uninstall.md) · [Migrating from the legacy MendCode](docs/migrate-v1.md)

```sh
bun test scripts/readme-tiers.test.ts apps/cli/test/footprint.test.ts apps/cli/test/tui-automation.test.ts
./node_modules/.bin/tsc -p tsconfig.base.json --noEmit
```

MIT: [LICENSE](LICENSE). Dependency notices: [THIRD_PARTY.md](THIRD_PARTY.md).

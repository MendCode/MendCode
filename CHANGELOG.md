# Changelog

## 0.1.37 - 2026-08-23

MendCode v0.1.37 prevents orphaned macOS Loop services and makes Workflow completion recovery bounded and executable.

### Changed

- Run macOS Loop LaunchAgents as one-shot scheduler ticks instead of leaving a persistent Bun coordinator alive between wakeups.
- Accept bounded package-manager validation commands from relative project subdirectories, including `pnpm --dir app build`.

### Fixed

- Self-uninstall project Loop services after their final scheduled Loop disappears, including services already waking with an empty project scope.
- Remove macOS LaunchAgents by their loaded label so a service can safely uninstall itself while it is running.
- Reject unsupported Workflow completion commands before task execution instead of blocking after every task has finished.
- Time out a stalled structured completion auditor after 3 minutes, cancel its child session, and route it through the existing bounded retry or blocked state instead of auditing forever or overlapping the retry.
- Route completion audits through the explicit read-only Explore profile instead of silently inheriting the primary Build agent.
- Resume a Workflow whose work already finished but whose completion audit was blocked by creating a fresh audit generation without rerunning completed tasks.
- Keep explicit `workflows start|resume|retry-* --wait` CLI runs attached until a durable stop instead of disposing their runner immediately.

### Tests

- Add focused regressions for macOS one-shot scheduling and self-uninstall routing, package-manager validation safety, early Workflow plan validation, and stalled completion auditors.
- Run 96 focused public-launcher, Loop, Workflow, scheduler, persistence, and completion tests with isolated test state, plus a real isolated macOS LaunchAgent self-removal smoke.

## 0.1.36 - 2026-08-23

MendCode v0.1.36 makes Loop and Workflow supervision durable, observable, and consistent with the workspace users actually inspect.

### Changed

- Show the interruption confirmation only after the first `Esc` press, on the left side of the activity row; a second `Esc` still targets the same active turn.
- Display completion-audit lifecycle, attempt, lease countdown or expiry age, last update, and the active auditor chat directly in the Workflow monitor.
- Open the current completion-auditor transcript before completed task transcripts while a Workflow audit is active.

### Fixed

- Reclaim expired completion-audit leases after restart even when every Workflow task is already complete, without falling back to a permanently queued run.
- Renew active completion-audit leases without increasing the attempt count, so long auditor turns cannot reject their own final evidence as stale.
- Avoid duplicate workspace-update events when a recovered Workflow reuses the same workspace lease.
- Execute Loop workers inside their authoritative leased worktree, preserve that path and branch through terminal state, and notify the parent chat with the exact workspace location.
- Keep Loop draft behavior aligned across legacy and Effect HTTP routes, including full contracts that omit optional cost or token caps.
- Prevent large transcripts from visibly unmounting when a submitted message moves into the optimistic render window.
- Preserve keyboard permission selection when OpenTUI reports synthetic or parked pointer movement.

### Tests

- Add focused regressions for audit restart recovery, duplicate lease events, auditor transcript routing, audit-state presentation, two-step interruption placement, Loop route parity, worktree ownership, large-session submission, and permission selection.
- Run 335 release-focused Loop, Workflow, TUI, session, permission, and route tests with isolated state, plus the native Darwin build and startup smoke checks.

## 0.1.35 - 2026-08-22

MendCode v0.1.35 makes long-running sessions, Loop execution, Usage Insights, and local agent collaboration more immediate and reliable.

### Added

- Add a customizable Usage Insights widget layout with persisted visibility controls and a subscription-usage widget backed by local Codex rate-limit telemetry.
- Add same-project peer discovery and bounded, approval-gated peer messages that preserve visible source provenance without granting tool permissions.

### Changed

- Require a second `Esc` press for the same active turn before interruption, with a visible confirmation window that remains responsive during clipboard inspection and compaction.
- Keep Loop workers fail-closed after an unfinished tool attempt instead of automatically replaying work with unknown side effects.
- Refresh large session transcripts, Git status, selected-day statistics, and Loop chat activity without blocking the visible interface on expensive auxiliary data.
- Display accurate background follow-up wording instead of reporting that an agent resumed when detached work merely completed.

### Fixed

- Prevent prompt submission from briefly unmounting or blanking a large transcript before the optimistic user turn is rendered.
- Prevent overlapping Loop daemon ticks, restore project-scoped Loop discovery for isolated worktrees, and accept canonical macOS temporary-directory aliases in permission checks.
- Keep selected Usage Insights days current until manually pinned, then update arrow-key navigation synchronously without remounting the dashboard.
- Preserve keyboard permission selection during synthetic pointer movement and keep compact reasoning, transcript spacing, and grouped tool continuation presentation stable.

### Tests

- Add focused regressions for two-step interruption, prompt mounting, transcript sync and virtualization, Loop scheduling and recovery, permission path aliases, Usage Insights widgets, subscription telemetry, and peer messaging.
- Run the release-focused agent, session, Loop, TUI, stats, collaboration, and tool suites with isolated test state.

## 0.1.34 - 2026-08-20

MendCode v0.1.34 fixes remaining session presentation regressions from v0.1.33.

### Fixed

- Size short Full reasoning blocks to their content instead of reserving the entire bounded reasoning viewport and leaving a large blank gap in the session transcript.
- Keep the same bounded, scrollable reasoning behavior in the normal session route and the experimental Session v2 renderer.
- Keep keyboard navigation on the selected permission option when OpenTUI rechecks hover state during layout changes.
- Remove the fixed transcript clearance that left unused space above the session prompt while preserving the virtualizer's real bottom spacer.

### Tests

- Add regressions for short Full reasoning layout, keyboard permission navigation, and transcript spacing.
- Run the focused TUI presentation, permission prompt, session layout, and session initialization suites.

## 0.1.33 - 2026-08-20

MendCode v0.1.33 is a reliability hotfix for updates, long-running activity, and context-pack presentation.

### Fixed

- Prevent in-app updates from failing when GUI-launched processes do not expose Bash through `PATH`; surface actionable updater errors and verify the installed version.
- Keep Arcade games visible after context compaction completes so the game is not removed with the compacted transcript.
- Clear stale Generating/activity state after an aborted shell command leaves a completed assistant timestamp without finish metadata.

### Tests

- Add updater failure and installed-version verification regressions.
- Add Arcade-after-compaction and aborted-activity regressions.

## 0.1.32 - 2026-08-20

MendCode v0.1.32 hardens long-running sessions so activity, cancellation, scrolling, and approval state remain truthful while large tools and commands are still running.

### Added

- Add bounded multi-pass bottom-follow reflow for large tool output, transcript relayouts, and the Session v2 route.
- Add persisted cancellation retry state with bounded backoff and explicit unknown/failed status instead of silently losing `Esc` requests.
- Add local tool activity detection for Agent View and a bounded Full reasoning viewport that follows only its own content.

### Changed

- Keep `Esc` available as a global active-session interrupt while preserving approval, question, and plan-review dismissal semantics.
- Keep the shell default timeout configurable and raise its fallback to 10 minutes so long edits, builds, and device commands have time to finish.
- Route every Smart Approval shell request through prompt-scoped review; safe reads and directory access are no longer auto-approved without the current user prompt.
- Render memory actions with explicit add/update/search labels and success/active tones instead of treating completed actions as errors.

### Fixed

- Prevent large tool-height changes and delayed OpenTUI reflows from detaching a session that is still following the bottom.
- Detach bottom-follow immediately when a manual upward scroll overlaps a delayed tool reflow, so follow mode cannot pull the viewport back down.
- Prevent the Activity footer and Agents view from becoming idle while a tool remains pending or running after a long edit or command.
- Prevent `Esc` from being consumed by an inner transcript/widget before it reaches the active session interrupt command.
- Prevent Full reasoning content from expanding the entire chat and forcing the outer session scroll to move.

### Tests

- Run focused session-control, scroll/activity, Agent View, shell, permission, Smart Approval, presentation, and renderer suites (315 cases in the release-focused run).
- Verify persisted runtime recovery and source/installed parity with `test:session-runtime:smoke` without provider requests.
- Verify Linux, Darwin, and Windows package builds with the release builder using the existing no-embed-web-UI release path.

## 0.1.31 - 2026-08-19

MendCode v0.1.31 adds completion-verified Loop and Workflow execution and keeps long-running agent work visibly active until it actually finishes.

### Added

- Add completion contracts, auditing, and validation so Loop and Workflow runs only report success after a complete iteration satisfies its required checks.
- Add durable workflow planning, execution, scheduling, receipts, and recovery state across the runtime, server, tools, and TUI monitors.
- Add focused regression coverage for completion validation, Loop/Workflow orchestration, scheduler recovery, and long-running session activity.

### Changed

- Expand the Loop and Workflow views with phase-aware status, receipts, task progress, and terminal outcome details.
- Keep workflow task and phase state synchronized across adapters, background execution, persistence, and recovery.
- Refresh live session status with bounded in-memory heartbeats while provider and tool work is still running.

### Fixed

- Prevent long-running sessions from becoming idle after the stale status snapshot timeout while work is still active.
- Prevent incomplete Loop or Workflow runs from being presented as completed before their validation contract passes.
- Preserve authoritative activity state through the TUI activity footer and Agents view during long-running execution.

### Tests

- Run focused completion, Loop/Workflow, scheduler, TUI activity, edit, and patch-tool regression suites.
- Verify the local source CLI manually with `mend --isolated` and a long-running `sleep 90` activity check.

## 0.1.30 - 2026-08-18

MendCode v0.1.30 expands Full Prompt Context product awareness, completes Mermaid ASCII presentation, and hardens session history, test isolation, memory extraction, Usage Insights, reconnecting TUI activity, release presentation, and Windows builds.

### Added

- Add a Full Prompt Context capability catalog backed by the real CLI command families, covering TUI and slash-command discovery, native tools, custom tools, MCP, packages, workflows, memory, browser automation, and collaboration surfaces without leaking it into Minimal or Focus modes.
- Add public agent-facing product, image-generation, custom-tool, screenshot, automation, and extension contracts to the README.

### Changed

- Apply provider presets to every built-in model role, show connected providers first, expose OpenAI-specific presets only when OpenAI is connected, and prioritize free DeepSeek, GLM, and Qwen options in the OpenCode catalog.
- Disable the memory side-chat role by default and remove it from Setup while preserving the bounded memory extractor and Dream proposal roles.
- Switch Setup mouse actions to activate on release and use the scrollable Usage Insights layout before low-height terminals clip panels.
- Build optimized Windows x64 and ARM64 release assets on native Windows runners, cross-build the baseline x64 asset on Linux, verify executable metadata, and assemble them with the Linux and Darwin artifacts.
- Use version tags as GitHub release display names and populate draft release notes from the matching changelog section.

### Fixed

- Keep transcript scrolling responsive while the pointer is over a Mermaid card, while preserving Shift-wheel horizontal panning and working zoom, fit, and centering controls.
- Fail closed before a test fixture can open or reset a SQLite database outside its isolated temporary roots, and block accidental root-level test discovery.
- Bound automatic memory extraction to 45 seconds by default so a stalled extractor cannot keep a completed session busy indefinitely.
- Make the manual queue/compaction smoke single-instance, recover stale locks, terminate child processes on interruption, and clean its isolated fixture and lock on exit.
- Keep live long-running session activity authoritative beyond the stale snapshot timeout and stop tool animations immediately when `Esc` interrupts a run.
- Keep managed local-server reconnection alive with bounded backoff, resume accepted prompts when the stream recovers, and restart a stopped connection when the user submits again.
- Keep `Editing...` and `Patching...` authoritative during transient reconnects and while a large completed edit remains the latest assistant event, then transition when newer output begins.

### Tests

- Add nested transcript/Card interaction coverage for Mermaid zoom and wheel routing, plus regression coverage that rejects production-like SQLite paths during tests.
- Add focused coverage for Full Prompt Context isolation, real CLI-family projection, provider-wide presets, free OpenCode model ordering, compact Usage Insights layouts, memory-extraction timeout recovery, queue-smoke lock cleanup, reconnect recovery, and ordered TUI activity phases.
- Confirm the local-only queue/compaction smoke manually with three mock requests and no external provider contact.

## 0.1.29 - 2026-08-04

MendCode v0.1.29 fixes Windows installation, packaging, and release presentation so the corrected assets are available through the standard download paths.

### Added

- Add a Windows CMD installer that uses the built-in `curl.exe` and `tar.exe` tools without requiring PowerShell.
- Document direct Windows ZIP downloads and the no-PowerShell installation path.

### Changed

- Make Windows release bundles deterministic and include MendCode icon and metadata.

### Fixed

- Detect x64 and ARM64 correctly from PowerShell, including 32-bit PowerShell on 64-bit Windows.
- Avoid Bun Windows linker failures caused by split bundles.

### Tests

- Run the focused installation test suite.
- Build Windows x64, ARM64, and baseline release assets and smoke-test `--version` and `--help`.

## 0.1.28 - 2026-08-04

MendCode v0.1.28 adds durable Loop Workflows and provider-aware image generation, strengthens detached background-task delivery, and improves workflow and session recovery across the TUI and server transports.

### Added

- Add durable Loop Workflows with validated plans, policy gates, background execution, scheduling, persistence, recovery, CLI/API routes, and a dedicated TUI monitor.
- Add the `image_gen` tool with Codex OAuth, OpenRouter, and OpenAI-compatible adapters, persisted artifacts, optional captions, and safe edit inputs.
- Add workflow-run deletion and richer workflow progress, receipt, artifact, and recovery metadata to the server API and generated JavaScript SDK.
- Add focused workflow, image-generation, background-task, queue/compaction, server-route, scheduler, and TUI regression coverage.

### Changed

- Keep first-class workflows in the dedicated Workflows view instead of mixing workflow coordinators into Agent View.
- Expose workflow receipts, progress, queued work, terminal outcomes, and recovery state consistently across the TUI and server transports.
- Keep image generation independently configured from the active chat model and expose it only when the provider contract and permissions support it.
- Improve compaction, reconnect, long-session, error, and workflow-monitor presentation while keeping the prompt focused during active work.

### Fixed

- Persist, replay, acknowledge, and instance-scope detached background-task completion notifications so idle owners resume reliably without duplicate or cross-project terminal deliveries.
- Keep the shared server alive while detached work is active and classify missing terminal outcomes as interrupted instead of leaving tasks indefinitely active.
- Preserve queued prompt state through compaction and reconnects, restore prompt focus after compaction, and clear stale working or disconnected indicators when execution settles.
- Require workflow artifact consumers to depend on their producers, reject direct starts with unresolved gates, and improve recovery and cleanup of interrupted workflow runs.
- Keep long-running non-shell tools alive across stream-idle periods and handle unknown image-generation results without crashing the session.
- Update release dependency overrides to patched versions of `brace-expansion`, `fast-uri`, `hono`, `ip-address`, `postcss`, `socket.io-parser`, and `undici`.
- Skip the optional post-install setup prompt when `curl | bash` has no controlling terminal instead of failing after a successful installation.

### Tests

- Confirm the local queue/compaction smoke with a local-only provider; no external provider was contacted.
- Add targeted regressions for workflow plan validation, scheduler recovery, detached task wakeups, server lifetime, transcript state, prompt initialization, and dedicated workflow rendering.

## 0.1.27 - 2026-08-02

MendCode v0.1.27 improves TUI reliability and narrow-terminal rendering while making prompt behavior, customization, and release metadata more explicit.

### Added

- Add compact, width-bounded Mermaid flowchart layouts for long vertical and horizontal diagrams, including automatic rotation when a horizontal diagram cannot fit.
- Add explicit MendCode prompt guidance for task lifecycle discipline, cost-aware model routing, loop activation consent, background-subagent consent, custom tools/pages/widgets, and the supported TUI rendering surface.
- Add regression coverage for interrupted prompt state, reconnecting permission synchronization, Agent View ordering, compact flowcharts, and the expanded prompt contract.

### Changed

- Expand the full prompt mode description with TODO, Loop Workflow, cost, TUI, and extension context while preserving the provider-focused harness contract.
- Make loop activation and background delegation require explicit user intent when the request does not already provide it.
- Bound normal and advanced Usage Insights fetch sizes separately and adapt heatmap cell widths and labels for narrow terminals.
- Retry and reconcile session permission-mode synchronization across transient local-server reconnects instead of surfacing avoidable errors.

### Fixed

- Clear the TUI working indicator immediately after a user interrupts a running command, even when a stale unfinished assistant message remains in the frontend cache.
- Order active Agent View rows by turn start time instead of later tool-update timestamps.
- Keep long Mermaid flowcharts within the terminal width and avoid the unreadable fallback layout when the preferred orientation is too wide.

### Tests

- Add focused TUI, prompt-composition, permission-sync, and Markdown-rendering regressions for the release changes.

## 0.1.26 - 2026-08-01

MendCode v0.1.26 restores reliable in-app update discovery and installation across TUI transport modes.

### Fixed

- Check for updates after the TUI is ready regardless of whether it uses the shared server, an external server, or a private worker.
- Namespace the skipped-update preference so legacy upstream version state cannot suppress MendCode releases.
- Run in-app installer upgrades without opening setup or modifying PATH, and surface the installer error when an upgrade fails.

## 0.1.25 - 2026-08-01

MendCode v0.1.25 repairs cancellation and compacted-history state after interrupted or long-running TUI sessions.

### Fixed

- Finalize orphaned pending or running tool calls as cancelled when an unfinished assistant turn is explicitly stopped, preventing commands that no longer exist from remaining visibly active.
- Preserve the latest completed compaction boundary while the bounded TUI message cache pages through long transcripts, so tool calls before compaction remain hidden unless explicitly revealed.
- Add focused regression coverage for cancelling unfinished assistant turns with active tools.

## 0.1.24 - 2026-08-01

- Published from the same source tree as v0.1.23; it contained no additional source changes.

## 0.1.23 - 2026-07-31

MendCode v0.1.23 hardens long-running sessions and Loop Workflows while making
provider-aware compaction and TUI state easier to inspect.

### Added

- Add scheduler health, wake attempts, retry/backoff state, and failure metadata to durable Loop Workflows and their CLI/API views.
- Add regression coverage for session synchronization, virtual transcript windows, loop lifecycle state, smart permissions, and provider-aware compaction.

### Changed

- Set GPT-5.6 ChatGPT OAuth models to a 256K effective input/context limit with a provider-specific 90% compaction threshold.
- Improve loop runner recovery, scheduler error reporting, run leases, completion state, and persisted run metadata.
- Improve transcript rendering, compaction summaries, Changes Review rendering, setup copy, and permission-review presentation across narrow and live TUI states.

### Fixed

- Prevent stale or duplicate session rows and user-message rendering during reconnects, transcript growth, compaction, and resumed work.
- Preserve safe session and tool state when scheduled loop execution or a permission-review path fails.
- Make cross-platform release smoke tests accept the public `Usage:` help header.

## 0.1.22 - 2026-07-29

### Fixed

- Show the startup update modal for patch releases by default instead of silently attempting an automatic update; explicit `autoupdate: true` keeps silent patch upgrades available.
- Add regression coverage for the `0.1.20` to `0.1.21` update path.

## 0.1.21 - 2026-07-29

MendCode v0.1.21 is a focused reliability and customization release. It adds project-owned prompt context, improves prompt/runtime boundaries, protects active sessions during cancellation and reconnects, preserves useful media through compaction, and refreshes the public setup and customization documentation.

### Added

- Add a project-local `custom` Prompt Context mode backed by `.mendcode/prompts/custom.md`, with optional frontmatter names, bounded loading, root-safe path checks, UTF-8 normalization, and safe fallback diagnostics.
- Add package-shared custom prompt support through runtime packs without leaking a local project prompt into another project.
- Add `mendcode prompt` inspection/build/mode commands plus setup, status, TUI selector, footer, and runtime-plan visibility for custom prompt origin, name, path, byte count, and fallback state.
- Add public documentation for project-local and package-shared custom tool calls, including typed arguments, execution context, metadata, permission checks, and package distribution.
- Add regression coverage for custom prompt loading, package resolution, session recovery, cancellation, compaction media, Codex OAuth affinity, transcript ordering, and prompt diagnostics.

### Changed

- Compose prompt context from the active project root and carry one resolved MendCode prompt snapshot through streaming and token estimation instead of resolving inconsistent prompt state in separate paths.
- Keep custom prompt metadata out of provider instructions while exposing a readable project-defined label in setup and the TUI.
- Rotate Codex ChatGPT OAuth Responses Lite session affinity when the effective prompt instructions change, while preserving affinity for identical instructions.
- Preserve images for vision-capable compaction models and retain a bounded set of recent image attachments for text-only compaction resumes.
- Keep session scroll position and anchors stable across transcript growth, paging, compaction, and route remounts; keep later assistant continuations after intervening turns.
- Refresh the local shared-server fingerprint from source metadata so local TypeScript changes cannot reuse stale runtime processes.
- Run prompt-status scripts through a Bash-compatible shell and expose the public prompt route from the installed CLI.
- Bound shell cancellation and timeout cleanup, force-kill cancelled processes after a short grace period, and expose explicit retry guidance when command completion is unknown.
- Bump package, lockfile, and Zed extension metadata to `0.1.21` and refresh setup/customization documentation and screenshots.

### Fixed

- Prevent manual `Esc` cancellation from being undone by late background-task owner-wake notifications or stale prompt deliveries.
- Cancel all pending prompt deliveries during interruption and coalesce concurrent abort requests so a cancelled turn cannot restart from a stale request.
- Prevent hidden prompt input state from remaining mounted while a question or permission prompt owns the session input.
- Reconcile session state, pending questions, and permissions after a worker-backed terminal transport recovers from system sleep or a reconnect.
- Keep queued session work from restarting after an explicit cancellation.
- Mark commands interrupted by connection loss or timeout as having an unknown result, retain incomplete output safely, and avoid encouraging blind repetition of potentially destructive commands.
- Stop legacy diff preview heuristics from treating any long source block as a truncated preview when no truncation marker exists.

### Tests

- Add focused regressions for custom prompt parsing and security boundaries, prompt mode cycling, runtime-pack projection, prompt snapshot propagation, cancellation/owner-wake behavior, reconnect synchronization, session virtual-window ordering, scroll persistence, image-aware compaction, Codex OAuth request affinity, Bash-compatible prompt status scripts, and unknown shell-result retry metadata.

## 0.1.20 - 2026-07-28

### Added

- Add setup onboarding presets for subscription, balanced API, and budget API model roles.
- Add a setup Health Check step that runs setup doctor/plan without printing secrets.
- Add package setup actions for public GitHub package imports, local imports, package management, and safe runtime config snapshot export.
- Add the Memory Center with project/global scopes, category graphs, reviewable proposals, a constrained memory side agent, and Dream maintenance workflows.
- Add durable Loop Workflow execution with root/child sessions, journals, checkpoints, artifact ledgers, safety gates, evaluators, cost records, daily schedules, and self-paced triggers.
- Add Loop Workflow `update_agent` support in the tool, API, and TUI so existing loops can be retargeted without recreation.
- Add richer Loop Workflow show/list context with latest run checkpoint, changed files, recent events, and latest loop-session message.
- Add self-paced Loop Workflow trigger support for max-goal work without hot-looping unbounded monitors.
- Add the terminal-native `/changes` review surface, inline comments, bounded review context, and the `review` tool.
- Add first-run onboarding, context-pack profiles (`arcade`, `cockpit`, `minimal`, and `quiet`), structured command search, larger dialogs, widgets, overlays, themes, and plugin slots.
- Add background-task control, subagent/session metadata, Herdr state reporting, public/local package imports, package management, and the Memory Graph example package.
- Add installer `--setup` and `--skip-setup` options plus an optional setup launch prompt after install.
- Add configurable context-pack presentation profiles: `arcade`, `cockpit`, `minimal`, and `quiet`, with setup controls.

### Changed

- Refresh setup/provider copy around Provider Manager, connected providers, model role presets, package store actions, and responsive narrow-width layout.
- Refresh installer presentation with the MendCode install deck banner, progress UI, and setup instructions.
- Refresh session synchronization, prompt model/variant metadata, compaction panels, background-task notifications, and resumed subagent presentation.
- Make `/memory`, `/loops`, `/stats`, `/changes`, setup, and session views responsive on narrow and mid-width terminals.
- Keep resumed subagent calls attached to the original task card instead of rendering duplicate resume cards.
- Improve `/changes` diff loading so large tracked and likely-binary patches are summarized per file with metadata instead of flooding or failing the whole review.
- Make the `/loops` route responsive for compact and mid-width panes with shorter key hints, bounded stacked list height, and visible compact loop detail.
- Expand public documentation, package/plugin guidance, memory and loop guides, screenshots, branding assets, and release automation.
- Improve TUI selection dialogs with large layouts, structured command search, readable wrapping, and a `?` help key.

### Fixed

- Preserve useful subagent evidence in Task tool results when the child reply is generic but the child session recorded substantive output or changed orchestration files.
- Mark externally interrupted subagent tasks as retained/continuable instead of failed, so parent sessions do not misread connection drops as failed.
- Keep batched `message.updated` events idempotent and preserve the latest user turn, assistant output, queue state, and compaction progress across bounded refreshes.
- Persist async prompts before acknowledging HTTP 204 responses and surface prompt failures through the normal session error event.
- Keep unbounded interval monitors from completing when a checkpoint says `complete`; they now continue until an explicit stop condition.
- Keep self-paced unbounded monitors from running continuously without a cadence.
- Preserve loop receipt state for show/list and problem states instead of masking workflow state with generic completed-action copy.
- Prevent setup and loops pages from clipping action footers, rails, and detail panels on narrow terminal panes.
- Avoid stale setup package registry entries when GitHub or local package import fails.
- Prevent binary or oversized `apply_patch` inputs from becoming giant diffs that block the server/TUI before `Generating` starts.
- Harden legacy relay URL recognition, OAuth error pages, cryptographic ID/PKCE generation, and release dependency paths.
- Update release dependencies to OSV-fixed versions: `@hono/node-server` 2.0.10, `brace-expansion` 5.0.8, and `tar` 7.5.21.
- Keep TUI message state idempotent when duplicate `message.updated` events arrive in the same batch, preventing temporary assistant duplication or disappearance during queued and normal turns.
- Preserve the latest real user turn and its visible assistant output across bounded refreshes, stale removals, and compaction-related updates.
- Keep prompt/queue working state, compaction progress, background-task notifications, and session rendering synchronized during active turns.
- Persist async prompts before acknowledging them with HTTP 204 and surface prompt failures through the existing session error event.
- Harden legacy relay URL recognition, OAuth error pages, and cryptographic ID/PKCE generation against security scanner findings.
- Unmount the hidden session prompt while a question or permission prompt owns input, preventing stale prompt rows and focus state from leaking into the transcript.

### Tests

- Add Task tool regressions for retained external aborts and generic subagent replies with child-session evidence.
- Add Memory Center/Dream, memory graph, session synchronization, prompt persistence, background-task, plugin, and HTTP API regressions.
- Add Loop Workflow regressions for agent retargeting, self-paced scheduling, unbounded monitor checkpoints, show/list context metadata, and loop receipt copy.
- Add setup/package regressions for public GitHub URL validation, memory dialog state, setup health step state, and compact setup/loops layout helpers.
- Add `/changes` regressions for per-file large patch handling and binary/large file skip messaging.
- Pass supply-chain preflight, OSV, frozen-lockfile, release asset, SBOM, CodeQL, dependency review, security scanner, checksum, and attestation gates for the published release.
- Add regressions for batched duplicate message updates, pinned user turns, sparse refreshes, bounded transcript retention, compaction pairing, and prompt working-state transitions.
- Add command-search and async-prompt persistence regressions.
- Align title-generation fixtures and session transcript assertions with the current prompt and compaction-boundary behavior.
- Validate prompt visibility and TUI startup after question/permission interactions.

## 0.1.19 - 2026-06-25

### Fixed

- Distinguish explicit user cancels from transport, WiFi, lid-sleep, or connection aborts so interrupted session state no longer falsely implies the user stopped the run.
- Preserve partial shell/task output with non-user-disconnect metadata instead of labeling it as `User aborted the command`.
- Prevent Loop Workflows from completing as `0/0`, reject invalid fixed zero-turn budgets, and keep unbounded monitors open instead of storing `maxTurns: 0`.
- Keep manual and signal-driven Loop Workflows from auto-running on every scheduler tick; only interval/adaptive loops become due from `nextWakeup`.
- Let implementation loops run with normal execution when the objective explicitly asks to write, edit, fix, implement, code, or create files, while preserving explicit report-only and custom-gated modes.
- Delete loop-owned root chat sessions when deleting a Loop Workflow and expose delete parity across legacy and raw HttpApi loop routes.
- Keep minimal/full chat presentation from clipping long fenced or text-fence lines by wrapping to the visible display width.

### Changed

- Improve Loop Workflow tool/prompt guidance so assistants inspect existing loops before recreating them, never use `maxTurns: 0`, and report invalid `completed 0/0` states instead of spawning duplicates.
- Expand Loop Workflow tool metadata for TUI cards with permission mode, trigger, budget, model, objective, agent, and timestamps.
- Add `/loops` dashboard warnings for legacy invalid zero-turn budgets.
- Preserve unfinished assistant/tool phases through compaction and keep Herdr status accurate while local tools, child sessions, and loop workflows are still active.

### Tests

- Add regression coverage for non-user abort classification in shell, task, and message error handling.
- Add Loop Workflow regressions for zero-turn budgets, due scheduling, permission inference, delete lifecycle, legacy/HttpApi route parity, and loop prompt guidance.
- Add chat presentation regressions for fenced long-line wrapping, Unicode display width, text-fence wrapping, hex color handling, and table preservation.

## 0.1.18 - 2026-06-24

### Added

- Add goal-driven Loop Workflow budget modes: `fixed`, `max-goal`, and `unbounded-monitor`.
- Add Loop Workflow completion criteria, success checks, target turns, reserved verification turns, machine-readable checkpoints, and optional owner-session completion notifications.
- Add provider disconnect support from the Connect Provider dialog for locally saved provider auth.
- Add TSM shortcut support for creating an explicit missing branch before opening it in a split MendCode pane.

### Fixed

- Fix Loop Workflow execution so implementation loops that explicitly allow edits are not downgraded to report-only by a conservative background service.
- Refresh Loop Workflow receipts with clearer spacing plus model, mode, trigger/event, agent, chat, workflow, and goal details.
- Keep loop session headers, run checkpoints, and the `/loops` dashboard aligned with the currently running iteration instead of lagging one completed run behind.
- Keep Herdr loop-session panes in a working loop state between iterations and only report completion after the workflow reaches a terminal state.
- Resume active provider compaction automatically and add trigger context so compaction summaries do not falsely close unfinished work.
- Preserve a bounded snapshot of the retained recent tail during compaction so summaries keep the latest unfinished request, tool output, and resume context.
- Keep the active loop count only in the prompt footer, expose `/loop` from the new-chat screen, make `/loop` Tab completion non-submitting, and remove duplicate `/loops` slash entries.
- Accept loop model variants through the `variant` field or provider/model#variant syntax for any provider.
- Keep the `/loops` dashboard cursor out of read-only detail rows so the `updated` field no longer looks editable.
- Keep Herdr agent state from staying `working` after a session finishes and no longer appears in status output.
- Report clearer `--worktree` and `--tsm` errors outside git repositories or before the first commit.
- Strip command frontmatter metadata from opencode provider schemas/options so strict providers do not reject structured output or noop tool schemas.

### Changed

- Treat `maxTurns` as an iteration budget for goal work instead of a requirement to spend every available loop turn.
- Improve `/loops` timeline loading and scrolling so recent workflow events remain inspectable without overwhelming compact terminals.
- Scope model variant selection to the newly selected model before deciding whether to open the variant picker.
- Refresh opencode Go/OpenRouter reasoning variant mapping for GLM-5.2, MiniMax M3, and widely supported effort levels.
- Clean up slash-command fallbacks and aliases so command names do not collide.

### CI

- Skip CodeQL for docs-only, changelog-only, and public asset-only PRs while keeping CodeQL on source changes, main pushes, scheduled runs, and manual dispatch.
- Consolidate Security Guard scanners into one deep-scanner job while preserving gitleaks, OSV, zizmor, and Semgrep policy enforcement.
- Reduce release workflow artifact retention from 30 days to 7 days to cut Actions storage pressure.

### Docs

- Update the Loop Workflow events spec with goal semantics, checkpoint behavior, budget exhaustion rules, and acceptance checks.

### Tests

- Add coverage for goal-budget loop completion/blocking, owner notifications, compaction tail snapshots, provider schema cleanup, reasoning variants, TSM/worktree shortcut edge cases, Herdr idle reporting, and structured-output schema transformation.

## 0.1.17 - 2026-06-23

### Added

- Loop Workflows: durable workflow records, draft/activate/tick lifecycle, run journals, loop root sessions, Agent View grouping, terminal monitor, HTTP routes, SDK types, and a built-in `loop` assistant tool.
- Safe loop execution modes: dry-run ticks, `--execute --report-only` wakeups that deny mutation/shell/subagent tools, full execution for trusted contexts, and per-project OS service support for macOS LaunchAgent, Linux user systemd, and Windows Task Scheduler.
- Built-in loop templates for PR watching, CI repair, research digests, and repo maintenance, plus CLI/status/monitor docs for loop lifecycle, daemon, service, logs, and troubleshooting.
- Changes Review: a MendCode-native `/changes` TUI route for working-tree diffs with file navigation, diff-block navigation, line selection, reload, responsive layouts, inline comments, and stale-comment reconciliation.
- Assistant-visible review context through bounded `<mendcode_review_context>` summaries and a `review` tool for current selection, file summaries, navigation, reload, comment creation, listing, and clearing.
- Local review-state persistence keyed by workspace root so comments and selection can be recovered across route/process boundaries without writing raw patches into the repository.
- Richer Usage Insights: selected-day keyboard/mouse navigation, a GitHub-style daily token grid, month markers, selected-day token/session/prompt/word/file/time details, improved clock layout, and expanded aggregation for tool/runtime activity.
- Project Usage Insights shortcuts and docs for global, project, and directory scopes.
- Streaming Markdown rendering for assistant output so headings, inline formatting, tables, code fences, Mermaid text, and hex color swatches can appear progressively without waiting for a completed message.
- Claude Code CLI provider discovery and validation: provider list entry, local CLI auth validation, version-aware model listing, optional binary/home/launch-arg settings, and API-provider wiring once the local CLI is authenticated.
- Frontmatter argument-hint parsing and prompt metadata improvements for command/prompt surfaces.

### Changed

- Render compaction summaries through the styled Markdown path so tables and formatted summaries stay readable in the session timeline.
- Rename provider setup surfaces from generic `Provider` to `Connect Provider` where the UI is specifically about connecting/authenticating a provider.
- Refresh README screenshots, feature mapping, setup/configuration docs, and usage-insights docs for the 0.1.17 surfaces.
- Update package, lockfile, and Zed extension metadata to `0.1.17`.

### Fixed

- Prevent incomplete streaming Markdown tables and code fences from rendering early before they can display coherently.
- Deduplicate live shell-output deltas so repeated command output does not replay the same latest line while a tool is still streaming.
- Report missing Claude Code CLI binaries as validation errors instead of letting provider discovery throw raw `ENOENT` exceptions.
- Preserve the `0.1.16` reasoning-history behavior after the local OpenAI reasoning replay experiment was reverted.

### Tests

- Add coverage for loop services/routes/session/tool behavior, Changes Review state/actions/comments/context, Usage Insights selection and aggregation, streaming Plan Markdown, shell-output replay prevention, Claude Code provider settings/validation, prompt metadata, and TUI route behavior.

## 0.1.16 - 2026-06-20

- Fix Memory Center Dream scheduling proposals so accepting a side-chat `dream-dry-run` proposal writes the Dream scheduler state instead of only saving an ordinary memory proposal.
- Recover Dream scheduler state from already-applied Dream proposals, so users who accepted a Dream schedule proposal in `0.1.15` see the Dream page become scheduled after upgrading.
- Add Dream schedule parsing for human time windows such as `6pm to 11pm local time`, `18:00-23:00`, and fixed times such as `21:00 Europe/London`.
- Add regression coverage for side-chat Dream proposal application, Dream schedule recovery, and human-readable Dream time parsing.

## 0.1.15 - 2026-06-19

- Add a route-level Memory Center in the TUI with Overview, Project memories, Global memories, Policy & categories, and Dream tabs.
- Add saved/pending memory review surfaces with keyboard actions for applying, rejecting, editing, deleting, moving, and inspecting memories without leaving the terminal.
- Add category-aware memory metadata, policy normalization, scope reasoning, evidence references, and reviewable proposal operations for verify, expire, recategorize, relink, demote-scope, and promote-scope flows.
- Add a memory graph sidecar with legacy-entry bridging so memories can be grouped, indexed, and queried by category while preserving the existing flat memory files.
- Add workspace-aware memory grouping so the Memory Center can show the current project plus other known project memory scopes.
- Add Dream memory maintenance primitives: proposal-only Dream runs, bounded/redacted evidence collection, run logs, scheduler state, source manifests, missed-window handling, and safety reporting.
- Add a constrained memory side chat backed by the `memoryAssistant` role so users can ask about memory state, draft memory actions, and inspect category policy without turning the Memory page into a general coding agent.
- Add `memoryDream` and `memoryAssistant` model roles to local memory/model configuration while keeping generated memory writes approval-gated by default.
- Label retrieved prompt memory by scope and category while preserving the existing `<mendcode_memory>` compatibility block.
- Feed recent conversation context into post-turn memory extraction so proposals can distinguish durable facts from isolated one-line messages.
- Add Memory HTTP/API routes for side-chat calls and wire the route into both the experimental HttpApi surface and instance routes.
- Add a `Memory Center` command palette route and keep the existing lightweight `Memory Manager` proposal dialog as a separate command.
- Add `/memory-center`, `/memories`, `/memory-manager`, `/memory`, and `/mem` routing so slash commands can open the right memory surface.
- Add scrollable previews to the Memory Manager dialog so long proposal bodies do not overflow compact terminals.
- Add screenshot-backed public docs for the README hero, home layouts, Agent View, Plan Mode, and Memory Center.
- Add `docs/features.md` as the product-facing feature map for README, website, screenshot, and demo work.
- Add `docs/memory-center.md` and a Memory Graph/Dream spec to document the new memory workspace and safety model.
- Refresh the README into a public product page with install paths, product surfaces, documentation map, development notes, security/community pointers, star history, and an expanded agent-context block.
- Refresh the docs index, setup/configuration docs, customization docs, Plan Mode docs, Usage Insights docs, and package-sharing docs to point at implemented screenshots and provider-neutral examples.
- Document `memoryDream` and `memoryAssistant` roles alongside existing model roles, and keep public model examples provider-neutral.
- Add a dedicated Shift+Tab Mode picker for primary agents, moving reverse agent cycling off Shift+Tab so the key opens the expected mode selector.
- Make the prompt model, provider, and variant labels resolve from the selected prompt model metadata instead of stale local/session labels.
- Track whether local model and variant state came from the user or session hydration, so explicit local changes win over older hydrated session state.
- Persist submitted prompt agent/model selections onto the session before generation so resumed sessions and Agent View reflect the real active selection.
- Preserve assistant provider/model/variant metadata when sync events arrive with partial message updates.
- Keep prompt status script output tied to the current prompt-status identity so stale script output from an older model/session/root is not reused.
- Show the currently selected model in the working indicator instead of the broader local parsed model when the prompt is using a session/subagent selection.
- Add Markdown-rendering capability notes to non-minimal prompt policy so agents know the TUI supports headings, lists, tables, code fences, links, checklists, blockquotes, and Mermaid text diagrams.
- Replace the Plan Review renderer path with a stable styled Markdown component instead of relying on the experimental Markdown flag.
- Improve Plan Review table rendering with grid mode, wrapped cells, and better handling for file/action/detail tables.
- Improve terminal Mermaid rendering for state diagrams, class diagrams, pie charts, Gantt charts, git graphs, requirement diagrams, journeys, timelines, and other common diagram shapes.
- Add static Plan Markdown rendering helpers and Mermaid fence detection for tests and non-interactive surfaces.
- Add hex color parsing/swatches so Markdown tables that list colors can render clean terminal previews.
- Improve chat/timeline presentation for todo writes, questions, plan-review prompts, permission prompts, and grouped tool activity.
- Remove the separate subagent footer file and fold subagent/session footer behavior into the main session layout.
- Improve session layout sizing and compact terminal behavior around message rendering, plan review, usage/status surfaces, and bottom prompt chrome.
- Add the built-in Herdr agent-state plugin so MendCode panes can report idle, working, blocked, needs-input, approval, plan-pending, retry, and error state to Herdr without requiring a separate user plugin.
- Read project-local `.mendcode/mcp` server config into the MCP runtime, status, tools, prompts, and resources paths so project MCP servers participate alongside global config.
- Sync generated project config when `mendcode` starts if the generated opencode config is stale.
- Make `mendcode --worktree .` and current-worktree shortcuts resolve more naturally, including current-branch fallback when no non-base worktree exists.
- Make control-plane output for mflow, TSM, and worktrees human-readable by default while keeping `--json` available for scripts.
- Make `mendcode mcp add-local` sync generated runtime config after writing project MCP config.
- Use provider-neutral defaults for memory preview commands instead of hard-coded public provider/model examples.
- Add setup smoke coverage for memory/model-role fields and package/runtime configuration.
- Add tests for Memory Center layout helpers, memory categories, graph/proposals/retrieval, Dream events/scheduler/sources, HTTP memory routes, prompt compose, prompt model/variant resolution, prompt status identity, plan Markdown rendering, Herdr plugin reporting, MCP project config, worktree shortcuts, setup, TSM, runtime pack, and session prompt metadata.
- Refresh release-gated dependencies and lockfile overrides for DOMPurify, Undici, form-data, esbuild, Slack Bolt, and OpenTelemetry so the OSV release scanner can pass without disabling supply-chain checks.

## 0.1.14 - 2026-06-16

- Make `mendcode packages install <pack-id>` install a selected package from the official or chosen registry catalog instead of applying a whole source by accident.
- Keep source-level package application available as `mendcode packages install-source <source-id>` for existing local/team registry workflows.
- Let the setup Package step skip packages, browse official packages, install a local package path, create/update a local package snapshot, or manage installed overlays.
- Add registry coverage for multi-package catalogs, selected pack installation, source-level install compatibility, and runtime compatibility rejection.
- Update `protobufjs` to `7.6.3` so the release dependency gate can pass with the fixed version.

## 0.1.13 - 2026-06-16

- Refresh the Bash and PowerShell installers with a clearer MendCode banner, numbered install phases, ASCII progress output, and more direct next-step guidance.
- Make installer guidance honest after `curl | bash`: run the installed binary by absolute path immediately, or open/source a terminal before using `mendcode` from `PATH`.
- Keep MendCode-owned setup config keys such as `memory` and `package` from crashing the runtime config loader after first-run setup creates `.mendcode/mendcode.json`.
- Honor dynamic `OPENCODE_CONFIG_CONTENT` values at config-load time so SDK/runtime callers can inject per-instance config after process startup.
- Preserve explicit model changes made while a session is busy so the next prompt uses the newly selected model instead of falling back to the previous session model.
- Point npm registry publishing at the public `mendcode` package name instead of the temporary `mendcode-ai` wrapper name.
- Update Hono to `4.12.25` so release dependency scanning passes without carrying known fixed advisories.

## 0.1.12 - 2026-06-16

- Show the upstream `opencode` provider in the TUI provider/model/setup flows while keeping it labeled as `opencode Zen`, and keep `opencode-go` labeled separately as `opencode Go`.
- Add a Windows PowerShell installer and document macOS, Linux, Windows PowerShell, and Git Bash/WSL install paths in the README.
- Add configurable assistant message rendering modes: Plain, Markdown, and Rich.
- Render plan/chat Markdown more cleanly in Rich mode, including local Mermaid flowcharts, wide tables, checklists, callouts, connectors, and compact terminal-friendly diagrams.
- Keep plan review content anchored while scrolling so review modals stay readable during long plans.

## 0.1.11 - 2026-06-15

- Preserve `task` tool metadata while a subagent is running, after tool-call transitions, and when a subagent fails before model resolution completes.
- Queue a newly submitted prompt behind an active run so the second prompt is saved and answered in the next LLM call instead of being coalesced into the first run's result.
- Keep existing concurrent `loop()` callers coalesced to the same active run while only explicit prompt submissions enqueue a follow-up turn.
- Stop showing the empty memory-check toast when the extractor finds no durable candidates, and keep Home title changes silent while refreshing the visible Home surface.
- Hide the prompt-bottom context meter unless `promptStatus.context.visible` is explicitly enabled, including old profiles that still list the context builtin.
- Let mflow lock/read external absolute paths by default instead of refusing paths outside the current project.

## 0.1.10 - 2026-06-14

- Let automatic memory learning create approval-gated `add`, `update`, and `remove` proposals, with targeted updates/deletes applied to existing memory entries instead of only appending new entries.
- Recover durable repo-scoped memory rules when the extractor returns empty or wrapped JSON, without relying on hard-coded prompt examples.
- Show a memory toast when extraction finishes with no pending proposal, including skipped or no-candidate reasons instead of silently disappearing after "Preparing memory proposal...".
- Treat slash commands as commands only when they start the prompt, so normal messages that mention `/setup`, `/stats`, or other commands are sent as chat text instead of navigating away.
- Keep `/setup` and `/stats` as temporary pages from an active chat: pressing escape or finishing setup now returns to the originating session instead of dropping to New Chat.
- Keep Agent View hover visual-only; click or arrow keys select the reply target, and `esc` clears that selected session before returning to normal prompt input.
- Keep split home welcome branding neutral and prevent long ASCII title text from clipping into partial letters.
- Remove the default right-side prompt context meter so the footer no longer shows the extra context bar and separator dot by default.
- Preserve pasted chat images through message copy/paste by copying image attachments as portable data-image Markdown and rehydrating those images back into prompt attachments when pasted into MendCode.

## 0.1.9 - 2026-06-14

- Make `mendcode --help` workflow-first: open the terminal harness, run with an initial intent, use packages, mflow, worktrees, TSM, setup, and status.
- Move low-level/debug commands out of normal help, including TUI profile internals, runtime adapter/upstream/export/config plumbing, and prompt/runtime internals.
- Keep legacy aliases such as `init`, `sync`, `package`, and `prompts` callable with deprecation warnings instead of presenting them as product workflows.
- Suggest close matches for typo-prone commands, including `mendcode tui prewview` -> `mendcode tui preview`.
- Stop replaying the latest real user message as a new visible user turn after overflow compaction; resume from the summary and a synthetic internal continue prompt instead.
- Avoid the double-compaction path where auto resume immediately re-adds the same user request before continuing.
- Release mouse tracking, bracketed paste, and raw input mode before suspending or exiting the TUI so the parent shell does not receive scroll/click escape sequences.

## 0.1.8 - 2026-06-14

- Show a real Usage Insights loading state instead of zeroed metrics while cached stats are still loading.
- Reuse the global TUI stats cache on the Usage Insights page without warming session messages during normal chat startup.
- Keep the weather location in the global TUI config and simplify the stats shortcuts by removing the manual refresh action.
- Fix the installer version check so a same-version global `mendcode` on `PATH` cannot falsely satisfy a clean `$HOME/.mendcode/bin` install.

## 0.1.7 - 2026-06-14

- Keep the setup screen stable while refreshing step state so changing setup pages no longer flashes back to a loading placeholder.
- Widen the setup rail so longer step labels such as TUI Profile and Permissions do not collide with completion status.
- Shorten and row-budget the memory extractor auth warning while preserving the actionable OAuth/client-id blocker.
- Inject global memory at session start and after compaction, while keeping per-request project memory local to the model prompt instead of writing it into chat history.
- Run automatic memory extraction after normal assistant stops, show a dedicated memory activity state/mascot while proposals are generated, and give the extractor structured saved/pending memory context before it decides whether to propose.
- Prevent the primary assistant from directly saving implicit preferences to memory; approval-gated proposals now come from the memory extractor unless the user explicitly asks to save memory immediately.
- Avoid re-triggering assistant generation after clean auto-compaction while still resuming when compaction interrupted an active or incomplete assistant turn.
- Keep long pasted content visible until it exceeds the configured character threshold, and let truncated user-message headers expand from the hidden-content hint without stealing normal message action clicks.
- Refresh the docs for the `mendcode` command surface, customization, setup/configuration, mflow, package sharing, plan mode, usage insights, TSM/worktrees, and wiki navigation.

## 0.1.6 - 2026-06-14

- Add a TUI Usage Insights dashboard with daily token activity, global/project stats, response-time metrics, top tools/agents/models, cached stats loading, and optional Open-Meteo weather.
- Inject saved global memories into normal runtime requests as transient system context instead of only after compaction.
- Keep project memories in the runtime prompt with their own request cap so repo-local context is available without persisting injected memory into chat history.
- Make `mendcode memory search` and `mendcode memory preview` show request-mode retrieval by default, with an explicit `--mode` selector for compaction/manual checks.

## 0.1.5 - 2026-06-13

- Backport MCP runtime updates: catalog pagination, capability-aware prompt/resource listing, tolerant tool schema discovery, abort signal forwarding, OAuth `callbackPort`/`scope`, and manual OAuth header preservation.
- Isolate provider model plugin hooks from internal provider state so plugin mutations cannot rename providers or zero model pricing globally.
- Preserve delegated subagent identity on task child sessions.
- Avoid a shell-cancel race by cancelling an existing session runner during short busy-state transitions instead of marking the session idle too early.

## 0.1.4 - 2026-06-13

- Stop normal automatic and manual compaction from re-triggering the assistant after a completed turn.
- Keep overflow compaction recovery for requests that really hit provider context limits.
- Make `Tab` mode cycling update the active prompt mode instead of leaving the mode label stuck while model state changes.

## 0.1.3 - 2026-06-13

- Show richer Agent View welcome timestamps, including `Today` plus contextual day, month, and year information.
- Show the local package version in the welcome screen instead of `local` when running from source.
- Clarify prompt-context commands in the TUI by renaming the persistent selector and hiding the low-value cycle command from Ctrl+P.
- Backport OpenCode terminal and SDK fixes for structured SDK errors, Basic Auth defaults, local MCP `cwd`, and MCP prompt/resource timeouts.
- Stamp release binaries with the requested `MENDCODE_VERSION`/`OPENCODE_VERSION` and include release workflow changes in generated notes.

## 0.1.2 - 2026-06-13

- Publish MendCode under the `mendcode` command name and remove the public `mend` package alias.
- Normalize source and package metadata to `0.1.2` after the public `v0.1.1` release.
- Show the MendCode runtime version in welcome, CLI, debug info, health responses, and Zed extension metadata.
- Keep update checks on `MendCode/MendCode` GitHub releases and skip autoupdate for local/source builds.
- Preserve offline startup by treating update lookup failures as non-blocking.
- Replace user-facing `mend` and `mend-runtime` command hints with `mendcode`.

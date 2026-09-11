# Task packet: mendcode-beta-reliability-readiness

Source SHA-256: 9625c5acb9b9804ecaf5eb7912e33f229c262e85b8fa5ab776c5eba3018e84b5

## Goal

Ship an evidence-verified MendCode GitHub beta from dev that preserves tool arguments, approves proven safe scoped actions without nuisance prompts, recovers connections promptly without replaying effects, obeys double-Esc stop, supports simple beta/stable switching, and requires only MendCode public commands; verify and accurately document built-in computer capabilities.

## Context

Authoring 2026-09-07, not implementation. Observed checkout dev HEAD b5646990dbc48d3326049e299f5cb9355a9212f8 is ahead 4/behind 11 against origin/dev 995a6a67117adc7894924285fc8c051e3bd72001; origin/main 234d4b6034085e1b78d5a73973c62ecc3150d09f. GitHub latest observed beta v0.1.44-beta.3, stable v0.1.44; no open PR returned. These are observations, not a reservation of beta.4. Dirty prompt/TUI/keybind/dock files and untracked command-panel/setup/docs files predate this task and must remain untouched. The user now authorizes an isolated worktree and eventual GitHub beta on dev, not a main promotion. Latest request is to author a spec; no execution or publication now. Source was inspected using git show origin/dev:path and selective reads of /private/tmp/mendcode-beta4.HK5UFA (owned by other work; do not edit it). Later inspection found concurrent uncommitted native/incremental compaction changes there; only immutable 995a6a67 Git objects establish shipped beta.3. The inspected message-v2 replay region matches baseline; its foreign worktree diff adds optional User fields elsewhere. Never treat that worktree's compaction.ts as released behavior. Latest user addition reports >30s MendCode compaction versus about 5s Codex CLI; T13 adds source investigation and comparable measurement protocol, reusing existing fast-context R2/R3/R4 rather than duplicating implementation. Execute from a newly verified isolated dev baseline, not by copying remote source over the shared checkout. Existing plans: docs/tasks/smart-approval-real.md supplies preserved backend ownership/authority contracts (R1-R8); .agents/specs/mendcode-durable-recovery-v1/requirements.md supplies preserved REQ-4/5/6/7 recovery and stop invariants; .agents/plans/mendcode-opencode-rebrand.md supplies staged compatibility rules. This packet is the authoritative delta for the current incident/reliability release, not a replacement of those broader trees. docs/tasks/mendcode-beta4-fast-context-orchestration.md remains separate; do not include its native compaction or compound-model features in this release without explicit integration and revised scope. At execution coordinate shared provider/prompt/release ownership and choose an unoccupied beta number. User requests several GPT-5.4 mini fast agents for future rename implementation; retain this preference without selecting or launching a runtime during authoring. At most three independent future workers, only if available, no nested delegation; unavailable exact model must be reported rather than silently substituted.

Observed implementation: tool-discovery.ts withToolDiscovery wraps AI SDK tool_search and persists discoveredTools via tool output; MessageV2.toModelMessages replays state.input across completed/error/interrupted parts; processor.normalizeToolInput parses input into records. Copilot Responses conversion serializes JSON.stringify(part.input), which would omit arguments for undefined, but the reported OpenAI route's cause is NOT proven. OpenAI SDK is 3.0.53, compatible SDK 2.0.41; locked bun.lock and package preload must be used, no incidental dependency refresh. CodexAuthPlugin preserves distinct OAuth normalization/Responses Lite versus API-key contracts. shell-analysis.analyzeShellCommand currently does not recognize Git subcommands and flags any token containing '..', including HEAD...origin/dev; its environmentDigest hashes key presence, not values, and executableIdentities currently hold names. Permission.Service in src/permission/index.ts owns fast lane/model/manual decisions; never replace it with a TUI-only bypass. SessionRetry has 1-second transport retries with infinite default network attempts/duration, 2-second exponential provider delay, 8 attempts/15-minute nominal provider budget; processor has a 60-second idle watchdog and 5-second shell settlement. TUI SessionControl stores a bounded owner-routed cancellation outbox and prompt/index.ts arms double Esc then calls cancelTurn/abort; user reports historical restart races, no current runtime reproduction was performed. UpgradeCommand already supports upgrade channel set beta|stable, upgrade --check, and --rollback; channel selection does not install. Release-channel preferences are separate from DB layout, stable default. Installation.upgrade verifies release index/checksums and database journal compatibility. Package version remains stable semver 0.1.44; prerelease.yml on dev derives <base>-beta.<number>, invokes release.yml, produces a reviewable draft. Do not put a prerelease string in package.json simply to create the beta. Public package is mendcode, its mendcode/mendcode-runtime bins point at bin/opencode; public-bin.ts is another launcher path that needs parity verification. ComputerCaptureTool and ComputerKeyTool are registered built-ins: macOS screenshot PNG <=8 MiB, preview <=1600 px, 64 session artifacts; keyboard capture token <=30 seconds, one use, same session and foreground PID. No pointer, arbitrary text entry, or built-in Windows/Linux desktop control. Official openai/codex main SHA a44454656459437fc8e2ffa9eca0646537b1fdfd was observed; a bounded code search returned no matching computer tools, which does NOT prove absence or parity with Codex Desktop.

All future Bun tests run in src/mendcode/packages/opencode using test/AGENTS.md tmpdir/testEffect helpers and package preload, with an explicit fresh temporary MENDCODE_DB and isolated HOME/XDG/config (including legacy test-home alias until migrated). Never touch live auth/database or install dependencies by habit. Manual TUI smoke is run by Obed in a real terminal, never automated by an agent via PTY/expect/tmux/computer injection. Evidence from old plans is reference only, not current PASS.

2026-09-07 execution scope amendment: the user explicitly confirmed that BOTH this reliability packet and the complete mendcode-beta4-fast-context-orchestration.execution.json packet belong in the next beta on dev. This supersedes historical separation/authoring-only statements above and D1's former separate-release restriction. The current session owns /private/tmp/mendcode-beta4.HK5UFA; other worktrees and the dirty main checkout remain protected. Shared provider, prompt, session lifecycle, configuration and release edits have one lead and are integrated serially. Both packets retain their individual acceptance requirements; neither packet's passing tests accept the other. No main promotion, new dependencies/schema, paid live benchmark budget, subagent delegation or waiver of manual/platform/security gates is granted by this scope confirmation. The beta number remains unreserved until current release inspection.

## Decisions

D1 (amended 2026-09-07 by explicit user confirmation): deliver this complete reliability scope and the complete fast-context/orchestration packet together in the next verified beta on dev. Preserve dirty work and use the session-owned isolated worktree. Serialize shared files under the session lead and require the union of both packets' acceptance evidence before publication. D2: Safe means complete host-verified effects inside causal user authority, not any known executable name or reviewer confidence. Low-risk actions auto-allow without reviewer network call, regardless of command family when a semantic adapter proves them. Explicit bounded reversible medium-risk actions may auto-allow under verified effects/authority; unknown scripts, external access, secrets, destructive actions and unproven grammar remain ask or configured deny. D3: No empty-arguments workaround: preserve actual stored arguments and call/result identities; unrepresentable legacy calls are surfaced as recoverable history errors without replaying tools. D4: Retry state belongs to session generation, cancels promptly, and cannot re-execute uncertain tool effects. Fast targets are design targets, not existing measurements. D5: Double Esc stops the session's current generation, queued continuations, attached child/tool work and automatic wakes; it does not delete history or kill the shared server. Independently user-started durable workflows remain separately controlled and visibly identified; descendants owned by the stopped turn cannot resume it. D6: New proposed CLI is mendcode upgrade --channel stable|beta (also update alias), selecting/installing one channel in one command, with transactional preference promotion and existing verified compatibility guards. Existing channel subcommands remain backward compatible. The current older stable cannot be assumed to understand new --channel: after downgrading, use its existing mendcode upgrade channel set beta && mendcode upgrade to return until a future stable ships the new option. D7: MendCode-only user experience, not zero occurrences of the legacy token. Preserve licenses, external package/provider IDs, protocol compatibility, legacy data/config readers and internal packages/opencode path in this beta; add canonical names and narrow bridges, never a global replace. D8: Computer use audit is required, full mouse/text or cross-platform implementation is not silently added. Publish exact current capabilities/permission prerequisites; if full parity is wanted, author a separate provider/platform-specific design. D9: Build/publish next available beta from reviewed immutable dev SHA via existing prerelease workflow after user manual smoke confirmation, without moving existing tags or promoting main/stable Latest. Release number selected after collision check; beta.4 is only the next observed candidate, not reserved.

## Recovery

On stale baseline, shared-file ownership conflict or disproven diagnosis stop the affected task and update canonical packet/mirrors; continue independent supported work. Never reset/stash/clean the shared checkout, reuse another worktree without ownership, mutate production SQLite, lower security defaults to full_access, or delete historical tool records. Roll back only owned source changes by focused patch/revert; reinstall last verified executable only through existing compatibility-checked rollback. A failed channel transition leaves current executable/channel/data unchanged where synchronous replacement is possible; deferred Windows replacement records pending state and commits preference only on verified completion. Failed or unavailable platform/provider/manual evidence blocks publication claims. No automatic release retries with new tags after an unknown external result; inspect GitHub first.

## Requirements

- BR-13: Investigate reported beta compaction >30s versus Codex CLI about 5s using pinned released source and phase-separated comparable measurements; reuse existing fast-context plan R2/R3/R4 for any optimization, preserve cancellation/context fidelity, and never claim a universal 5-second result ; integrate the separately specified full fast-context/orchestration scope under the explicit 2026-09-07 user authorization, retaining its evidence gates.
- BR-01: WHEN implementation starts, preserve existing local work, reconcile competing release plans, and use a reviewed isolated current-dev baseline; release only this approved scope.
- BR-02: WHEN a tool call is stored, replayed or retried, retain exact validated arguments and matching call/result identity through the final provider request for discovery and ordinary tools; no Missing input[n].arguments and no fabricated empty replacement.
- BR-03: WHEN Smart mode can prove a complete bounded safe action and causal authority, approve automatically without a nuisance manual prompt; apply semantic effect analysis to command families rather than an unconditional name allowlist. Preserve smart-approval-real R1/R2/R4.
- BR-04: WHEN an action is unknown, stale, out of authorized bounds or denied, never auto-allow it; preserve backend single-owner approval, cancellation, bounded records and explicit deny precedence (smart-approval-real R2/R3/R5/R7).
- BR-05: WHEN transport fails, provider returns a transient outage, or a stream stalls, show truthful distinct state and retry promptly with cancellation, budgets and Retry-After compliance; do not label every timeout Wi-Fi loss or change provider/auth/model.
- BR-06: WHEN the connection recovers, resume exactly once from an authoritative durable safe boundary, preserve partial output and inputs, deduplicate subscriptions and never replay uncertain side effects; preserve durable-recovery REQ-4/5/7.
- BR-07: WHEN Esc is pressed twice for the same active target within the existing arming window, stop-and-hold the current generation and its queued/wake work, confirm only after backend acknowledgement, and never restart it on reconnection or late completion; an explicit new submission starts a new generation. Preserve and refine durable-recovery REQ-6.
- BR-08: WHEN the user runs mendcode upgrade --channel stable or beta, resolve/install that channel and persist preference only after successful replacement; preserve current installation/data on failure and existing schema/rollback guards. --check remains read-only.
- BR-09: WHEN a user installs, launches, authenticates, configures, diagnoses, updates or automates MendCode, every documented supported command uses mendcode, never requires opencode; preserve legacy configuration/data/protocol compatibility and legal attribution.
- BR-10: WHEN computer tools are discovered, report and expose actual built-ins, supported OS, OS permission prerequisites and limits; prove capture/navigation in a controlled macOS app and do not claim pointer/text or Codex Desktop parity without evidence.
- BR-11: WHEN approval, retry or stop state changes, retain existing TUI layout/theme/editor/scroll and show one truthful concise state; all relevant states remain operable at 80x24 and 120x40 terminal cells.
- BR-12: WHEN publishing the new GitHub beta, require current focused/security/artifact/manual evidence, an immutable reviewed dev SHA and unique tag, prerelease=true and stable Latest unchanged; report actual URL/version/checks and limitations, not blanket production-readiness guarantees.

## Design Contract


### Intent

Let terminal users work without unnecessary prompts, understand connection recovery, stop reliably and switch channels without learning internal runtime names.

### Baseline

User screenshots inspected in conversation: green-on-dark terminal, transcript above bottom prompt, inline permission panel for harmless Git command with risk medium and unknown_executable:git/path_boundary_requires_check, repeated provider arguments error. These establish symptoms/structure, not runtime behavior or a required hardcoded palette. Actual source theme remains user-selectable.

### Delta


#### Preserve

- Existing transcript/editor/footer geometry, user-selected theme, permission actions, keyboard navigation, scroll and focus.

#### Add

- Concise reason-specific recovery states and channel-switch CLI help/results.

#### Change

- Only real uncertainty opens permission panel; stop/retry labels reflect acknowledged backend state.

#### Remove

- Nuisance permission panel for the proven safe Git screenshot command and public instructions requiring opencode; no indiscriminate removal of legacy compatibility.

### References


#### Reference 1


##### Source

User screenshots of Missing required parameter input[1].arguments and Smart Approval Git prompt, 2026-09-07 conversation

##### Status

inspected

##### Take

Preserve transcript above prompt and inline permission structure; keep the actual command readable.

##### Avoid

Do not copy duplicated error toast/panel or treat shell window chrome as MendCode UI. Image files are not stored in this packet; essential interpretation is embedded here.

#### Reference 2


##### Source

src/mendcode/packages/opencode/src/cli/cmd/tui/context/theme/mendcode.json and component/prompt/index.tsx at 995a6a67

##### Status

inspected

##### Take

Reuse theme.text, textMuted, warning, error, success, backgroundPanel and current prompt status location.

##### Avoid

Do not hardcode screenshot green or replace user themes, fonts or existing widgets.

### Composition

- Reading order: transcript, at most one compact connection/stop status at existing prompt status slot, editable prompt, existing key hints. Permission-required uses existing inline panel with command, concise reason, actions; details may wrap, no new global banner.
- Terminal-native monospace inherited from host; one-cell spacing and existing panel padding/borders. No new imagery, fonts, icons, animations, dashboards or decorative cards.

### Tokens

- Reuse src/mendcode/packages/opencode/src/cli/cmd/tui/context/theme.tsx semantic tokens. Default mendcode.json dark text=#eeeeee, textMuted=#808080, backgroundPanel=#141414, warning=#f5a742, error=#e06c75, success=#7fd88f; user's selected theme overrides these.
- Use existing prompt and permission component metrics; no new fixed pixel dimensions or font installation.

### Content

- Proposed English copy follows incumbent UI: 'Connection unavailable · retrying in {n}s', 'Provider unavailable ({status}) · retrying in {n}s', 'Provider response stalled · retrying in {n}s', 'Waiting for provider cooldown · {n}s', 'Recovery paused · retry to continue'. Never say Wi-Fi is disconnected based only on ECONNRESET/DNS/timeout.
- Stop states: '[esc again to interrupt]', 'Stopping…', 'Stop not confirmed · reconnecting', 'Stopped'. Show 'Stopped' only after authoritative acknowledgement; error detail must not include auth headers or complete requests.
- CLI examples: mendcode upgrade --channel stable; mendcode upgrade --channel beta; mendcode upgrade --channel beta --check; mendcode upgrade channel. Success reports installed version, selected channel and restart requirement, not a false runtime-health pass.
- Computer docs say 'Built-in macOS screenshot and navigation keys; pointer control and arbitrary text entry are not supported'.

### States

- J1 Given Smart mode and an authorized workspace, When screenshot Git chain runs, Then it executes without manual UI; replacing second segment with a destructive operation produces a manual/configured-deny outcome.
- J2 Given an active request, When a controlled connection fails and returns, Then one truthful retry state transitions back to running once without duplicate transcript/tool effects; slow healthy reasoning does not display Wi-Fi loss.
- J3 Given a running/retrying/permission-waiting turn, When double Esc targets that turn, Then stopping is visible immediately, stopped only after backend ack, and late events/reconnect cannot restart it; explicit new submission works.
- J4 Given a beta install, When upgrade --channel stable succeeds, Then stable version/channel is shown and data remains compatible; verification/compatibility failure keeps beta and explains the blocker.

### Adaptation

- Test 80x24 and 120x40 terminal cells, narrow split and full pane. Status text may wrap to at most two lines at 80 columns with details elsewhere; editor and Esc hint remain visible. Long commands wrap inside permission panel, never push actions off-screen without existing scrolling.
- Preserve focus and typed draft during asynchronous retry/permission/stop events. Existing modal Esc handling remains modal-first; double-Esc arming is target-scoped, not a global kill shortcut.

### Acceptance

- T10/J1-J3 requires user-run real-terminal interaction and screenshots at both cell sizes; source-only render assertions cannot accept it.
- T6/T7/T10/J4 verify public CLI help and installed channel results; T9 verifies capability copy matches actual discovery.

## Execution Policy


### Profile

fix

### Rationale

Cross-boundary serialization, permission safety, session lifecycle and release compatibility dominate. Diagnosis precedes repair; focused contracts and user-run terminal evidence must disprove duplicate effects, unsafe allows and fake recovery.

### Locked Decisions


#### Entry 1


##### Decision

D1/D9: isolate current dev and ship only an evidence-approved unique GitHub beta; do not promote main or replace existing tags.

##### Reason

Observed shared checkout is divergent/dirty and another plan also proposes beta.4.

##### Invalidated By

Current remote release/source or worktree ownership changes; reconcile candidate SHA and sequence before any edit or external write.

#### Entry 2


##### Decision

D2: auto-approval requires complete semantic host facts plus authority and deny precedence; unknown remains ask.

##### Reason

Arbitrary executable safety is not decidable from a command name or model answer; current Git/path heuristics cause false positives and identity gaps could cause unsafe allows.

##### Invalidated By

A newly supported command has unmodeled hooks, environment, path, network or expansion effects; disable its automatic path until proved.

#### Entry 3


##### Decision

D3/D4/D5: durable argument fidelity and stop generation dominate retry convenience; never replay an unknown tool outcome.

##### Reason

The screenshot proves request rejection, not an upstream cause; retry and late child events can repeat mutations or resurrect a cancelled run.

##### Invalidated By

Observed provider protocol or lifecycle ownership differs; collect boundary evidence and revise before patching.

#### Entry 4


##### Decision

D6/D7: use existing updater compatibility checks and staged MendCode names, retain legacy bridges and internal runtime directory.

##### Reason

A beta-to-stable shortcut or mass rename must not lose history/auth or bypass verified release assets.

##### Invalidated By

A required installed entrypoint depends on legacy-only routing or deferred installer semantics cannot commit channel atomically; revise that exact contract.

#### Entry 5


##### Decision

D8: certify actual macOS capture/navigation only; no unsupported parity claim or covert OS permission grant.

##### Reason

Source explicitly excludes pointer, arbitrary typing and other OSes; user asked to verify built-ins.

##### Invalidated By

A newer baseline contains additional proven native capabilities; re-inventory before declaring a gap.

### Discretion

- Choose helper decomposition and table-driven fixture organization within named files; keep interfaces backward compatible except explicitly added optional fields/options.
- Future lead may delegate disjoint rename tasks using the user's requested GPT-5.4 mini fast if exposed; no runtime/model selection here. Shared paths serialize even without a parallel_group.

### Escalation

- Missing material provider diagnosis blocks T2, not independent work.
- New dependency, OS desktop automation backend, SQL migration, destructive data conversion or broader release content requires a revised contract and explicit approval.
- Unproven cancellation propagation or unsafe approval fixture blocks publication; never waive it to ship sooner.
- Missing manual/platform evidence remains BLOCKED; do not substitute source assertions for real-terminal proof.

### Validation


#### Required Checks

- T0
- T1
- T2
- T3
- T4
- T5
- T6
- T7
- T8
- T9
- T10
- T11
- T12
- T13

#### Excluded Checks

- No implementation tests, builds, app launches, OS control or live inference during spec authoring.
- No full monorepo suite by ceremony: focused runtime suites plus release-mandated CI/platform gates suffice unless a shared-boundary regression expands scope.
- No paid model matrix or arbitrary third-party network canary; live route proof uses minimal approved non-sensitive calls and existing credentials without logging secrets.

#### Rerun When

- Relevant source/tests/config/dependencies/platform change; previous result fails or flakes; assertion coverage does not prove the criterion; release binary differs from tested candidate.

#### Failure Limit

2

Policy semantics: preserve locked decisions unless current evidence invalidates them; use only the declared local discretion. On an escalation trigger, stop affected work and report the observation and required decision; continue independent authorized work.
Validation required_checks names task IDs, not a waiver of other mandatory criteria. Reuse successful evidence only when relevant source, dependencies, environment and coverage still match. failure_limit counts consecutive ineffective attempts at one criterion before revisiting diagnosis; it never turns missing or failed evidence into acceptance. Policy fields grant no extra edit, publication or device permissions.

## Execution and evidence

Planning state: draft. Execution has not started.
Closure owner: session_lead. Evidence: .agents/specs/mendcode-beta-reliability-readiness/evidence.json. State: .agents/specs/mendcode-beta-reliability-readiness/execution_state.json.
Edit/new files scope product content. The evidence_file and each verification.evidence path authorize only named evidence artifacts; state_file names the execution state. Only the session lead aggregates evidence_file/state_file. Evidence outputs must not overwrite product/input files, existing unrelated artifacts or the planning source. Workers use distinct check-evidence files and required parent directories; no other output paths are implied.
Verify tools and permissions before work. Missing capabilities block only dependent criteria.
Record actual checks as PASS, FAIL, BLOCKED, NOT_RUN or NOT_APPLICABLE with evidence.

## T0 — Freeze isolated baseline and release ownership

### Work Kind

decision

### Depends On

None.

### Parallel Group

None.

### Read First

- src/mendcode/AGENTS.md
- src/mendcode/packages/opencode/AGENTS.md
- src/mendcode/packages/opencode/test/AGENTS.md
- docs/tasks/mendcode-beta4-fast-context-orchestration.md
- docs/tasks/smart-approval-real.md
- .agents/specs/mendcode-durable-recovery-v1/requirements.md
- .agents/plans/mendcode-opencode-rebrand.md
- src/mendcode/packages/opencode/package.json
- src/mendcode/bun.lock
- .github/workflows/prerelease.yml

### Edit Files

None.

### New Files

None.

### Symbols

- Git dev baseline, package version and prerelease workflow candidate selection

### Interfaces

- Use existing Git worktree commands at execution only; user authorized an isolated current-origin/dev candidate, not resetting the shared dev checkout.

### Inputs

- Current refs/releases/open PRs/worktree owners and dirty paths; this packet and overlapping prior plans.

### Outputs

- Recorded candidate base SHA, isolated owned path, excluded dirty-work inventory, unique release sequencing owner and verified task path map.

### Operation Order

1. Recheck remote refs and GitHub release/PR state; record existing local diffs without exposing setup secrets.
2. Create a fresh isolated worktree from verified origin/dev under an approved temporary parent; do not edit /private/tmp/mendcode-beta4.HK5UFA or the shared checkout.
3. Re-read every task path against new baseline; inspect prior cancellation commits as regression evidence, not permission to cherry-pick unrelated changes. Coordinate with beta4 context plan before shared provider/prompt/release work.
4. Record supported installed Bun/preload, isolated DB/HOME fixture setup and platform tools. Mark newer incompatible paths/ownership as blockers before implementation.

### Error Semantics

- Remote/ref/owner mismatch blocks dependent edits; no automatic merge, stash, reset, force push or version reservation.

### Examples

- A fresh worktree based on current dev with shared dirty prompt untouched is valid; beta.4 remains provisional until release time.

### Counterexamples

- Publishing the old b5646990 tree or committing all local files would omit remote fixes and include unrelated work.

### Non Goals

- No native compaction/cascade features from the other plan, no worker launch as part of authoring.

### Acceptance

- T0.A1: immutable source and isolated ownership recorded; every named existing path verified at that source, new paths explicitly new; release scope excludes unrelated work.

### Required Capabilities

- code-read
- command
- github-read

### Traces To

- BR-01
- BR-12

### Verification

- kind: inspection
- procedure: Inspect git status --short --branch, git worktree list, git ls-remote origin refs/heads/dev refs/heads/main, gh release list --limit 10 and gh pr list --state open --limit 20; compare scoped paths to frozen SHA and prior plans.
- cwd: .
- preconditions: Implementation explicitly requested; isolated-worktree authorization retained; no active foreign worktree reused.
- expected: T0.A1 documented with exact SHA/path and no shared edits.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T0-evidence.md


### Stop Condition

Stop affected work if base or ownership cannot be established, a task depends on excluded dirty work, or a competing release is in flight.

## T1 — Reproduce missing provider tool arguments at the wire boundary

### Work Kind

text_test

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/test/session/tool-discovery.test.ts
- src/mendcode/packages/opencode/test/plugin/codex.test.ts

### Edit Files

- src/mendcode/packages/opencode/test/session/tool-arguments-replay.test.ts

### New Files

- src/mendcode/packages/opencode/test/session/tool-arguments-replay.test.ts

### Symbols

- withToolDiscovery
- MessageV2.toModelMessages
- normalizeToolInput
- LLM.Service
- prepareCodexChatGPTOAuthRequest

### Interfaces

- Input tool_search arguments {query:string,limit?:integer 1..8}; canonical tool part has callID and state.input record; final Responses function_call must contain arguments:string with JSON value matching actual input, paired with same call_id result.

### Inputs

- Screenshot command query='computer desktop screenshot click type mouse', limit=2; controlled persisted complete/error/interrupted tool fixtures, ordinary tool controls and selected provider/auth route.

### Outputs

- Minimal real pipeline regression test, redacted final request shape, exact layer where input first differs or explicit unreproduced result.

### Operation Order

1. Build a local mock Responses endpoint fixture through actual SDK/provider/serializer path; do not duplicate conversion logic in tests.
2. Drive discovery, persist result, send a follow-up user message, and capture outgoing JSON structurally without credentials/full private transcript.
3. Compare fresh/reopened history, failed/interrupted calls, discovery-enabled/disabled and ordinary tools; cover OAuth request adaptation and API-key control separately.
4. Identify first lossy boundary. If malformed history alone is responsible, document how it arose and expected recoverable behavior; if unable to reproduce, block speculative T2 patch and collect a sanitized actual failing request shape with user consent.

### Error Semantics

- A displayed tool query is not proof the final request contained arguments. Never clear a real session to hide the incident; no real desktop clicks or provider spending needed for first reproduction.

### Examples

- JSON.parse(function_call.arguments) equals {query:'computer desktop screenshot click type mouse',limit:2} on follow-up; call/result IDs stay paired.

### Counterexamples

- A unit test calling searchTools directly passes while history replay still sends undefined arguments.

### Non Goals

- No production repair before causal evidence; no installed dependency edits.

### Acceptance

- T1.A1: test or sanitized runtime evidence identifies the failing boundary and a control route; otherwise T2 is explicitly blocked, not marked fixed.

### Required Capabilities

- code
- command

### Traces To

- BR-02

### Verification

- kind: text_test
- procedure: bun test test/session/tool-arguments-replay.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: New regression fixture implemented with isolated DB/HOME and package preload; use frozen SDK versions and local mock endpoint.
- expected: Reproduction evidence records expected failing assertion on baseline or an explicit blocked diagnosis; no manufactured root cause.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T1-evidence.md


### Stop Condition

If reproduction does not identify loss in a named production boundary, stop T2 and request only the missing sanitized route/request evidence.

## T2 — Repair tool-call replay without discarding real arguments

### Work Kind

product_code

### Depends On

- T1

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts
- src/mendcode/packages/opencode/test/session/tool-arguments-replay.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts
- src/mendcode/packages/opencode/test/session/tool-arguments-replay.test.ts
- src/mendcode/packages/opencode/test/session/message-v2.test.ts
- src/mendcode/packages/opencode/test/plugin/codex.test.ts

### New Files

None.

### Symbols

- T1-proven input conversion boundary
- MessageV2.toModelMessages
- CodexAuthPlugin

### Interfaces

- Canonical stored validated input -> SDK tool-call input -> provider function_call.arguments JSON string; same call/result identity and ordering. Provider-native call types keep their protocol shapes rather than receiving blanket arguments fields.

### Inputs

- T1 causal evidence and failing fixture; legitimate empty-object, nested/unicode input, malformed legacy call, cancelled call and model-switch controls.

### Outputs

- Smallest source repair at demonstrated boundary and passing end-to-end replay tests.

### Operation Order

1. Patch only the proven boundary within listed scope; preserve original record input without double JSON encoding.
2. Distinguish legitimate {} for a zero-argument tool from absent input. A valid complete raw JSON object may be recovered only if stored provenance proves it belongs to that call; otherwise stop request preparation with an actionable history validation error and preserve transcript.
3. For unrecoverable legacy call history provide an explicit non-destructive fork/recovery path using the existing session workflow; never silently delete call/result pairs or execute the tool again.
4. Run regression across discovery and ordinary tools, completed/error/pending states, reopen/retry, images and provider switch. Keep OAuth alias/headers and API-key routing intact.

### Error Semantics

- Serialization error is nonretryable request validation, not network outage. Preserve input/history and report affected call ID/tool only, never raw secrets. No arbitrary arguments='{}' repair.

### Examples

- Nested args and Unicode survive JSON decoding exactly; explicit zero-argument {} serializes to '{}'; resumed discovery preserves query and limit.

### Counterexamples

- Deleting tool_search from history, filling every missing argument with {}, or patching only Copilot without proving the OpenAI route hides the incident.

### Non Goals

- No SDK upgrade, provider migration or mass history rewrite; no unrelated native compaction work.

### Acceptance

- T2.A1: T1 regression passes through actual final request; T2.A2: malformed legacy data fails locally without replay or data loss; valid OAuth/API-key/provider-switch controls preserve contracts.

### Required Capabilities

- code
- command

### Traces To

- BR-02
- BR-06

### Verification

- kind: text_test
- procedure: bun test test/session/tool-arguments-replay.test.ts test/session/tool-discovery.test.ts test/session/message-v2.test.ts test/plugin/codex.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: T1 causal evidence exists and fixtures isolate DB/auth/network; inspect actual serialization, not only UI part shape.
- expected: T2.A1/A2 pass; call/result fidelity and rejection controls covered.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T2-evidence.md


### Stop Condition

Disproven diagnosis, required dependency change or an unmodeled provider-native item blocks repair until the packet is revised.

## T3 — Approve semantically proven safe actions across command families

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/tool/shell-analysis.ts
- src/mendcode/packages/opencode/src/tool/shell.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-context.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-service.ts
- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/test/tool/shell-analysis.test.ts
- src/mendcode/packages/opencode/test/mend/smart-approval.test.ts
- docs/tasks/smart-approval-real.md

### Edit Files

- src/mendcode/packages/opencode/src/tool/shell-analysis.ts
- src/mendcode/packages/opencode/src/tool/shell.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-context.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-service.ts
- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/test/tool/shell-analysis.test.ts
- src/mendcode/packages/opencode/test/tool/shell.test.ts
- src/mendcode/packages/opencode/test/mend/smart-approval.test.ts
- src/mendcode/packages/opencode/test/mend/smart-context.test.ts
- src/mendcode/packages/opencode/test/mend/smart-service.test.ts

### New Files

None.

### Symbols

- ActionFactsV1
- analyzeShellCommand
- isBoundedShellInspection
- Permission.Service
- isSafeSmartAutoApprovalRequest
- matchingSmartGrant

### Interfaces

- Retain ActionFactsV1 versioned host-produced facts and fingerprint; optional compatible fields may record semantic command family, canonical executable/script identities and verified target bounds. Do not trust model/MCP metadata as host facts.
- Action effects read/write/network/execute/delete/external are separate from risk and causal authority. Complete low-risk plus authorized scope => deterministic allow; bounded reversible medium-risk plus explicit authority and complete effects => allow through backend policy; unknown/high/critical or configured deny => ask/deny.

### Inputs

- Complete shell AST/argv, frozen plugin-adjusted environment, canonical cwd/root, actual executable/config/script identities, AuthorityContextV1 and policy revision.

### Outputs

- Semantic action classifier reused by fast lane and reviewer normalization; exact screenshot chain auto-approved; broad positive/negative corpus and bounded audit.

### Operation Order

1. Reuse shell.ts existing tree-sitter parse/collect boundary, preserving quoting/expansion/operator distinctions. Reject incomplete/oversized analysis before approving; keep 32 KiB/256 node limits. Avoid a second conflicting regex safety parser.
2. Create semantic adapters for Git read-only status/log/ls-files/ls-tree/show/diff/rev-parse/describe/remote listing; distinguish revspec HEAD...origin/dev and literal patterns from filesystem traversal. Parse options before operands and canonicalize actual paths, allowing absolute paths only inside an authorized root after symlink checks.
3. Cover standard read/search/stat/version commands, composed safe &&/pipes, literal Unicode/quoted paths and native reads; disallow side-effect flags, pre-processors, arbitrary shell substitution, redirections with writes, device/network paths and escapes unless an independently proven bounded adapter covers the exact effect.
4. Resolve actual executable identity rather than basename, fingerprint value changes in relevant frozen environment with a process-keyed digest without exposing values, and include inspected script/config content digests. Revalidate identities/paths/authority/policy immediately before spawn or use of cached approval; mismatch requires new review.
5. Broaden safe execution by effects, not by unconditional binary names: scoped mkdir without overwrites and existing native create/update operations may qualify as reversible medium-risk under explicit task authority; project test/typecheck scripts qualify only when complete transitive scripts/config/hooks and destinations are proven bounded. Otherwise explain the unknown and ask. Do not label arbitrary runtimes safe merely because user said fix.
6. Ensure deterministic low-risk path bypasses reviewer provider even during provider outage and opens no manual panel/toast; preserve deny precedence, manual/full_access contracts, exact grants, context invalidation and review cancellation. Positive fixture set must all auto-allow; negative set must have zero unsafe allows.

### Error Semantics

- Unknown executable/config/hooks/dynamic expansion is an explanatory ask, never an invented malicious denial. Network reads can leak data: no global curl/gh/ssh auto-allow. Explicit host denies remain final.
- Normal Unicode is not an invisible-control attack; actual bidi/control characters and unsupported grammar remain fail-closed. Git external diff/textconv/pager/config overrides can execute code: exclude or prove them before any automatic allow.

### Examples

- Under an in-scope workspace task: git ls-files '*AGENTS.md' '*openai*' '*responses*' '*codex*' && git log --oneline --left-right HEAD...origin/dev => allow without model call.
- A trusted git status --short && git diff --stat with verified non-executing options and a native read inside the root => allow; an explicitly requested bounded directory creation with known targets can also allow without becoming full_access.

### Counterexamples

- Adding git to knownReadCommands approves git reset --hard or git -c core.sshCommand=... fetch; string '..' rejection confuses Git revisions with paths.
- A local fake git earlier on PATH, changed script after approval, sort -o file, find -exec, rg --pre, command substitution or safe first segment && destructive second segment must never inherit read approval.
- A model calling an unknown shell script safe is not complete effect proof.

### Non Goals

- No universal proof for arbitrary executable behavior; no OS sandbox claim, no unconditional command/provider allowlist, no full_access default.

### Acceptance

- T3.A1: 100% of the frozen eligible safe corpus (Git chain, read/search/stat/version, quotes/revspec/authorized paths and proven reversible actions) auto-allow without reviewer calls; unknown actions explicitly excluded with reason.
- T3.A2: zero unsafe automatic permissions across dangerous flags/aliases/PATH/script/env changes/TOCTOU/symlink/operator/context/deny fixtures; T3.A3: backend/TUI/headless paths share decision and cancellation semantics with bounded audit.

### Required Capabilities

- code
- command

### Traces To

- BR-03
- BR-04
- BR-11

### Verification

- kind: text_test
- procedure: bun test test/tool/shell-analysis.test.ts test/tool/shell.test.ts test/mend/smart-approval.test.ts test/mend/smart-context.test.ts test/mend/smart-service.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: Freeze table-driven positive/negative corpus before repair; use fake executable/script files and local roots, no real dangerous commands; inspect host adapter and backend decisions.
- expected: T3.A1-A3 pass and report counts/coverage, not a broad safety claim from one Git fixture.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T3-evidence.md


### Stop Condition

Any unmodeled execution/target identity or unsafe allow blocks the corresponding automatic family and release; expanding dependency/sandbox scope requires revised design.

## T4 — Bound fast recovery and distinguish connection failure causes

### Work Kind

product_code

### Depends On

- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/retry.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/session/status.ts
- src/mendcode/packages/opencode/src/session/recovery.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/sdk.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/sync.tsx
- src/mendcode/packages/opencode/test/session/retry.test.ts
- src/mendcode/packages/opencode/test/session/processor-effect.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/retry.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/session/status.ts
- src/mendcode/packages/opencode/src/session/recovery.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/sdk.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/sync.tsx
- src/mendcode/packages/opencode/test/session/retry.test.ts
- src/mendcode/packages/opencode/test/session/processor-effect.test.ts
- src/mendcode/packages/opencode/test/session/recovery.test.ts
- src/mendcode/packages/opencode/test/cli/cmd/tui/sync.test.tsx
- src/mendcode/packages/opencode/test/session/connection-recovery.test.ts

### New Files

- src/mendcode/packages/opencode/test/session/connection-recovery.test.ts

### Symbols

- SessionRetry.delay/policy/retryable
- MessageV2.isNetworkError
- timeoutStreamUnless
- SessionStatus
- TUI SDK reconnect/sync

### Interfaces

- Preserve existing status type retry with attempt/message/next epoch milliseconds; reason-specific copy may be derived without breaking event/SDK shape. Categorize transport, provider_unavailable, rate_limited, stream_stalled, auth, invalid_request, cancelled and backend_unreachable independently.

### Inputs

- Error status/code/headers, abort signal, active generation, actual stream activity, persisted tool state and injected clock/local fault endpoint.

### Outputs

- Bounded cancellable retry policy, truthful status, generation-safe reconnect and measured fault-fixture timings.

### Operation Order

1. Reproduce connection refusal/reset/DNS/network unreachable, HTTP 502/503/429, silent stream and healthy slow reasoning with local deterministic fixtures before modifying policy.
2. Preserve immediate transport error handling: retry every 1000 ms during first 30 seconds, then at most every 5000 ms, total 15-minute recovery budget per generation. No infinite default. At budget exhaustion show recovery paused and require explicit retry/new submission; no background inference while paused.
3. For provider 500/502/503/504 use 1000,2000,4000,5000 ms bounded backoff (cap 5000 without headers), at most 8 attempts and 15 minutes. Honor valid nonnegative Retry-After seconds/date or retry-after-ms, never retry earlier; invalid/negative hints fall back. If cooldown exceeds remaining budget, pause with cooldown info, not timer overflow.
4. Keep healthy stream idle default 60000 ms and existing explicit override; classify expiry as stalled, not proven offline. Do not kill legitimate tool execution/compaction merely because model stream is quiet. Abort and request-validation errors never retry; auth errors are actionable, no provider/account hopping.
5. Publish observed failure within 1000 ms after error reaches host; local fast-path recovered attempt should start within 1500 ms in first 30 seconds, <=5500 ms afterward (excluding cooldown/service processing). These are design targets measured in controlled tests, not a guarantee of detecting physical Wi-Fi instantly.
6. On TUI transport reconnect, one subscription owner refreshes authoritative state before dispatch; partial transcript/draft/tool receipts survive, stale/double events dedupe. A request with any visible tool attempt resumes only from settled durable receipt; unknown side effects stop for inspection instead of replay. Cancel sleeps/fetch/listeners on abort/disposal and keep no idle monitor.

### Error Semantics

- An inference timeout alone does not establish Wi-Fi/provider outage. No external internet health ping, hidden provider switch, reauthentication loop, fresh paid request flood or repeated side effect.
- HTTP 400 missing arguments is not retryable. Unsupported model/not-found is not globally treated as transient; retain narrowly documented provider exception only with an exact fixture.

### Examples

- 503 then 200 without Retry-After retries after 1 second; 429 Retry-After:10 waits at least 10 seconds; socket recovery at 5 seconds starts one safe attempt within next 1.5 seconds.

### Counterexamples

- Network retries forever once per second; treating all 404 as outages; a 1-second stream watchdog aborts healthy reasoning; reconnect repeats a completed shell write.

### Non Goals

- No OS Wi-Fi toggling service, continuous global health checks, transport brand assumptions or universal latency promise.

### Acceptance

- T4.A1: fault matrix classifies truthfully and meets controlled retry/budget targets; T4.A2: healthy slow reasoning, Retry-After, abort and invalid requests behave correctly; T4.A3: reconnect preserves history and exactly-once tool receipt semantics with one subscription.

### Required Capabilities

- code
- command

### Traces To

- BR-05
- BR-06
- BR-11

### Verification

- kind: text_test
- procedure: bun test test/session/retry.test.ts test/session/processor-effect.test.ts test/session/recovery.test.ts test/session/connection-recovery.test.ts test/cli/cmd/tui/sync.test.tsx --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: Use injected/fake clock for 15-minute budgets and bounded local mock streams; no real network disruption or global DB.
- expected: T4.A1-A3 measured with attempt counts, timestamps and sentinel tool side-effect count=1; full budget ends with zero scheduled retry/fetch.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T4-evidence.md


### Stop Condition

If transport cannot be cancelled or retries need uncertain tool replay, stop affected path; measure/diagnose instead of shortening every timeout.

## T5 — Make double-Esc stop-and-hold immune to retry and wake races

### Work Kind

product_code

### Depends On

- T3
- T4

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/effect/runner.ts
- src/mendcode/packages/opencode/test/effect/runner.test.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/session-control.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/session/run-state.ts
- src/mendcode/packages/opencode/src/session/runtime-mailbox.ts
- src/mendcode/packages/opencode/src/session/continuity-control.ts
- src/mendcode/packages/opencode/src/session/background-task.ts
- src/mendcode/packages/opencode/test/session/prompt.test.ts
- src/mendcode/packages/opencode/test/cli/tui/session-control.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/effect/runner.ts
- src/mendcode/packages/opencode/test/effect/runner.test.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/session-control.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/session/run-state.ts
- src/mendcode/packages/opencode/src/session/runtime-mailbox.ts
- src/mendcode/packages/opencode/src/session/continuity-control.ts
- src/mendcode/packages/opencode/src/session/background-task.ts
- src/mendcode/packages/opencode/test/session/prompt.test.ts
- src/mendcode/packages/opencode/test/session/background-task.test.ts
- src/mendcode/packages/opencode/test/cli/tui/session-control.test.ts
- src/mendcode/packages/opencode/test/cli/tui/prompt-working-start.test.ts
- src/mendcode/packages/opencode/test/session/stop-generation.test.ts

### New Files

- src/mendcode/packages/opencode/test/session/stop-generation.test.ts

### Symbols

- SessionPrompt.cancel/cancelTurn
- SessionRunState.cancel
- SessionControlProvider
- sessionCancelResultNeedsHardAbort
- abortSession
- cancelOwnerWakeSession

### Interfaces

- 2026-09-07 scoped implementation amendment: Runner.cancelCurrentIf prepares stop effects under its existing SynchronizedRef target lock and accepts includeTerminal for the latest admitted key. startShell threads an optional target key through SessionRunState; no public HTTP schema or database migration. Targeted stop clears pending runner continuations and never escalates to an unfenced TUI abort. Cold-restart terminal fencing still requires separate durable evidence; this amendment is not full T5 acceptance.
- Existing cancelTurn(sessionID,targetMessageID) returns cancelled|already_terminal|target_mismatch|not_running; stop outbox must retain actual session owner route and a generation/target fence. A stale target_mismatch is not permission to hard-abort a newer generation.
- Stop intent is durable for the cancelled generation; automatically queued/wake work cannot clear it. An explicit new user submission creates a new generation only after acknowledged prior stop or deliberate reconciliation.

### Inputs

- Double-Esc same target, pending local deliveries, server queues, active tools/reviewer/subagents, retry timer and delayed completion/reconnect events.

### Outputs

- Backend-acknowledged terminal current generation, held/cancelled queued continuations, preserved typed text/history and no spontaneous next iteration.

### Operation Order

1. Freeze race regressions first: generating, retry sleep, permission review, shell child, compaction, submission handoff, duplicate stop, route switch, reconnect and child completion.
2. Keep existing double-Esc arming window and modal-first handling; second press for same target immediately blocks local automatic delivery and records stop intent before async cancel transport.
3. Backend atomically fences current generation and automatic wakes/queued continuations, propagates abort through providers/reviewers/tools/attached descendants, settles exact tool outcomes and terminal messages. Do not erase queued user text: mark held/cancelled explicitly for manual resubmission.
4. Remove stale-target hard-abort races: re-read authoritative owner/target before any session-wide fallback; never use an old outbox request to stop a later explicitly submitted turn. Persist unconfirmed stop and replay it before inference on reconnect.
5. Reuse existing bounded control retries and process-group cleanup; local controlled backend ack target <=2000 ms, owned shell cleanup <=existing 5000 ms settle budget. If backend unreachable show stop not confirmed, never pretend stopped or kill shared server.
6. Late provider/tool/task events after stop may settle audit/output but cannot create a new model iteration or owner wake. Verify restart loads stop fence. New explicit prompt after acknowledged stop runs once; independent manually started workflow remains separately controlled and is not misrepresented as killed.

### Error Semantics

- Transport failure keeps cancellation pending/unknown with retry control; not successful cancellation. High-latency stale cancel must not abort another session or new generation.
- Stopping cannot undo an already completed external side effect; record it truthfully and never auto-retry it.

### Examples

- Double Esc during retry => zero provider calls after acknowledgement even after fake clock advances 15 minutes and child completion arrives; a later explicit new message runs normally.

### Counterexamples

- Set spinner to idle while backend continues; reject queued markers then run them on reconnect; unconditional hard abort on target_mismatch kills the user's newer turn.

### Non Goals

- No session deletion, global daemon kill or stopping unrelated workflows/projects; no new keybinding scheme.

### Acceptance

- T5.A1: no post-ack request/tool start/automatic wake for cancelled generation across all races and restart; T5.A2: bounded visible stop/cleanup, preserved drafts/history and new explicit turn works; T5.A3: no cross-session/new-generation cancellation.

### Required Capabilities

- code
- command

### Traces To

- BR-04
- BR-06
- BR-07
- BR-11

### Verification

- kind: text_test
- procedure: bun test test/session/stop-generation.test.ts test/session/prompt.test.ts test/session/background-task.test.ts test/cli/tui/session-control.test.ts test/cli/tui/prompt-working-start.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: Isolated runtime fixtures and controlled child processes only; fake clocks for late events/restart; T3/T4 integrated.
- expected: T5.A1-A3 include backend request counters and owned-process settlement, not merely a helper return value. Real Esc is separately gated in T10.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T5-evidence.md


### Stop Condition

If durable fencing requires a new DB migration or an unrelated runner interface beyond scope, revise contract first; no speculative UI-only workaround.

## T6 — Provide one-command verified beta and stable switching

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/cli/upgrade.ts
- src/mendcode/packages/opencode/test/installation/installation.test.ts
- src/mendcode/packages/opencode/src/cli/cmd/upgrade.ts
- src/mendcode/packages/opencode/src/installation/release-channel.ts
- src/mendcode/packages/opencode/src/installation/index.ts
- src/mendcode/packages/opencode/src/installation/release-index.ts
- src/mendcode/packages/opencode/src/installation/rollback.ts
- src/mendcode/packages/opencode/src/storage/compatibility.ts
- src/mendcode/packages/opencode/test/cli/upgrade-channel.test.ts
- src/mendcode/install.ps1

### Edit Files

- src/mendcode/packages/opencode/src/cli/upgrade.ts
- src/mendcode/packages/opencode/test/installation/installation.test.ts
- src/mendcode/packages/opencode/src/cli/cmd/upgrade.ts
- src/mendcode/packages/opencode/src/installation/release-channel.ts
- src/mendcode/packages/opencode/src/installation/index.ts
- src/mendcode/packages/opencode/src/installation/startup.ts
- src/mendcode/install.ps1
- src/mendcode/packages/opencode/test/cli/upgrade-channel.test.ts
- src/mendcode/packages/opencode/test/cli/upgrade.test.ts
- src/mendcode/packages/opencode/test/installation/release-channel.test.ts
- src/mendcode/packages/opencode/test/installation/rollback.test.ts

### New Files

None.

### Symbols

- UpgradeCommand
- readChannel/writeChannel
- Installation.latest/upgrade
- selectRelease
- assertCompatibility

### Interfaces

- 2026-09-07 scoped implementation amendment: Installation.latest accepts an optional explicit channel; Installation.upgrade reports installed/deferred and serializes activation plus preference commit with acquireChannelTransition. Refuse a mismatched-target deferred Windows channel switch before download until a verified installer transaction exists; this unsupported branch blocks full T6 acceptance, not the legacy channel subcommands. An already installed matching target may save selection after verification under the lock. Include automatic-update notification caller parity and installation-service tests.
- New optional --channel stable|beta|nightly on upgrade/update; omitted preserves stored selection. --channel plus explicit target or --rollback is rejected before writes; --channel with --check is read-only. Existing upgrade channel set remains preference-only.
- Resolve target using explicit channel without mutating global preference first. Commit preference after verified successful replacement; pending Windows handoff carries requested channel in existing update operation metadata and finalizes only after success. Concurrent update lock serializes transition.

### Inputs

- Installed channel/version, requested channel, signed release metadata, platform installer, existing DB journal compatibility and active backend state.

### Outputs

- Installed verified selected-channel executable or unchanged prior state with actionable error; truthful version/channel/restart output.

### Operation Order

1. Implement parser/help and validation for proposed flags, reusing existing target and channel selection functions without changing explicit-version behavior.
2. Resolve stable/beta from matching published non-draft tags; empty channel/release or unavailable network fails without fallback to another channel.
3. Verify assets/checksums/attestations/journal before replacement and respect active-backend maintenance gates. Never downgrade/restore DB to make stable start.
4. Persist preference on confirmed success only; if version already correct, validate selection and persist channel without a needless reinstall. For deferred Windows update retain old preference until installer commit; failed handoff does not claim success.
5. Test stable->beta->stable, read-only check, invalid combinations, no release, failed download/signature/compatibility, interrupted replacement and existing rollback. Old stable 0.1.44 has no new --channel option: verify return to beta using its existing mendcode upgrade channel set beta && mendcode upgrade. Do not require a stable/main release to make the beta deliverable usable.

### Error Semantics

- Nonzero CLI exit for failed/invalid transition; no misleading Done success. Schema incompatibility clearly blocks stable switch and offers existing safe options, not delete DB. Running sessions are not silently killed.

### Examples

- mendcode upgrade --channel stable changes a compatible beta installation to stable in one command; mendcode upgrade --channel beta --check prints candidate without writing preference or executable.

### Counterexamples

- Write beta preference before failed download; select stable Latest for an empty beta channel; bypass schema verification because stable version number looks lower.

### Non Goals

- No new updater implementation, SQL migration, automatic database backup restore or main promotion.

### Acceptance

- T6.A1: parser/transaction/compatibility matrix passes including deferred platform semantics; T6.A2: existing upgrade/update/channel/rollback commands keep backward compatibility.

### Required Capabilities

- code
- command

### Traces To

- BR-08
- BR-09

### Verification

- kind: text_test
- procedure: bun test test/cli/upgrade-channel.test.ts test/cli/upgrade.test.ts test/installation/release-channel.test.ts test/installation/rollback.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: Isolated HOME, DB and mock signed-release/installer fixtures; never upgrade the developer's live executable during automated tests.
- expected: T6.A1/A2 pass; final installed-platform proof remains T11.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T6-evidence.md


### Stop Condition

If a supported install method cannot verify replacement/compatibility or deferred preference commit, block that path with explicit error and revise before claiming channel switching support.

## T7 — Complete canonical MendCode launcher names with compatibility

### Work Kind

product_code

### Depends On

- T6

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/cli/public-bin.ts
- src/mendcode/packages/opencode/bin/opencode
- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/src/index.ts
- src/mendcode/packages/opencode/src/installation/release-channel.ts
- src/mendcode/packages/opencode/test/cli/public-bin-worktree.test.ts
- src/mendcode/packages/opencode/test/installation/launcher-package.test.ts
- .agents/plans/mendcode-opencode-rebrand.md

### Edit Files

- src/mendcode/packages/opencode/src/mend/cli/public-bin.ts
- src/mendcode/packages/opencode/bin/opencode
- src/mendcode/packages/opencode/bin/mendcode
- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/src/index.ts
- src/mendcode/packages/opencode/src/installation/release-channel.ts
- src/mendcode/packages/opencode/test/cli/public-bin-worktree.test.ts
- src/mendcode/packages/opencode/test/installation/launcher-package.test.ts
- src/mendcode/packages/opencode/test/installation/install-layout.test.ts
- src/mendcode/packages/opencode/test/mend/package-metadata.test.ts

### New Files

- src/mendcode/packages/opencode/bin/mendcode

### Symbols

- public-bin.ts primaryCommands/controlPlaneRoutes/usage
- package.json bin
- release-channel.configPath

### Interfaces

- Public executable name mendcode and optional internal mendcode-runtime remain stable; package bins target canonical bin/mendcode. bin/opencode remains only a thin compatibility entrypoint, not a user prerequisite. Canonical MENDCODE_TEST_HOME wins over legacy OPENCODE_TEST_HOME; preserve legacy reader fallback.

### Inputs

- Both source launcher and packaged executable routes; legacy config/environment and canonical current config; new upgrade channel flags from T6.

### Outputs

- MendCode-only supported help/launcher flows and behavior-preserving compatibility bridge tests.

### Operation Order

1. Audit actual command route coverage for --help/--version/run/session/setup/auth/providers/doctor/upgrade/update/uninstall; canonical entrypoint must route correctly rather than require a hidden opencode executable.
2. Move owned launcher implementation to canonical bin/mendcode with compatible wrapper at old path; update only observed caller metadata/tests. Do not rename packages/opencode or external imports in this beta.
3. Ensure public launcher passes T6 channel options to runtime and preserves args, exit codes, workdir/worktree and signals; update user-facing help/copy only where needed.
4. Add canonical test-home environment support with precedence and legacy fallback. Existing config/auth/history paths remain unchanged; no silent data copy/move.
5. Test fresh PATH containing mendcode only, source mode and installed launcher metadata; old bridge works without recursion and retained legacy references are explicitly classified.

### Error Semantics

- Missing runtime is an actionable MendCode error, never instruction to install/run opencode; invalid CLI options exit nonzero. Legacy bridges must not shadow canonical values.

### Examples

- PATH has only mendcode; --help, setup/auth/doctor and upgrade --channel stable are available. Old bin/opencode wrapper reaches same implementation if explicitly used by legacy tooling.

### Counterexamples

- Replace every opencode token including third-party package names, schema IDs, protocol headers or data paths; launch wrapper silently falls back to an unrelated installed opencode.

### Non Goals

- No internal runtime-folder rename, external dependency rename, license removal, forced legacy config/data migration or SDK wire break.

### Acceptance

- T7.A1: source and packaged public command parity with MendCode-only PATH and no legacy executable dependency; T7.A2: legacy/canonical precedence and wrapper compatibility preserve inputs/signals/exit codes.

### Required Capabilities

- code
- command

### Traces To

- BR-09
- BR-08

### Verification

- kind: text_test
- procedure: bun test test/cli/public-bin-worktree.test.ts test/installation/launcher-package.test.ts test/installation/install-layout.test.ts test/mend/package-metadata.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: Owned isolated launcher fixtures; T6 integrated; actual source/package entrypoints exercised with restricted PATH and temp HOME.
- expected: T7.A1/A2 pass with no required opencode binary; compatibility exceptions enumerated.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T7-evidence.md


### Stop Condition

If rename crosses package/import/lockfile/schema boundaries, stop broad rename and revise scoped ownership; do not mutate third-party IDs to satisfy a text count.

## T8 — Publish truthful MendCode-only usage and compatibility guidance

### Work Kind

artifact

### Depends On

- T7
- T9

### Parallel Group

None.

### Read First

- README.md
- src/mendcode/CONTRIBUTING.md
- src/mendcode/packages/opencode/src/mend/cli/public-bin.ts
- src/mendcode/packages/opencode/src/cli/cmd/upgrade.ts
- src/mendcode/packages/opencode/src/tool/computer.ts
- .agents/plans/mendcode-opencode-rebrand.md

### Edit Files

- README.md
- src/mendcode/CONTRIBUTING.md

### New Files

None.

### Symbols

- Public install/launch/setup/auth/doctor/upgrade examples and upstream attribution

### Interfaces

- Documentation describes verified CLI names exactly; internal source paths and upstream attribution may retain opencode when classified, never as a required executable command.

### Inputs

- T7 command inventory and T9 actual computer capabilities; T6 one-command channel semantics and compatibility failures.

### Outputs

- Runnable MendCode-only user journeys, beta/stable command examples and honest computer capability/limitation section.

### Operation Order

1. Audit in-scope public docs for required executable opencode, stale mend aliases, inaccurate channel update steps and full computer-control claims.
2. Use exact canonical commands from tested CLI; document beta->stable with the new option and old-stable->beta using mendcode upgrade channel set beta && mendcode upgrade until stable gains --channel. State which installed version supports each syntax, --check read-only, restart requirement, compatibility failure and verified rollback without data loss.
3. Explain native computer_capture/computer_key, macOS Screen Recording/Accessibility manual permissions, no pointer/arbitrary typing/other-OS native support, and optional configured MCP as distinct, not built-in parity.
4. Keep license/attribution, external IDs and internal source paths; list remaining categories with reasons in task evidence. Broader public-doc occurrences found outside scope become exact scope amendment, not ignored completion.

### Error Semantics

- Do not document an unimplemented flag or call a capability verified only from source runtime-proven. Mark optional/unsupported platforms explicitly.

### Examples

- mendcode upgrade --channel stable and mendcode upgrade --channel beta are public examples; packages/opencode appears only as an internal source path, not an executable requirement.

### Counterexamples

- Removing MIT attribution to reach zero opencode strings, or claiming desktop clicks/type support when only navigation keys exist.

### Non Goals

- No website redesign, generated vendor docs edits or whole-monorepo path rename.

### Acceptance

- T8.A1: public documented journeys require only mendcode and match T7/T9 evidence; retained legacy references are justified and migration warnings accurate.

### Required Capabilities

- code-read
- artifact

### Traces To

- BR-08
- BR-09
- BR-10

### Verification

- kind: inspection
- procedure: Compare every changed executable example in README.md and CONTRIBUTING.md to T6/T7 observed command help/results; scan remaining opencode occurrences and classify each as compatibility, attribution, external identifier or internal path.
- cwd: .
- preconditions: T7/T9 evidence current; no dead or speculative command example accepted.
- expected: T8.A1 passes with precise exceptions, no unclassified required legacy executable.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T8-evidence.md


### Stop Condition

A public surface outside named scope still requires the legacy executable or contradicts actual capability; amend exact scope and tests before claiming completion.

## T9 — Certify built-in computer discovery and constrained native behavior

### Work Kind

text_test

### Depends On

- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/tool/computer.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/test/tool/registry.test.ts
- src/mendcode/packages/opencode/test/session/tool-discovery.test.ts
- src/mendcode/packages/opencode/test/tool/parameters.test.ts

### Edit Files

- src/mendcode/packages/opencode/test/tool/computer.test.ts
- src/mendcode/packages/opencode/test/session/tool-discovery.test.ts

### New Files

- src/mendcode/packages/opencode/test/tool/computer.test.ts

### Symbols

- ComputerCaptureTool
- ComputerKeyTool
- nativeComputerCommand
- ToolRegistry
- withToolDiscovery

### Interfaces

- computer_capture({region?,windowID?}) returns bounded PNG attachment/path and captureID/keyboardControlAvailable; computer_key({captureID,key}) supports tab|escape|enter|space|left|right|down|up only. captureID is session-bound, one-use, 30-second TTL, requires unchanged foreground app. Discovery is not permission.

### Inputs

- Actual registry/permission-filtered discovery, supported macOS and unsupported platform fixtures, stale/foreign capture tokens, OS permission denial and abort.

### Outputs

- Capability matrix: built-in vs optional MCP, supported OS/actions, inspected source vs controlled runtime proof, exact Codex comparison limitations.

### Operation Order

1. Verify registered capture/key tools can be found with computer/desktop/screenshot/navigation queries and survive the T2 follow-up path without missing arguments.
2. Add tests at actual tool implementation boundary for unsupported OS, invalid crop/window, permission denial, capture TTL/session/foreground/one-use validation and aborted owned child; never execute desktop control on the maintainer's real app in automated tests.
3. Inspect current official Codex CLI/Desktop primary source documentation separately if making a comparison; a model/provider name or empty search is not proof of native desktop parity. Record dated URLs/SHA and distinguish Desktop app, CLI native tools, MCP and API computer-use model.
4. Require controlled macOS manual proof in T10: on a single-display setup foreground a harmless dedicated test app, call computer_capture with no region/windowID, verify keyboardControlAvailable=true and use its token for one allowed key before 30 seconds. Window/crop/multi-display captures do not currently enable keyboard tokens; do not promise they do or alter OS display setup automatically. Pointer/text remains a documented gap, not simulated via arbitrary agent-written shell scripts.
5. If a built-in existing capability fails, record exact defect and revise a bounded production repair task before acceptance; do not invent full mouse/text/cross-platform support.

### Error Semantics

- OS permission denial/unsupported OS is actionable unsupported/permission state, not generic success. Do not grant Accessibility/Screen Recording programmatically or capture sensitive windows.

### Examples

- macOS discovery exposes computer_capture and computer_key; capture token followed by tab in same controlled app works once; Windows says native unsupported and may separately list configured MCP.

### Counterexamples

- Presence of computer.ts alone proves full computer use; using preview pixels as native click coordinates; typing arbitrary code through terminal to claim built-in parity.

### Non Goals

- No pointer/text automation feature, new OS helper/dependency or browser/desktop parity marketing without separate design.

### Acceptance

- T9.A1: actual discovery/serializer and tool boundary tests pass with truthful matrix; T9.A2: no unsupported capability claim, missing native runtime proof explicitly delegated to T10.

### Required Capabilities

- code
- command
- github-read

### Traces To

- BR-02
- BR-10
- BR-04

### Verification

- kind: text_test
- procedure: bun test test/tool/computer.test.ts test/tool/registry.test.ts test/session/tool-discovery.test.ts --timeout 30000
- cwd: src/mendcode/packages/opencode
- preconditions: Use actual tool boundary and fake OS process/permission adapters or rejecting inputs; do not issue real navigation during automated suite.
- expected: T9.A1/A2 prove discoverability/limits/rejection; physical desktop outcome remains unclaimed until manual evidence.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T9-evidence.md


### Stop Condition

Any promised built-in fails or needs a new native backend; revise scoped repair/design and block that claim, not bypass safety with arbitrary scripts.

## T13 — Explain compaction latency against released Codex and reconcile fast-path work

### Work Kind

decision

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/compaction.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/agent/agent.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/test/session/compaction.test.ts
- docs/tasks/mendcode-beta4-fast-context-orchestration.md

### Edit Files

None.

### New Files

None.

### Symbols

- SessionCompaction.process/processCompaction
- buildPrompt/SUMMARY_TEMPLATE
- writeTranscript
- SessionProcessor.process
- Codex run_remote_compact_attempt/compact_conversation_history

### Interfaces

- Compare installed release, source SHA, provider/auth/model/reasoning, corpus and timing boundaries. Report phases: history read/selection, transcript/context preparation, provider request-to-first-response and completion, checkpoint installation, resume dispatch. Missing provider timings are unknown, not zero.
- User reports MendCode >30 seconds and Codex about 5 seconds; this is supplied observation, not a matched benchmark. Existing fast-context plan R2/R3/R4 remains canonical for native/incremental implementation; this task owns evidence and coordination, not a duplicate compactor.

### Inputs

- Pinned published MendCode v0.1.44-beta.3 source 995a6a67, current Codex release rust-v0.153.4, supplied latency observation, available sanitized timing logs and concurrent fast-context work.

### Outputs

- Source-grounded causal candidates, reproducible bounded comparison protocol and explicit disposition: already implemented elsewhere and needs evidence, a scoped fast-context implementation dependency, or unproven provider latency.

### Operation Order

1. Read immutable Git source, not another agent's dirty beta worktree. At authoring the foreign beta4 worktree already has uncommitted native/incremental compaction changes and message-v2 optional fields; these are NOT shipped beta.3 evidence.
2. Published beta.3 selects configured compaction role or active model, writes transcript, assembles extensive context and Markdown SUMMARY_TEMPLATE and calls ordinary SessionProcessor.process with tools={}; no native adapter is present there. Verify role/reasoning and actual output/phase sizes before blaming any one phase.
3. Inspect pinned official Codex rust-v0.153.4 compact_remote.rs, compact_remote_request.rs and compact.rs: remote path calls compact_conversation_history and installs returned compacted history, while portable path streams a summary. Do not infer which path produced the user's 5 seconds without route evidence; preserve distinct API/OAuth and provider capabilities.
4. Define one sanitized representative 50k-token-equivalent text/tool corpus and one 150k-token-equivalent corpus with exact byte/hash and token-estimator provenance, latest intent/corrections/pending tools/cancellation anchors; each must fit compared model context. Measure both products on same machine/network/auth/model/effort where supported, separate unsupported configurations and cold/warm prefix cache; 3 matched runs per corpus per route after budget approval, report all values and median/range, not a p95 from tiny samples.
5. Use existing logs/telemetry first; if phase timers are absent, author a scoped instrumentation amendment before tests rather than guessing. Define clocks from compaction trigger through accepted checkpoint and resume dispatch, not spinner disappearance. Record input/output/cached tokens and retries, separate inferred estimates from provider metrics. Live benchmark budget/credentials are not inferred; missing live runs are NOT_RUN.
6. Record approximately 5 seconds as aspiration and <=10-second median on a declared supported matched corpus as proposed fast-path evaluation target inherited from the existing plan, not a universal timeout. Fidelity/cancellation/provider-binding checks must pass even when target is missed. A faster result that loses unfinished work is invalid.
7. The user explicitly authorized both complete packets in the next beta on 2026-09-07. The same session lead owns integration with .agents/plans/mendcode-beta4-fast-context-orchestration.execution.json: its R2/R3/R4 compaction implementation/evidence is required for speed claims, and its separately specified cascade/critic/configuration assistance is included with all of its own acceptance gates. Keep the two criterion ledgers distinct and require their union before release. No automatic default/model/protocol change or paid benchmark authorization follows from scope integration.

### Error Semantics

- Unavailable matching Codex route, logs or live budget leaves quantitative comparison NOT_RUN, with source findings still usable. Do not copy undocumented protocol flags, opaque checkpoint internals or claim server-side speed from source alone.

### Examples

- Published beta spends time generating a structured summary while a proven Codex remote route receives compact items; source establishes different mechanisms, phase timings must establish where 30s went.

### Counterexamples

- Read foreign dirty compaction.ts and claim latest beta already uses native compaction; lower timeout to 5s and call it faster; compare different models/corpora/cache states without disclosure.

### Non Goals

- No runtime benchmark during authoring, no new implementation in this diagnostic task, no duplicate native compaction design or blanket 5-second guarantee.

### Acceptance

- T13.A1: pinned released-source comparison and phase-measurement protocol grounded in actual contracts; all latency claims labelled observed/reported/unknown.
- T13.A2: existing fast-context R2/R3/R4 ownership/integration disposition recorded; no speed-fix release claim without matching benchmark and fidelity evidence.

### Required Capabilities

- code-read
- github-read
- command

### Traces To

- BR-13
- BR-01
- BR-06
- BR-07

### Verification

- kind: inspection
- procedure: Compare immutable beta.3 compaction/agent/processor path with GitHub Codex rust-v0.153.4 compact_remote.rs, compact_remote_request.rs and compact.rs; inspect existing timing evidence and fast-context plan R2/R3/R4. Record full comparison protocol and ownership disposition; do not execute live benchmark without separately verified budget/route.
- cwd: .
- preconditions: T0 current baseline/foreign worktree ownership known; use published source not in-progress native changes.
- expected: T13.A1/A2 distinguish source mechanism from performance proof and link any requested implementation to existing canonical plan.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T13-evidence.md


### Stop Condition

Unresolved compaction ownership or any intended speed-fix release claim lacking live fidelity/timing proof blocks that claim and its integration; no speculative changes.

## T10 — Accept integrated behavior with user-run terminal and desktop checks

### Work Kind

visual_test

### Depends On

- T5
- T8
- T9
- T13

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/script/queue-compaction-smoke.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/theme/mendcode.json
- src/mendcode/packages/opencode/src/tool/computer.ts

### Edit Files

None.

### New Files

None.

### Symbols

- J1-J4 in design_contract
- test:queue-compaction:manual
- public MendCode candidate

### Interfaces

- Human operator Obed executes TUI smoke in real terminal; agent provides exact command and records result but cannot automate key input, PTY/tmux/expect/script or computer-inject this gate. Capture manual screenshots at 80x24 and 120x40, not browser screenshots of unrelated UI.

### Inputs

- Integrated candidate and current T2-T9 evidence, user-selected theme/draft and isolated mock provider plus controlled harmless desktop window.

### Outputs

- Current integrated typecheck, manual TUI/user confirmation, capability-specific evidence and explicit remaining blockers.

### Operation Order

1. Run package bun typecheck once on integrated code; reuse current focused evidence unless changed inputs invalidate it. No full-suite rerun solely for closure.
2. Give Obed exact command bun run test:queue-compaction:manual in src/mendcode/packages/opencode. User runs existing single-instance isolated no-token harness; await explicit result. If harness lacks needed fault/race controls, use existing controlled fixtures from T4/T5 with a user-run terminal and amend harness scope before claiming coverage.
3. At 80x24 and 120x40 verify J1 safe Git chain no prompt; dangerous control still asks/denies, no clipped permission actions, preserved draft/focus/scroll. Verify J2 truthful offline/provider/stall and single recovery; J3 double Esc during generation, retry and permission wait, then delayed child/reconnect, no spontaneous iteration and explicit next prompt works.
4. User manually toggles Wi-Fi only when willing and no unrelated critical work is affected; otherwise real physical-network check remains blocked, mock evidence still reported separately. No agent-operated network changes.
5. User grants OS Screen Recording/Accessibility if desired and runs capture plus navigation in a harmless dedicated app, with stale token/foreground change rejection; do not use computer tools to automate the MendCode manual smoke.
6. Perform minimal non-sensitive live provider follow-up for the actual reported route and record auth mode/model/transport without secrets; unavailable credentials block live incident confirmation. Unit/mock/live/native/visual evidence remain distinct.

### Error Semantics

- Missing user confirmation or renderer/native/live capability is BLOCKED, not a pass. Fix observed regressions in the owning task and rerun only invalidated checks.

### Examples

- User confirms both layouts, double Esc prevents all post-ack calls, safe Git runs quietly and controlled capture/navigation works; recorded source SHA ties result to candidate.

### Counterexamples

- Agent runs expect to simulate the manual gate; typecheck pass substituted for real Esc; a screenshot of idle spinner accepted without backend counters.

### Non Goals

- No redesign polish, full benchmark matrix or autonomous physical Wi-Fi/desktop changes.

### Acceptance

- T10.A1: integrated typecheck and J1-J4 evidence current; T10.A2: Obed explicitly confirms real-terminal stop/recovery/approval behavior before beta release; T10.A3: live incident and native capability claims each have matching evidence or publication remains blocked.

### Required Capabilities

- command
- renderer
- vision
- human-terminal
- native-desktop
- provider-call

### Traces To

- BR-02
- BR-03
- BR-04
- BR-05
- BR-06
- BR-07
- BR-08
- BR-09
- BR-10
- BR-11
- BR-12

### Verification

- kind: visual_test
- procedure: Lead runs bun typecheck from package; Obed runs bun run test:queue-compaction:manual from that same directory and executes J1-J4 at 80x24/120x40 with preserved draft. Record screenshots, backend call counts and user confirmation, plus separately controlled macOS capture/navigation and live provider follow-up.
- cwd: src/mendcode/packages/opencode
- preconditions: T2-T9 integrated on isolated candidate; user physically operates manual gate and desktop/network controls; no secrets visible; absent capabilities remain BLOCKED.
- expected: T10.A1-A3 pass with truthful visible state, no post-stop iteration/duplicate effects, bounded recovery and actual computer limits.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T10-evidence.md


### Stop Condition

Do not version/dispatch/publish before explicit user smoke confirmation and all required claims have evidence.

## T11 — Ship a unique verified GitHub beta from dev

### Work Kind

artifact

### Depends On

- T10

### Parallel Group

None.

### Read First

- CHANGELOG.md
- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/extensions/zed/extension.toml
- .github/workflows/prerelease.yml
- .github/workflows/release.yml
- .github/workflows/security.yml
- .github/workflows/codeql.yml
- .github/workflows/windows-installer.yml
- src/mendcode/script/release
- src/mendcode/install
- src/mendcode/install.ps1

### Edit Files

- CHANGELOG.md

### New Files

None.

### Symbols

- Prerelease candidate workflow inputs channel/beta_number/dry_run
- Release workflow immutable source_sha/version
- SHA256SUMS and release index

### Interfaces

- Candidate from reviewed dev SHA, version <stable package base>-beta.<positive unused N>; existing package version remains stable semver. GitHub release is prerelease=true, latest=false, never overwrites tag. User authorized GitHub beta and scoped commits/push, not main promotion.

### Inputs

- Accepted source/evidence and user smoke confirmation, current remote/tag/release state, release security/artifact workflow results.

### Outputs

- Scoped commit(s) integrated into dev, immutable beta tag/GitHub URL, verified install artifacts and MendCode-only channel round-trip receipts.

### Operation Order

1. Recheck active release agents, current dev/package/changelog/tags and open PRs; select next unused beta sequence. If another agent has bumped base/version, coordinate and revise candidate, do not race beta.4.
2. Write accurate changelog with fixed incident/approval/recovery/stop/CLI behavior and computer limitations. Do not inject beta suffix into package version because prerelease workflow requires stable semver; metadata base bump, if newly needed, is a scoped contract amendment.
3. Review/stage only owned task changes; create scoped commits using repo style, push/integrate into dev through repository protections without force or unrelated local commits. Do not dispatch until remote dev equals reviewed candidate. If dev changes during candidate selection, compare selected SHA and block an unreviewed release.
4. Use existing prerelease.yml on dev with channel=beta, unique beta_number and reviewed dry_run policy to build a draft; inspect exact selected SHA/version and all required supply-chain/security/CodeQL/installer gates. Do not alter workflows just to bypass failure.
5. Before publication verify draft checksums/attestations/index, download the exact draft artifact with authenticated GitHub tooling and install it into a temporary isolated HOME through the existing verified local-artifact path. Exercise mendcode --version/help/doctor and T6 channel-selection/compatibility fixtures; public channel selection deliberately cannot discover drafts. Native macOS/Linux/Windows installation gates required by the existing release workflow remain required, not inferred from host-only testing. Real global DB/executable remains untouched; cleanup must be owned and bounded.
6. Publish the verified draft as GitHub prerelease only after prepublication gates; keep stable Latest/main unchanged. Then verify actual public beta->stable->beta round-trip in temporary HOME using the new option on beta and the existing preference-set plus upgrade syntax on old stable. A postpublication failure leaves acceptance FAIL and requires reported release remediation, not a hidden tag move. Record URL, tag, SHA, platform outcomes and limitations; inspect external state before retrying interrupted publish commands.

### Error Semantics

- Any failed required security/installer/artifact gate or missing manual evidence blocks publish. Unique tag collision selects a new unused sequence only after state inspection, never moves a tag. Native platform gap is reported, not called tested.

### Examples

- If 0.1.44 remains base and beta.4 unoccupied, reviewed dev produces v0.1.44-beta.4; if occupied, coordinate next N. Stable v0.1.44 remains Latest.

### Counterexamples

- Run release from main, push shared dirty files, force dev, publish generic SHA-only notes, skip failing checksum or claim beta label means verified stability.

### Non Goals

- No stable release, main merge, package ecosystem publication or deletion of unrelated worktrees/artifacts.

### Acceptance

- T11.A1: GitHub beta points to reviewed dev SHA and unique version, stable Latest unchanged; T11.A2: required CI/security/checksum/install/channel results current and exact URL/version reported.

### Required Capabilities

- command
- github-write
- platform-install

### Traces To

- BR-01
- BR-08
- BR-09
- BR-12

### Verification

- kind: release
- procedure: Inspect current gh workflow/view/run and release data; dispatch existing prerelease.yml only after T10, record selected SHA and checks. Verify checksums/attestations and native temporary-HOME candidate install using src/mendcode/script/release workflow; execute installed mendcode --version, --help, doctor and channel round-trip. Verify gh release view reports prerelease and expected tag/URL with stable Latest unchanged.
- cwd: .
- preconditions: Explicit execution request plus retained GitHub beta authorization, user manual smoke passed, remote dev reviewed, collision-free version and supported platform evidence available.
- expected: T11.A1/A2; no main/stable mutation or unknown result claimed as success.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T11-evidence.md


### Stop Condition

Stop publication on unreviewed SHA, collision, protected-branch blocker, CI/security failure or missing platform/user confirmation; do not bypass gates.

## T12 — Close evidence and deliver the beta handoff

### Work Kind

acceptance

### Depends On

- T0
- T1
- T2
- T3
- T4
- T5
- T6
- T7
- T8
- T9
- T10
- T11
- T13

### Parallel Group

None.

### Read First

- CHANGELOG.md
- README.md
- src/mendcode/packages/opencode/package.json
- .github/workflows/prerelease.yml

### Edit Files

None.

### New Files

None.

### Symbols

- BR-01 through BR-13 and all task acceptance criteria including T13 compaction investigation

### Interfaces

- Lead-owned evidence.json and execution_state.json record actual result, accepted source/digests, command/cwd/exit status and limitations. Immutable tasks.json execution object remains unselected planning contract.

### Inputs

- Current integrated diff, all task receipts, manual confirmation, GitHub release and artifact identities.

### Outputs

- Complete criterion ledger and concise Spanish handoff with release URL/version, stable-switch command and computer limitations.

### Operation Order

1. Inspect owned diff and ensure shared work, main, secrets and real databases were not changed; confirm every requirement/property/risk maps to current evidence.
2. Reuse unchanged successful evidence; rerun only a check invalidated by candidate changes or insufficient assertions. Never accept stale source/test-only evidence as installed release proof.
3. Record PASS/FAIL/BLOCKED/NOT_RUN per criterion; overall acceptance requires all required criteria current and passing.
4. Deliver actual release URL and version, mendcode upgrade --channel beta and --channel stable commands, fixes tested, unsupported computer functions and any residual platform limitations. Do not say guaranteed bug-free.

### Error Semantics

- Missing or failed required evidence prevents overall PASS, even if a draft/tag exists. Unknown remote outcome requires inspection, not a second release.

### Examples

- Release URL/version plus exact checks and computer capture/key-only limitation yields an honest handoff.

### Counterexamples

- A worker says done, a validator passes, or a release artifact exists therefore all runtime behavior works.

### Non Goals

- No new feature work or unrequested stable promotion during closure.

### Acceptance

- T12.A1: all BR requirements and mapped risks/properties have current accepted evidence; release claims match actual GitHub/platform/manual results.

### Required Capabilities

- code-read
- command
- github-read
- vision

### Traces To

- BR-01
- BR-02
- BR-03
- BR-04
- BR-05
- BR-06
- BR-07
- BR-08
- BR-09
- BR-10
- BR-11
- BR-12
- BR-13

### Verification

- kind: acceptance
- procedure: Compare current candidate/release hashes, scoped diff, traceability and all criterion receipts; inspect user confirmation and GitHub final state. Reuse matching evidence and report any unrun/failed criterion explicitly.
- cwd: .
- preconditions: All dependency tasks integrated, no relevant source/environment change without revalidation.
- expected: T12.A1 and no unsupported full desktop or universal safety/readiness claim.
- evidence: .agents/specs/mendcode-beta-reliability-readiness/T12-evidence.md


### Stop Condition

Any required criterion lacks current evidence or publication differs from accepted SHA; record BLOCKED and return to owning task.

# Task packet: mendcode-beta4-fast-context-orchestration

Source SHA-256: e2e8c98af6e4583a7990d583eceb6192763563e944f8fa950fe3875443a960c7

## Goal

Deliver an opt-in beta successor to v0.1.44-beta.3 with fast provider-aware compaction, user-configured single/cascade/critic model workflows, and a Full Prompt Mode assistant that can inspect, explain, validate and safely apply configuration for the user's actual providers. Under the explicit 2026-09-07 user scope confirmation, deliver this complete packet together with .agents/specs/mendcode-beta-reliability-readiness/tasks.json in the next beta on dev. One session lead serializes shared provider/prompt/runtime/configuration edits and requires the union of both packets' acceptance evidence before release. Preserve main, unrelated work, manual/platform/security gates and separate approval for paid live benchmarks; the beta number is not reserved.

## Context

USER CONTRACT (2026-09-07): The user explicitly replaced the earlier conservative context/accounting proposal with fast compaction comparable to their observed sub-10-second Codex CLI experience, optional compound execution across their own providers/models configured in JSON, and Full Prompt Mode assistance that recommends and configures cost/capability tradeoffs. Author a plan for another model; do not implement, choose that executor, spawn agents, change provider/model/reasoning, commit, or publish now. The older mendcode-next-beta-context-evidence packet is superseded, not a prerequisite.

VERIFIED BASELINE: GitHub latest prerelease remains v0.1.44-beta.3 at 995a6a67117adc7894924285fc8c051e3bd72001; stable is v0.1.44. Remote dev equals beta.3 at the earlier same-session ls-remote; recheck before execution. Authoring HEAD b5646990 on dev is ahead 4/behind 11 against its tracking ref and has uncommitted prompt/TUI changes. The canonical published source was read with git show 995a6a67:path, not assumed equal to the working checkout. Dirty overlaps include src/session/prompt.ts, src/mend/prompt/compose.ts and src/cli/cmd/tui/routes/session/index.tsx, plus command panel/keybind/dock work. Do not overwrite, reset, stash, auto-merge or copy the beta tree over this checkout. No open PR was returned by gh pr list. Linear workspace ObeDev was verified; exact/fragment project searches and the complete ObeDev-team listing including archived projects found no MendCode mapping. Global listing was partial, so absence elsewhere is not established. Reuse this discovery, and resolve a tracking mapping before external writes; local planning is grounded in Git.

EXISTING CONTRACTS: Beta.1 already has release channels, opt-in async read jobs/questions and versioned notes; beta.2 has bounded startup preparation; beta.3 has backend Smart Approval, ContextCommand, frozen per-turn memory, bounded tool discovery, opt-in Code Mode and limited macOS computer tools. Native compaction is not enabled. SessionCompaction in src/session/compaction.ts selects agent.model or current user model, builds a long summary, preserves two recent turns by default, calls SessionProcessor, and exports transcript references. MessageV2.CompactionPart and legacy summary=true markers control history truncation/filterCompacted. LLM.Service sends LanguageModelV3 requests through ProviderTransform; provider.ts fetch middleware strips input item IDs for store=false. CodexAuthPlugin.auth.loader refreshes credentials and rewrites Responses requests to a Codex endpoint; it currently does not preserve a /compact operation suffix. These are active integration boundaries, not safe extension points by assumption.

CONFIG: Config.Info is the validated schema for merged mendcode.json/jsonc; Config.update writes config.json and updateGlobal uses patchJsonc for JSONC. Existing readModelsConfig reads models.yaml roles and package projections, with existing precedence and generated model config. ModelRole has providerID/modelID/authMode/variant. The legacy review role is explicitly stripped: do not reuse it for the new critic. Full Prompt Mode is composed in src/mend/prompt/compose.ts. Existing ai CLI supports status and env status only. New names below are proposed interfaces, not currently callable commands.

WORKFLOWS: WorkflowTaskExecutor.execute takes task/sessionID/context/workflowModel/permissions/workspace, calls SessionPrompt, and maps terminal/schema state; its usageOutput is not a complete request ledger. WorkflowService persists plan revisions, attempts and artifacts in JSON columns of session.sql.ts. WorkflowRunner owns leases, child attempts, cancellation and cleanup; completed per-run worktrees currently get cleaned. Completion validation has an executable-command allowlist but test scripts are not inherently side-effect-free. WorkflowPolicy report-only is a permission policy, not an OS sandbox. Reuse these services and introduce a bounded compound-task executor; do not fork a second agent framework. Compound workflows are explicit tool/workflow invocations; ordinary chat keeps its selected model.

TOOLING: Read package AGENTS.md and test/AGENTS.md at execution baseline. Use installed package Bun test/typecheck scripts, only from src/mendcode/packages/opencode. Every test that can touch SQLite must set MENDCODE_DB to a fresh verified temporary root and load the package preload; production-like paths and symlink aliases must be rejected. Do not install dependencies to proceed with an incompatible package manager. Existing SDK/OpenAPI generation must be inspected before running: package script/generate.ts refreshes models.dev and is not a scoped schema generator. No dependencies or SQL migration are planned.

PRIMARY REFERENCES: Official OpenAI compaction guide https://developers.openai.com/api/docs/guides/compaction documents standalone POST /responses/compact returning the canonical compacted window, including opaque encrypted items, and server-side context_management. For standalone output, preserve the returned window as-is. First adapter in this beta uses standalone control; inline/server-driven compaction and undocumented Responses Lite/v2 protocols are out of scope. Pinned Codex reference https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/core/src/compact_remote.rs and compact_remote_request.rs were read: separate request and installed-history boundaries, hooks/cancellation, native compact result. This does NOT establish a universal sub-10-second latency guarantee. GitHub HydraFusion https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/ motivates bounded single/cascade/critic strategies; no vendor benchmark saving is a MendCode measurement.

## Decisions

CONFIGURATION CONTRACT — proposed additive fields in the existing mendcode.json/jsonc, not a new competing ai.json or a YAML migration:
compaction.strategy?: "portable"|"auto"|"native" (absent=existing portable behavior); compaction.portable_mode?: "legacy"|"incremental" (absent=legacy); compaction.timeout_ms?: integer 1000..300000 (default 60000); compaction.max_summary_tokens?: integer 512..8192 (default 4096 for incremental); compaction.on_native_error?: "stop"|"portable" (default stop). Existing auto/prune/threshold/token_limit/tail_turns/reserved keys remain unchanged. auto chooses native only for a positively supported exact transport/model/auth combination; unsupported routes use portable. Explicit native plus unsupported fails before inference. A configured different compaction-role model is manual intent: auto uses that portable role rather than silently ignoring it; validate explains that native compaction is bound to the active inference model. strategy native with conflicting role is a preflight error.
ai?: {version:1, orchestration:{enabled:boolean,profiles:Record<string,CompoundProfile>}}. Omitted or enabled=false preserves normal single-model behavior; no default profile auto-intercepts ordinary chat. Profile names match [a-z][a-z0-9_-]{0,47}; max 16 profiles. CompoundProfile={strategy:"single"|"cascade"|"critic",primary:ModelRef,escalation?:ModelRef,critic?:ModelRef,limits:Limits}. ModelRef is exactly {role:string} OR {providerID:string,modelID:string,variant?:string}; reuse actual Provider IDs, model IDs and advertised variants. References resolve once at run creation through existing role/Provider services. Auth is the provider's already configured credential mode; profiles do not store secrets or switch authentication. Mixed API/OAuth on one provider alias is unsupported unless existing runtime exposes independently configured provider IDs. cascade requires escalation; critic requires critic; reject irrelevant role fields. The critic must differ in provider/model/variant tuple from the primary; same-family reviewers are allowed but are not advertised as cross-family evidence.
Limits={maxModelRequests:integer 1..32,maxTotalTokens:positive integer,maxRuntimeMs:integer 1000..3600000,maxCostUsd?:finite number>0,unknownCost:"block"|"allow-with-token-cap"}. Limits required for enabled profiles; strategy structural minimum requests is single=1,cascade=2,critic=3 and includes compaction/retries in actual accounting. Solver, critic, revision, fallback and compaction all consume the same run budget; maxChildren=0 for solver-created tasks, maxConcurrency=1. No recursive compound profiles or hidden paid verifier models. Generation token/step caps must be admitted before each request and enforced at runtime; dollar limits are a conservative estimated-cost admission guard, never an exact invoice guarantee. If a dollar limit is supplied and the route cannot be priced conservatively, unknownCost=block stops it; allow-with-token-cap explicitly acknowledges unknown dollar coverage. Subscription quota is not dollar billing. Absence of price/usage is null, never free.
Use existing global/project configuration discovery. For these new profile objects, higher-precedence profile entries replace the whole named profile, and ModelRef is atomic: never merge providerID from one source with modelID from another. Global enabled=false can be explicitly overridden in a trusted project, but repository configuration alone is not user authorization to launch extra calls. The full resolved config/roles/limits hash and exact source files are snapshotted per run; edits apply only to subsequent runs. Invalid config is visible and does not silently become a different profile.

NATIVE COMPACTION CONTRACT: Introduce capability objects keyed by providerID, API origin, credential identity fingerprint (no secret), modelID and protocol. Only the official OpenAI API Responses route and the existing Codex OAuth adapter are first-beta adapter candidates; custom OpenAI-compatible endpoints, Azure and other providers remain portable until an explicit tested adapter exists. Each adapter must prove exact request/auth and round-trip inference with opaque output; an API adapter passing does not enable OAuth. No network probes at startup or during recommendations. Native output is a versioned private checkpoint with boundary message/part IDs, generation, protocol, binding, instruction/tools fingerprints, canonical output items and byte size. Cap a checkpoint at 4 MiB; oversize/corrupt/unrepresentable returns a typed failure without loss.
Do NOT encode native completion as legacy summary=true with placeholder text: older runtimes would truncate history to a useless summary. Persist native checkpoints separately in existing continuity note records with data.namespace=native_compaction_v1; never touch session_notes head IDs. Native-aware input selection uses the checkpoint plus only later canonical items; original transcript remains available. Old runtimes see the original untruncated history and can perform ordinary compaction. New SDK/API/TUI responses expose only redacted diagnostics, never encrypted payload. Do not leak checkpoint contents through exports, share or ordinary context reports. Native support depends on existing continuity storage being available; unsupported storage fails capability detection rather than migrating silently.
Snapshot only at a settled step/tool boundary under the owning session generation. Native call cancellation, a new user turn, stale generation, branch/revert, or mismatched provider/auth/model/instructions/tools invalidates installation. Install atomically after validation; failure preserves the last usable context. While assembling the next raw Responses body, preserve native output item content/order/IDs byte-semantically and append only serialized post-boundary deltas. Existing item-ID removal, OAuth normalization, SDK transformations and retry request reconstruction must not rewrite canonical compact items. Request-local state must be isolated across concurrent sessions; no process-global current checkpoint. If bindings change, rebuild portable context from retained transcript/working state BEFORE using the other provider; never send encrypted OpenAI context to an unrelated provider. Auth changes do not authorize fallback to API billing. One native request per compaction; no automatic retry on auth/cancel. on_native_error=portable permits at most one fallback, consumes budget, and is never used after cancellation or permission rejection.

PORTABLE FAST PATH: Incremental mode reuses the last accepted portable summary plus previously uncovered complete turns, frozen user constraints, current TODO/tool/child state and a bounded recent tail. Keep latest request/corrections/unfinished work/tool outcomes and language; source references permit recovery of old detail. Preserve legacy mode as rollback. No periodic background summarizer in this beta; compaction runs at existing safe checkpoints. Bound summary output and choose only explicit compaction-role model/variant or the existing active-model fallback. Do not force low effort or silently pick another provider. If the configured model cannot represent the required input, stop with actionable model/budget mismatch; never discard uncovered history to manufacture a fast result. Record preparation/provider/installation/resume timing and input/output bytes/tokens with provenance. Native and portable speed depend on provider and corpus; 10 seconds is a measured target, not a timeout or unconditional promise.

COMPOUND WORKFLOW CONTRACT: Add WorkflowTask.compound?: {profile:string,validationChecks:Array<{id:string,command:string,timeoutMs?:positive integer}>}. At save/start validate and materialize resolved settings in immutable WorkflowRevision plan plus WorkflowTaskTable.data.compound; preserve original profile name for display. compound allowed only for kind agent with textual output, at least one prevalidated deterministic validation check, per-run-worktree workspace and maxConcurrency=1. Task.model cannot coexist with compound: reject ambiguity. Other tasks, old workflows and ordinary chat keep existing semantics. Use a new CompoundExecutor invoked by WorkflowTaskExecutor; it calls a factored executeSingle for the solver and uses existing session/background ownership. No dynamic multi-model classifier in this beta.
single: primary -> deterministic validation -> accepted candidate or failure.
cascade: primary -> validation; only a quality failure allows one escalation -> validation. Auth, permission, environment, budget, interrupted/unknown side effects stop without model hopping. Escalation continues from the same isolated draft and receives bounded evidence of the failed attempt.
critic: primary -> validation -> independent critic -> at most one primary revision -> validation. Critic emits strict {verdict:"accept"|"revise"|"uncertain",findings:[{path:string,line?:integer,message:string}],summary:string}; malformed/uncertain is blocked, never accepted. If initial deterministic validation fails for quality, include failures in the critique; nonquality failure stops. A revision can become a candidate only after deterministic checks pass and each finding has an explicit disposition in its output. No second critic or unbounded revise loop; show that final revision was not independently re-reviewed. A reviewer opinion is not a deterministic test result.
Critic receives an immutable host-created patch/evidence snapshot, at most 32 files and 512 KiB of text; unsupported binary content, unresolved truncation or missing required scope blocks review. Expose zero tools, no MCP/provider-native tools, shell, Code Mode, hooks, tasks, external requests or mutable workspace handles to critic execution. Do not implement tools={} on SessionPrompt as if it necessarily meant deny-all; prove the final LLM tool catalog and dispatcher are empty. Hash candidate before/after critic; any change invalidates review. This is enforced tool isolation, not a claimed OS sandbox. Solver work remains subject to existing host permissions. Authorized validation commands can have side effects and must run only in the leased workspace with the existing restricted validation environment; do not call them read-only proof.
Always retain the candidate worktree and hash-bound diff/results; compound completion must bypass ordinary completed-worktree cleanup. Do not auto-apply to the caller checkout, stage/commit/push or merge. Return authoritative workspace path, base SHA, patch digest, validation verdict, leg costs and review limitations. Applying/merging a candidate is a later user-directed existing review workflow. Missing Git/clean baseline for an isolated run is blocked, not in-place fallback. This beta starts from committed HEAD and must explicitly report excluded dirty/untracked changes; if the requested task depends on them, stop for a reviewed baseline decision rather than silently omit them.

CONFIGURATION ASSISTANCE: New ai_config tool actions inspect, plan, validate, apply plus equivalent mendcode ai config subcommands use one backend service. The CLI must use withSharedClient, not bootstrap a second writer. inspect reads actual enabled provider/model/variant inventory and role projections, with capability/auth status and evidence source/date; no secrets or paid calls. plan accepts an allowlist of actual ModelRef candidates, intent economical|balanced|quality and taskKind repair|terminal|frontend|architecture|review|general, then emits alternative profiles, rationale, uncertainty and a preview JSON patch. Rank feasibility first; compare cost only within known billing/usage assumptions and quality only with comparable dated evidence. Without quality evidence do not invent scores: offer explained tradeoffs and mark quality unknown, respecting explicit user role choices. Unknown prices may be supplemented from dated primary-source metadata through user-directed research; never hardcode this brief's prices as live truth. Recommendations are not automatically applied.
validate checks schemas, roles/auth/capabilities, cost coverage, native binding and limits without provider calls. apply requires target scope project|global, exact patch and expected content digest (missing file has a defined empty digest), then normal backend permission bound to causal user request, re-read/CAS, comment-preserving JSONC edit and atomic replacement. Preserve unrelated keys; patch only compaction and ai. If no project config exists create mendcode.jsonc at the resolved project root; if multiple equally writable project configs exist require the caller to choose an observed supported target. Do not write generated config or models.yaml, or overwrite config.json through Config.update by accident. No credentials in files. Retain a scoped rollback copy and return changed keys, effective values and warnings. Apply does not run a workflow, change active session model or purchase capacity. Existing user authorization suffices; do not add repetitive approvals beyond actual host permissions.
Full Prompt Mode includes a concise schema/example and the inspect -> explain -> plan -> validate -> apply workflow, only advertising tools actually exposed in that session. It explains ordinary chat versus explicit compound workflows, native-provider limitations, cost versus subscription quota, privacy/provider changes, limits and disable/rollback. Full mode may help configure any enabled provider, never an OpenAI-only model list or mandatory expensive default. Compact/focus/custom modes do not receive a full model catalog. Configuration assistance still works when orchestration is disabled.

PUBLICATION/COMPATIBILITY: Proposed label v0.1.44-beta.4 is provisional; recheck collision and obtain release-time version/publication intent. No SQL migration or dependency bump expected; JSON/API schemas are additive and old configurations load unchanged. Preserve beta/stable downgrade guards. Existing beta.3 Code Mode/keyboard/Smart Approval interactive limitations remain separate; do not claim them fixed by this plan. Native enabled without live adapter proof is BLOCKED, not fallback-labelled success.

ADDITIONAL INTEGRATION INVARIANTS: Native-aware overflow accounting uses the actual checkpoint-plus-delta input, not token counts of the full retained transcript; otherwise every next turn could trigger another compaction. Preserve native source history against destructive pruning while it is needed for portable reconstruction. Keep at most the active and previous native checkpoint per session (8 MiB ciphertext budget), retiring older opaque records only after a committed replacement while retaining source transcript; no background DB polling. An unsupported old runtime ignores private native records and processes original history normally. Store user-visible native completion as an ordinary synthetic diagnostic part, not summary=true; reuse compaction events/status and current component layout. Failed attempts carry terminal error status, not a fake packed state.
WorkflowTaskExecutor.ExecuteInput gains optional compoundContext={runID,taskAttemptID,generation,resolvedProfile,configHash}; it is required when task.compound is present and supplied by WorkflowRunner from the actual claimed attempt. Never accept caller-invented run IDs from a model tool. Ledger ownership follows this context and is cleared on scope disposal. All compound metadata in task/attempt JSON must be preserved by read/write converters and status exports. Disable default automatic retries for compound wrapper tasks; a manual retry creates a new counted attempt, and a stale/unknown prior leg cannot be replayed automatically.
Critic output max 4096 tokens, max 32 findings, message/summary max 2000 characters; paths must be relative to frozen snapshot entries, line positive and within that snapshot. Unsupported evidence needs explicit uncertain rather than a hallucinated path. The final revised candidate retains original critique plus explicit dispositions; it is marked revision_verified_by_checks, not independently_reviewed_again.
Recommendation evidence may be supplied as bounded advisory records {providerID,modelID,taskKind,metric,value,sourceURL,observedAt,evaluationContext}; max 64 records. Values from user/assistant research are labelled supplied evidence, not provider-verified facts. Catalog retrieval time is not price-verification date. The conversational assistant can perform user-directed primary-source research to improve a proposal, but the configuration service never starts web research, benchmark calls or invented intelligence scores on its own. Explanations distinguish task-specific evidence, user preference and unknowns.

MIXED-VERSION WORKFLOW GUARD: Existing beta.3 readers do not know compound metadata. Never persist a compound job as an ordinary runnable agent and assume an additive field will stop old execution. Public authoring accepts kind=agent plus compound; materialization stores kind=human plus validated compound metadata in BOTH the immutable persisted revision and task row. New compound-aware execution checks/validates compound before the ordinary human branch and executes only under the snapshotted profile and explicit run authority. Old executors encounter their existing human gate and return needs_input without a provider call. New snapshots may expose a descriptive effectiveKind=compound while preserving serialized safety. A saved/exported definition retains the human sentinel so re-saving or starting it with beta.3 cannot silently erase compound behavior and run as an agent. Direct standalone human tasks without compound remain human. Prove this against the pinned beta.3 result/plan/load paths, including save/start/retry/restart; if any old path bypasses the sentinel, block compound persistence until a verified fail-closed compatibility contract replaces it. Do not silently introduce a SQL/schema-version migration to solve this.


## Recovery

Keep old portable mode and ordinary single-model chat usable. Disable compaction.strategy native/auto by setting portable and portable_mode legacy; disable ai.orchestration without deleting profiles. Native checkpoints never replace legacy summary markers or erase transcript. If current context depends on native items and route changes, reconstruct portable input from retained history before dispatch; do not silently drop opaque state. Config apply uses exact digest and a scoped restorable copy. Compound runs retain worktrees and receipts on failure, stop or success. A persisted dispatch without a terminal receipt after crash is unknown and must not automatically replay side-effecting work; manual resume can continue only from a proven boundary. On source/interface/ownership contradiction revise this packet and generated mirror before affected edits. No reset/stash/clean or blind version bump; no SQL migration or dependency install as an incidental fix. Missing live credentials or approved canary budget block live/native acceptance, not independent deterministic implementation.

## Requirements

- R1: Implement from verified beta.3-or-newer source while preserving concurrent work and old configuration behavior.
- R2: Provide fast native compaction for each individually proven OpenAI API/OAuth adapter; keep native items bound, intact, cancellable and recoverable.
- R3: Provide an opt-in incremental portable compactor with bounded output and no loss of latest intent, constraints or unfinished work.
- R4: Measure compaction latency and fidelity on controlled corpora; expose actual timing and never claim universal sub-10-second performance.
- R5: Validate optional multi-provider single/cascade/critic profiles in existing JSON/JSONC; preserve role/manual-selection precedence and bounded budgets.
- R6: Execute explicit compound workflow tasks using isolated candidates, deterministic gates and an independently tool-isolated critic.
- R7: Account for all model legs/retries/compactions without duplicate billing totals and enforce request/time/token/estimated-cost guards and cancellation.
- R8: Expose read-only configuration inspection/planning/validation and exact scoped permission-gated JSONC application via shared backend and native tool.
- R9: Teach Full Prompt Mode to help configure and recommend from the user's actual providers with honest cost/capability evidence.
- R10: Prove integrated routes, restart behavior, ordinary-chat regressions and release readiness without unauthorized deployment or database downgrade.

## Execution Policy


### Profile

backend

### Rationale

Provider protocol preservation, persistent context, optional multi-provider execution and configuration trust boundaries dominate; tests target actual serializer/auth/ownership/state transitions plus latency/fidelity, not a broad UI redesign.

### Locked Decisions


#### Entry 1


##### Decision

Use native capabilities only for proven transport/model/auth; retain portable context and original transcript.

##### Reason

Encrypted provider state is not portable, and native compaction is a new request/history boundary.

##### Invalidated By

Current source already provides a different validated native contract, or API/SDK serialization cannot preserve the required output; stop adapter work and revise before enabling.

#### Entry 2


##### Decision

Use existing JSON config and existing workflows; ordinary chat and manual models remain unchanged.

##### Reason

The user wants optional configuration across their providers, not a forced model replacement.

##### Invalidated By

Current config loader or workflow persistence cannot represent additive fields; supply exact evidence and revised storage decision.

#### Entry 3


##### Decision

Critic has zero tool execution; compound work retains isolated candidate and never auto-applies.

##### Reason

Reviewer independence and preserving real working state require runtime boundaries, not prompt promises.

##### Invalidated By

Existing provider native tools/hooks cannot be disabled or workspace retention cannot be guaranteed; block critic route rather than relabel it safe.

#### Entry 4


##### Decision

Measure sub-10-second native compaction and fidelity together.

##### Reason

The user observed speed in Codex; no source establishes universal latency or a lossless summary.

##### Invalidated By

Actual controlled canary misses target or continuity; report failed criterion and revisit before a speed claim.

### Discretion

- Choose helper names, local Effect composition and fixture partitioning while preserving the exact schema, state machines, scope and protocol contracts.
- Extract reusable transport/JSONC helpers from observed modules if their public behavior is unchanged and all declared owners serialize shared-file edits.

### Escalation

- Conflicting dirty prompt/compose work or a newer baseline requires ownership/source reconciliation before edits.
- A new dependency, SQL migration, extra provider adapter, automatic chat routing, remote executor, live spend or release needs a revised contract or separate user authority.
- After two ineffective attempts on a criterion, revisit diagnosis with evidence; do not drop continuity or billing requirements to make it pass.

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

#### Excluded Checks

- Full repository tests, browser/deck rendering, new TUI styling and unrelated hardware/platform checks by ceremony; expand only for actual affected coverage or release gates.
- No live paid calls, app/test/build commands or release actions during planning; later live/native evidence needs authorized credentials and a bounded spend cap.
- No whole provider-catalog refresh or dependency regeneration as a substitute for scoped schema validation.

#### Rerun When

- Relevant source, serializer/dependency version, provider/auth configuration or test environment changed.
- Earlier check failed/is flaky or its assertions/corpus do not establish the required behavior.

#### Failure Limit

2

Policy semantics: preserve locked decisions unless current evidence invalidates them; use only the declared local discretion. On an escalation trigger, stop affected work and report the observation and required decision; continue independent authorized work.
Validation required_checks names task IDs, not a waiver of other mandatory criteria. Reuse successful evidence only when relevant source, dependencies, environment and coverage still match. failure_limit counts consecutive ineffective attempts at one criterion before revisiting diagnosis; it never turns missing or failed evidence into acceptance. Policy fields grant no extra edit, publication or device permissions.

## Execution and evidence

Planning state: draft. Execution has not started.
Closure owner: session_lead. Evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.evidence.json. State: .agents/plans/mendcode-beta4-fast-context-orchestration.state.json.
Edit/new files scope product content. The evidence_file and each verification.evidence path authorize only named evidence artifacts; state_file names the execution state. Only the session lead aggregates evidence_file/state_file. Evidence outputs must not overwrite product/input files, existing unrelated artifacts or the planning source. Workers use distinct check-evidence files and required parent directories; no other output paths are implied.
Verify tools and permissions before work. Missing capabilities block only dependent criteria.
Record actual checks as PASS, FAIL, BLOCKED, NOT_RUN or NOT_APPLICABLE with evidence.

## T0 — Resolve baseline, active ownership and exact transport prerequisites

### Work Kind

decision

### Depends On

None.

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/AGENTS.md
- src/mendcode/packages/opencode/test/AGENTS.md
- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/src/mend/config/models.ts
- src/mendcode/packages/opencode/src/session/compaction.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/provider/provider.ts

### Edit Files

None.

### New Files

None.

### Symbols

- Git beta.3 commit and local dirty state
- CodexAuthPlugin, Config.Info, Provider.Interface

### Interfaces

- Published base 995a6a67 is the inspected contract, not authoring HEAD; see root context.

### Inputs

- Current refs/releases, dirty/staged/untracked diffs and installed dependency versions

### Outputs

- Evidence of a safe execution surface, overlap resolution and API/OAuth transport capability matrix

### Operation Order

1. Recheck release/PR refs and current project instructions.
2. Compare target source with inspected base and inspect dirty overlapping prompt/compose files; do not overwrite or use an alternate worktree to evade an unresolved ownership blocker.
3. Inspect installed OpenAI SDK serialization and actual Codex adapter auth path; record known unsupported endpoints/protocols.
4. Confirm no schema/dependency changes are necessary, or block affected task with concrete discrepancy.

### Error Semantics

- No matching clean execution surface is an ownership blocker, not authority to stash/reset.
- Pinned public Codex source is behavioral evidence, not availability proof for the user account.

### Examples

- A newer accepted beta already adding native compaction requires narrowing T2/T3, not duplicating it.

### Counterexamples

- Compiling on old HEAD with invented missing beta files is not a valid baseline.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Safe baseline/ownership decision and capability inventory recorded; no runtime or credential call needed for this decision.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R1

### Verification

- kind: acceptance
- procedure: PROPOSED, NOT RUN: Inspect git status --short --branch, git diff --name-only, git diff --cached --name-only, gh release list --limit 8, gh pr list, and git ls-remote origin refs/heads/dev refs/heads/main. Record source revision and relevant dirty-file digests.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Safe baseline/ownership decision and capability inventory recorded; no runtime or credential call needed for this decision.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T0.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T1 — Define strict JSON config and provider-aware profile resolution

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/config/config.ts
- src/mendcode/packages/opencode/src/mend/config/models.ts
- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/test/mend/models-config.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/config/config.ts
- src/mendcode/packages/opencode/src/config/ai.ts
- src/mendcode/packages/opencode/src/mend/config/compound-models.ts
- src/mendcode/packages/opencode/test/config/ai.test.ts
- src/mendcode/packages/opencode/test/mend/compound-models.test.ts

### New Files

- src/mendcode/packages/opencode/src/config/ai.ts
- src/mendcode/packages/opencode/src/mend/config/compound-models.ts
- src/mendcode/packages/opencode/test/config/ai.test.ts
- src/mendcode/packages/opencode/test/mend/compound-models.test.ts

### Symbols

- Config.Info and mergeConfig
- readModelsConfig/resolveModelRoles
- new AIConfig schema and resolveCompoundProfile(profile,inventory,roles)

### Interfaces

- Implement exact compaction and ai schemas, atomic profile/ModelRef precedence and Limits from root contract.
- Return resolved immutable profile with source/hash and structured validation issues {code,path,message}; do not select a fallback model for malformed refs.

### Inputs

- Global/project JSONC, existing roles, enabled provider inventory and variants

### Outputs

- Pure schema/resolver, old-config compatibility and capability/auth diagnostic failures

### Operation Order

1. Parse additive fields and bounds.
2. Apply atomic profile overrides; resolve explicit refs or role refs once.
3. Validate strategy minimums, credential-mode compatibility and unknown-cost policy; prepare serializable snapshot.

### Error Semantics

- Unknown provider/model/variant, unconfigured role, nonfinite/zero limits or a model+compound conflict fail validation before calls.
- Disabled/absent ai leaves all ordinary model selection behavior unchanged.

### Examples

- A configured build role resolves to its actual provider/model; a direct modelID containing slash remains intact.
- Global primary provider A plus project profile replacing it with provider B cannot produce a mixed A/B ref.

### Counterexamples

- Using removed role review for critic silently loses settings; define critic directly or use a separately configured user role.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Valid arbitrary-provider profiles resolve; invalid/mixed refs fail; old config/role tests remain valid; no schema migration.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R1
- R5

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/config/ai.test.ts test/mend/compound-models.test.ts test/mend/models-config.test.ts --timeout 30000; inspect schema output without refreshing provider snapshots.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Valid arbitrary-provider profiles resolve; invalid/mixed refs fail; old config/role tests remain valid; no schema migration.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T1.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T2 — Implement verified native compaction adapters and canonical wire handling

### Work Kind

product_code

### Depends On

- T1

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts
- src/mendcode/packages/opencode/src/provider/sdk/copilot/responses/openai-responses-api-types.ts
- src/mendcode/packages/opencode/test/plugin/codex.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/src/provider/native-compaction.ts
- src/mendcode/packages/opencode/src/provider/native-context.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/test/provider/native-compaction.test.ts
- src/mendcode/packages/opencode/test/plugin/codex.test.ts

### New Files

- src/mendcode/packages/opencode/src/provider/native-compaction.ts
- src/mendcode/packages/opencode/src/provider/native-context.ts
- src/mendcode/packages/opencode/test/provider/native-compaction.test.ts

### Symbols

- Provider.Interface/getLanguage/fetch middleware
- CodexAuthPlugin.auth.loader/prepareCodexChatGPTOAuthRequest
- LLM.Service stream middleware
- new NativeCompactionAdapter capability/compact/prepareNextInput

### Interfaces

- Adapter internal request {binding,model,inputItems,instructions,abort,timeoutMs}; result {protocol,outputItems,usage|null,requestID|null}. Treat outputItems as canonical opaque content with guarded JSON validation, not a human summary.
- Reuse credential acquisition/refresh/custom fetch from actual provider plumbing; expose optional provider capability rather than making all third-party providers implement a new mandatory method.
- Separate standalone compact from Responses inference/Responses Lite normalization. Preserve /compact suffix, account header and cancellation; never append API keys or rewrite custom hosts speculatively.

### Inputs

- Existing provider/model/auth route and canonical inference items; future native checkpoint from T3

### Outputs

- Native API and OAuth adapters independently capability-gated, with no-copy credential flow and opaque-window round-trip

### Operation Order

1. Factor bounded transport access without changing normal request behavior.
2. Prepare native-compatible source items using existing Responses conversion patterns; reject unsupported modalities/pairing rather than dropping content.
3. Call documented standalone endpoint and validate/cap output.
4. At the final request boundary preserve canonical compact output exactly, then append only T3-delimited serialized deltas; bypass ID stripping only for canonical native items.
5. Keep request context scoped by session/generation; never use a singleton active checkpoint.

### Error Semantics

- 401/403/cancel/permission failures stop without billing/auth fallback. Recognized unsupported route yields capability unsupported; timeout/native errors follow root fallback rule.
- No retry/installation after cancellation; malformed/unpaired or oversized output is not usable.

### Examples

- A compact item with encrypted_content plus retained messages reaches next request in the same order with IDs unchanged.
- Two sessions using different accounts/providers cannot read each other's checkpoint or header.

### Counterexamples

- Changing /responses/compact into the usual /responses path or running returned items through generic summary conversion breaks the protocol.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Mock HTTP proves auth refresh/account routing, canonical item preservation, normal Responses regression, unsupported route, malformed response, cancellation and concurrent session isolation.
- Native capability is not marked live-verified until T4 per-adapter real round-trip acceptance.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R2
- R7

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/provider/native-compaction.test.ts test/plugin/codex.test.ts --timeout 30000. Verify actual serialized bodies in fixtures; mock PASS is not live provider proof.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Mock HTTP proves auth refresh/account routing, canonical item preservation, normal Responses regression, unsupported route, malformed response, cancellation and concurrent session isolation.; Native capability is not marked live-verified until T4 per-adapter real round-trip acceptance.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T2.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T3 — Install native checkpoints safely and optimize portable compaction

### Work Kind

product_code

### Depends On

- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/compaction.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/runtime-mailbox.ts
- src/mendcode/packages/opencode/src/session/context-memory.ts
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/test/session/compaction.test.ts
- src/mendcode/packages/opencode/test/session/compaction-attachments.test.ts
- src/mendcode/packages/opencode/src/server/routes/instance/continuity.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/handlers/continuity.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/compaction.ts
- src/mendcode/packages/opencode/src/session/compaction-checkpoint.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/session/context-profile.ts
- src/mendcode/packages/opencode/test/session/compaction.test.ts
- src/mendcode/packages/opencode/test/session/compaction-attachments.test.ts
- src/mendcode/packages/opencode/test/session/compaction-checkpoint.test.ts

### New Files

- src/mendcode/packages/opencode/src/session/compaction-checkpoint.ts
- src/mendcode/packages/opencode/test/session/compaction-checkpoint.test.ts

### Symbols

- SessionCompaction.process/select/buildPrompt
- MessageV2.filterCompacted/compactedHistory
- Mailbox.getRecord/putRecord and Database.transaction
- new checkpoint load/commitIfCurrent/invalidate

### Interfaces

- Native checkpoint namespace and all binding/generation/size rules are defined in root decisions. Native checkpoints do not set legacy summary=true or erase transcript.
- Incremental portable uses last accepted summary + uncovered turns + mandatory durable current context, max_summary_tokens cap; preserve legacy mode.
- Persist redacted timing {prepareMs,providerMs,installMs,resumeMs,totalMs,method,fallbackReason?,inputTokens?,outputTokens?}; null means unmeasured.

### Inputs

- Settled session messages/tools, user boundary, previous checkpoint/summary, current model and settings

### Outputs

- Atomic usable context or unchanged prior context; persisted safe restart and observable timing

### Operation Order

1. Acquire session-owned generation/boundary; drain no active side-effecting call by guessing completion.
2. Select strategy and check compaction-role precedence. Build input without losing uncovered turns.
3. Perform adapter or portable request with bounded output and actual abort.
4. Verify generation/fingerprint still matches; atomically install native private record or complete portable summary.
5. On restart/provider change/fork/revert select same-binding native or reconstruct portable from retained transcript before dispatch.
6. Emit normal completion/activity events so existing /compact UI settles; no new TUI layout.

### Error Semantics

- Stale completion never overwrites newer user state; an unavailable history segment blocks recovery rather than producing a placeholder success.
- If incremental input cannot fit chosen model or required state cannot fit output cap, return explicit mismatch; never prune uncovered history just to hit latency.
- Native errors preserve history; auto unsupported may select portable, on_native_error controls genuine failures.

### Examples

- User cancellation during compact leaves original history usable and no late resume.
- Native checkpoint followed by switch to provider B uses portable source; old beta runtime sees original history, not empty native summary.

### Counterexamples

- A synthetic native checkpoint labelled summary=true makes older filterCompacted truncate usable history and is forbidden.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Tests preserve user corrections, pending work, tool pairing, images/references, language, queued input, restart and legacy behavior.
- No SQL migration or global memory writes; no hidden extra compaction model; every timing covers real boundary rather than first-token time alone.
- Actual native input token accounting avoids a recompaction loop; retiring old native records preserves recoverable transcript, and continuity/status responses never expose opaque records.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R1
- R2
- R3
- R4

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/session/compaction.test.ts test/session/compaction-attachments.test.ts test/session/compaction-checkpoint.test.ts --timeout 30000; test old filter behavior against fixtures with new native records and ensure original messages remain visible.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Tests preserve user corrections, pending work, tool pairing, images/references, language, queued input, restart and legacy behavior.; No SQL migration or global memory writes; no hidden extra compaction model; every timing covers real boundary rather than first-token time alone.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T3.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T4 — Measure native and portable compaction latency plus fidelity

### Work Kind

text_test

### Depends On

- T3

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/script/queue-compaction-smoke.ts
- src/mendcode/packages/opencode/script/session-runtime-smoke.ts
- src/mendcode/packages/opencode/test/session/compaction.test.ts

### Edit Files

- src/mendcode/packages/opencode/script/compaction-canary.ts
- src/mendcode/packages/opencode/test/session/compaction-fidelity.test.ts

### New Files

- src/mendcode/packages/opencode/script/compaction-canary.ts
- src/mendcode/packages/opencode/test/session/compaction-fidelity.test.ts

### Symbols

- New compaction-canary.ts runner and deterministic state oracle

### Interfaces

- Proposed runner accepts --mode fixture|live --strategy portable|native --provider <actual-id> --model <actual-id> --output <approved evidence path>; live additionally requires explicit approved budget and credentials. Defaults fixture, never auto-live.
- Fixtures: two fixed sanitized corpora near 30k and 100k input tokens when supported; long tool output, correction/cancellation, 20 named retained facts and 5 pending actions, IDs/paths/tool pairs and language. Store corpus hashes and actual token count method.

### Inputs

- Same corpora/model/effort/network environment for beta.3 legacy, candidate portable and eligible native; report unsupported capacities separately

### Outputs

- Timing/quality evidence per strategy and exact auth route; no fabricated performance results

### Operation Order

1. Implement deterministic fake-provider/corruption cases first.
2. For authorized live benchmark run 10 sequential trials per supported corpus/route, recording cold and warm runs separately plus total and per-phase timing; enforce aggregate budget before every call.
3. Measure request start through installed usable context and first post-compaction answer separately.
4. Check all 20 facts, 5 actions, exact latest intent, constraints and tool pair validity after compaction; flag any forbidden action/repeated completed work.
5. Target native median total compaction <=10000ms on agreed corpora; report p95/max and paired legacy/portable timing. This is an acceptance target, not a documented vendor SLA.

### Error Semantics

- Missing credentials, source corpus, supported context size or budget leaves corresponding live criterion BLOCKED/NOT_RUN.
- A fast request with lost state fails; missing/ambiguous factual recall fails the fixture oracle. If median target fails, document cause and do not advertise sub-10-second acceptance.

### Examples

- 8-second compact + 30-second delayed installation is 38-second compaction, not a PASS.

### Counterexamples

- Synthetic instant-provider results cannot establish native latency; API-key results cannot validate OAuth.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Fixture continuity/corruption cases pass.
- Each advertised native adapter has one actual compact -> next-inference round-trip and separate latency/fidelity evidence. Native median target and exact fidelity are reported PASS/FAIL independently.

### Required Capabilities

- repository_read
- code
- command
- live_provider_access_when_authorized

### Traces To

- R2
- R3
- R4

### Verification

- kind: acceptance
- procedure: PROPOSED, NOT RUN: bun test test/session/compaction-fidelity.test.ts --timeout 30000; after creation inspect and run bun run script/compaction-canary.ts --mode fixture with evidence output. Live mode only after separately authorized route/credential/cost cap.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Fixture continuity/corruption cases pass.; Each advertised native adapter has one actual compact -> next-inference round-trip and separate latency/fidelity evidence. Native median target and exact fidelity are reported PASS/FAIL independently.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T4.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T5 — Compile compound profiles into immutable workflow tasks

### Work Kind

product_code

### Depends On

- T1

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/workflow.ts
- src/mendcode/packages/opencode/src/session/workflow-plan.ts
- src/mendcode/packages/opencode/src/session/workflow-service.ts
- src/mendcode/packages/opencode/src/session/session.sql.ts
- src/mendcode/packages/opencode/src/tool/workflow.ts
- src/mendcode/packages/opencode/test/session/workflow-plan.test.ts
- src/mendcode/packages/opencode/test/session/workflow-persistence.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/workflow.ts
- src/mendcode/packages/opencode/src/session/workflow-plan.ts
- src/mendcode/packages/opencode/src/session/workflow-service.ts
- src/mendcode/packages/opencode/src/session/compound-plan.ts
- src/mendcode/packages/opencode/src/tool/workflow.ts
- src/mendcode/packages/opencode/test/session/workflow-plan.test.ts
- src/mendcode/packages/opencode/test/session/workflow-persistence.test.ts
- src/mendcode/packages/opencode/test/session/compound-plan.test.ts

### New Files

- src/mendcode/packages/opencode/src/session/compound-plan.ts
- src/mendcode/packages/opencode/test/session/compound-plan.test.ts

### Symbols

- WorkflowTask/WorkflowPlan
- WorkflowService.preview/save/start
- WorkflowTaskTable.data and immutable revision plan
- new resolveCompoundTask

### Interfaces

- Exact compound task field, allowed kinds/outputs, validation checks and workflow workspace/limits are defined in root decisions.
- Persist resolved snapshot in existing task.data and revision JSON; converters must read it on reload, not just keep it in in-memory plans.
- Public agent+compound materializes to legacy-safe human+compound in both revision and row as specified in root mixed-version guard. Compound-aware execution checks this before ordinary human handling; old readers stop for user input.

### Inputs

- Explicit workflow tool/CLI plan selecting profile and authorized task prompt

### Outputs

- Validated resolved workflow task with stable config hash; unchanged old DAG behavior

### Operation Order

1. Validate full profile and deterministic command allowlist at preview.
2. Reject ambiguous task.model, missing checks, in-place/read-only workspace, concurrent compound runs or unconfigured refs.
3. Snapshot actual routes/limits once and persist before run; recheck availability without silently replacing routes at start.

### Error Semantics

- Config change during run does not alter a saved route. Missing auth/model or role produces actionable validation errors.
- Old workflows without compound remain unchanged. No automatic profile selection for chat.

### Examples

- User chooses cost-conscious profile with provider A primary and provider B escalation; saved run retains both even if config changes.

### Counterexamples

- A task model overriding profile primary without warning violates explicit role selection.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Round-trip persistence retains compound metadata and resolved provider IDs, rejects unsafe plans, and preserves old workflow tests.
- Pinned beta.3 save/load/start/retry simulation sees a human gate and performs zero model dispatches for persisted compound jobs; new runtime round-trips the resolved compound contract.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R1
- R5
- R6

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/session/compound-plan.test.ts test/session/workflow-plan.test.ts test/session/workflow-persistence.test.ts --timeout 30000.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Round-trip persistence retains compound metadata and resolved provider IDs, rejects unsafe plans, and preserves old workflow tests.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T5.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T6 — Add complete request ledger and enforce run budgets

### Work Kind

product_code

### Depends On

- T5
- T3

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/workflow-task-executor.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/session/runtime-mailbox.ts
- src/mendcode/packages/opencode/src/session/context-profile.ts
- src/mendcode/packages/opencode/src/session/session.sql.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/compound-ledger.ts
- src/mendcode/packages/opencode/src/session/workflow-task-executor.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/session/compaction-checkpoint.ts
- src/mendcode/packages/opencode/test/session/compound-ledger.test.ts

### New Files

- src/mendcode/packages/opencode/src/session/compound-ledger.ts
- src/mendcode/packages/opencode/test/session/compound-ledger.test.ts

### Symbols

- LLM request lifecycle/step-finish
- WorkflowTaskAttempt data
- new reserveRequest/finishRequest/aggregateLedger

### Interfaces

- Ledger key={runID,taskAttemptID,legID,requestID}; store role/provider/model/auth-class, timing, status, usage coverage and price source/version. Begin before dispatch; terminal receipt once; compaction included.
- Aggregate persisted request costs once; do not also add cumulative assistant/workflow cost. Distinguish provider-reported tokens, estimated API cost, subscription quota and unknown cost.
- Use existing JSON data/records, bounded by maxModelRequests; no per-token database churn. Record incomplete dispatch as unknown after crash.
- ExecuteInput.compoundContext shape and WorkflowRunner claim provenance are specified in root decisions; fail if a compound task lacks a valid claimed attempt context.

### Inputs

- Resolved limits plus generation, known token/price bounds and streamed usage

### Outputs

- Durable per-leg/run accounting and admission/cancel decisions

### Operation Order

1. Reserve request/count/token/output allowance before calling provider and check total remaining limits.
2. Track streamed token consumption in memory with bounded updates; enforce max output and cancel owned work on limit.
3. Record finish/error/cancel including missing usage; release reservations exactly once.
4. Link native compaction/fallback through same run scope; reject solver-created children and nested orchestration.

### Error Semantics

- Unknown usage never decrements already spent cost to zero; use reservation conservatively for future admission.
- Dollar guard requires priced bound or explicit unknownCost allowance; disclose that provider billing may differ.
- Repeated terminal events are idempotent; crash with ambiguous request never auto-replays.

### Examples

- Primary .02 + critic .01 + revision .03 is .06 once, even if parent summary also says .06.
- A rejected next request leaves existing artifact and marks budget blocked before paid dispatch.

### Counterexamples

- Summing parent aggregate plus child step costs double counts; treating subscription model cost=0 as free misleads.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Duplicate events, missing usage, canceled/failed requests, compaction charges, request admission and crash recovery tested; no unbounded descendants.
- No automatic wrapper retry can reset run budget or duplicate an unknown dispatch; persisted task/attempt converters retain ledger state.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R7

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/session/compound-ledger.test.ts --timeout 30000; use virtual/fake provider to assert exact dispatch count, reservation and cancellation. No live spend needed for ledger logic.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Duplicate events, missing usage, canceled/failed requests, compaction charges, request admission and crash recovery tested; no unbounded descendants.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T6.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T7 — Execute bounded single, cascade and isolated critic strategies

### Work Kind

product_code

### Depends On

- T6

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/workflow-task-executor.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/opencode/src/session/workflow-policy.ts
- src/mendcode/packages/opencode/src/session/completion-validation.ts
- src/mendcode/packages/opencode/src/session/background-task.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/src/session/workflow-service.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/compound-executor.ts
- src/mendcode/packages/opencode/src/session/compound-snapshot.ts
- src/mendcode/packages/opencode/src/session/workflow-task-executor.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/opencode/src/session/workflow-service.ts
- src/mendcode/packages/opencode/test/session/compound-executor.test.ts
- src/mendcode/packages/opencode/test/session/compound-isolation.test.ts
- src/mendcode/packages/opencode/test/session/workflow-task-executor.test.ts

### New Files

- src/mendcode/packages/opencode/src/session/compound-executor.ts
- src/mendcode/packages/opencode/src/session/compound-snapshot.ts
- src/mendcode/packages/opencode/test/session/compound-executor.test.ts
- src/mendcode/packages/opencode/test/session/compound-isolation.test.ts

### Symbols

- New CompoundExecutor.execute and executeCritic
- WorkflowTaskExecutor.execute factored executeSingle
- runCompletionValidationCommand
- WorkflowRunner cleanupWorkspace/executeClaim

### Interfaces

- Use exact strategy state machines and typed failure policy from root decisions; persist each leg before dispatch and after terminal result.
- Critic has a distinct child identity, immutable snapshot and zero actual tools/dispatchers, including provider-native tools and hooks. No prompt-only sandbox.
- ExecutionResult extends additively with compound receipt and returns completed only for the contracted accepted candidate; final text explicitly distinguishes accepted/revised/unreviewed-revision/blocked.

### Inputs

- Frozen profile, authorized task prompt, clean committed baseline, isolated leased workspace and deterministic checks

### Outputs

- Retained candidate workspace + hash-bound diff, validation and review result; no auto-application to original checkout

### Operation Order

1. Validate the persisted human+compound compatibility sentinel and current run authority before branching to the compound executor; do not execute an ordinary human task.
2. Create/verify leased candidate from committed HEAD; block requests that depend on excluded dirty work.
3. Invoke primary through existing single executor under ledger scope.
4. Run host-owned deterministic checks under authorization; distinguish quality from environmental/policy failures.
5. For cascade invoke at most one escalation on quality; for critic build snapshot, deny every tool, validate strict verdict, then optionally one primary revision and revalidate.
6. On cancellation abort exact live child/tool scope, reject late receipts and preserve artifacts; on restart never replay unknown side effects.
7. Retain worktree for completed compound runs and publish receipt through existing workflow outputs/events.

### Error Semantics

- Malformed/uncertain critic, changed snapshot hash, unsupported binary/truncated review context or changed baseline blocks acceptance.
- Test permission/environment errors do not trigger escalation. A failed revision remains failed; no extra model loop.
- Cleanup services may not delete the only candidate on success; human-directed later cleanup remains separate.

### Examples

- Failed quality test causes exactly two solver legs in cascade; 401 causes only the original leg and needs input.
- A critic asking for bash/write/MCP gets no executable tool; workspace hash stays unchanged.

### Counterexamples

- tools={} on a prompt API that defaults to all tools is not isolation.
- A generic completed-workflow cleanup deleting the candidate makes an otherwise successful run unusable.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Tests prove all branches, zero-tool critic, no sibling/origin modifications, exactly bounded legs, cancellation/restart and retained artifacts.
- Ordinary workflow task execution and manual model selection remain unchanged.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R6
- R7

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/session/compound-executor.test.ts test/session/compound-isolation.test.ts test/session/workflow-task-executor.test.ts --timeout 30000. Use hostile fake critic tool calls and real disposable Git fixtures to verify workspace hashes and retention.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Tests prove all branches, zero-tool critic, no sibling/origin modifications, exactly bounded legs, cancellation/restart and retained artifacts.; Ordinary workflow task execution and manual model selection remain unchanged.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T7.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T8 — Build evidence-based configuration advisor and exact JSONC writer

### Work Kind

product_code

### Depends On

- T1

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/config/config.ts
- src/mendcode/packages/opencode/src/mend/config/models.ts
- src/mendcode/packages/opencode/src/provider/provider.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-service.ts
- src/mendcode/packages/opencode/src/mend/cli/control-plane.ts

### Edit Files

- src/mendcode/packages/opencode/src/mend/runtime/ai-configuration.ts
- src/mendcode/packages/opencode/src/mend/config/ai-writer.ts
- src/mendcode/packages/opencode/test/mend/ai-configuration.test.ts
- src/mendcode/packages/opencode/test/mend/ai-writer.test.ts

### New Files

- src/mendcode/packages/opencode/src/mend/runtime/ai-configuration.ts
- src/mendcode/packages/opencode/src/mend/config/ai-writer.ts
- src/mendcode/packages/opencode/test/mend/ai-configuration.test.ts
- src/mendcode/packages/opencode/test/mend/ai-writer.test.ts

### Symbols

- New AIConfiguration inspect/plan/validate/apply
- Provider.list/getModel, resolveModelRoles
- Config JSONC parse/patch patterns and exact-action permission authority

### Interfaces

- inspect -> {models,roles,capabilities,pricingSources,configSources,missingInformation}; return public metadata only.
- plan({candidates:ModelRef[],intent,taskKind,selectedRoles?}) -> {alternatives,patch,explanation,warnings,evidence,expectedHash,target}; no writes or LLM calls.
- apply({scope,target,patch,expectedHash,causalSessionID}) -> changed keys/effective values/backup reference; patch only ai and compaction and revalidate before atomic replacement.
- Optional bounded advisory evidence input is described in root decisions; missing comparable intelligence evidence results in alternatives/uncertainty rather than fabricated rankings.

### Inputs

- Actual catalog/auth status, user allowed candidate models/objective and observed config source

### Outputs

- Ranked feasible tradeoffs or explicit missing-data explanation, valid JSON preview and comment-preserving scoped writer

### Operation Order

1. Inspect current configuration with provenance, not static preset assumptions.
2. Filter unavailable/incompatible models; compare known cost and comparable quality evidence; retain unknown quality rather than fabricate ratings.
3. Validate final profile and compaction choice; show extra providers/billing classes and limits.
4. For apply resolve only observed supported project/global file, obtain existing exact permission for user-directed change, recheck expected hash and atomically edit preserving unrelated keys/comments.
5. Invalidate config for later calls without altering active runs or user-selected session model.

### Error Semantics

- Digest conflict -> 409-equivalent conflict, no overwrite; multiple writable targets -> actionable ambiguity.
- No price/auth evidence -> unknown/not configured; never claim cheapest or best intelligence without support.
- Permission rejection -> unchanged file, no login/paid call/model switch.

### Examples

- User says only use providers A and B: no provider C can appear in a recommendation or generated patch.
- A subscription route may be recommended with quota caveats, not represented as $0 inference.

### Counterexamples

- Saving through Config.update into unrelated config.json or replacing the entire JSONC document loses user configuration.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Tests cover arbitrary providers, unavailable models, conflicting targets/hash, preserved comments/keys, private data exclusion and no-write previews.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R5
- R8

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/mend/ai-configuration.test.ts test/mend/ai-writer.test.ts --timeout 30000; use temporary fixture configs only and assert byte preservation outside patched fields.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Tests cover arbitrary providers, unavailable models, conflicting targets/hash, preserved comments/keys, private data exclusion and no-write previews.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T8.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T9 — Expose advisor via shared backend, CLI and native tool

### Work Kind

product_code

### Depends On

- T8

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/cli/shared-client.ts
- src/mendcode/packages/opencode/src/mend/cli/control-plane.ts
- src/mendcode/packages/opencode/src/server/routes/instance/config.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/src/tool/tool.ts

### Edit Files

- src/mendcode/packages/opencode/src/mend/cli/control-plane.ts
- src/mendcode/packages/opencode/src/server/routes/instance/config.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts
- src/mendcode/packages/opencode/src/tool/ai-config.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/test/server/ai-config.test.ts
- src/mendcode/packages/opencode/test/tool/ai-config.test.ts
- src/mendcode/packages/opencode/test/mend/ai-cli.test.ts

### New Files

- src/mendcode/packages/opencode/src/tool/ai-config.ts
- src/mendcode/packages/opencode/test/server/ai-config.test.ts
- src/mendcode/packages/opencode/test/tool/ai-config.test.ts
- src/mendcode/packages/opencode/test/mend/ai-cli.test.ts

### Symbols

- New ai_config native tool
- mendcode ai config inspect|plan|validate|apply
- Config route groups/handlers and withSharedClient

### Interfaces

- Add authenticated GET /config/ai for inspect and POST /config/ai/plan|validate|apply with T8 request/response shapes. Error codes: 400 invalid, 403 permission, 409 stale target, 422 unavailable model/capability.
- Native tool actions mirror service; inspect/plan/validate usable while orchestration disabled. apply requires normal permission and causal identity; caller cannot forge another session's approval.
- CLI plan/validate accept --file <preview JSON>; apply accepts --file plus --scope and --expected-hash. Arguments are parsed, never shell-interpolated. No paid calls on inspect/plan/validate.

### Inputs

- Authorized local client/native tool and T8 service

### Outputs

- Equivalent Legacy/Effect API behavior, CLI JSON and tool metadata; no additional database writer

### Operation Order

1. Wire both backend route implementations to one service and existing instance/auth scope.
2. Route CLI through shared client; preserve old ai status/env commands.
3. Expose tool under runtime permission/capability discovery, with bounded JSON outputs and redacted source metadata.
4. Cover API/schema changes with scoped generation only after locating the correct installed generator; do not run model-catalog generation or broaden outputs silently.

### Error Semantics

- Disconnected backend produces actionable connection failure; never fallback to opening another DB writer.
- Invalid IDs/model refs never call a provider or mutate config.

### Examples

- Second CLI client inspects configuration while TUI backend owns DB; no writer-lock failure.

### Counterexamples

- CLI-only code passing while native tool or Effect handler bypasses permission is incomplete.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Legacy/Effect/native tool/CLI agree for success/errors/permission and share one writer; tool schema fits T8 shapes.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R8
- R10

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/server/ai-config.test.ts test/tool/ai-config.test.ts test/mend/ai-cli.test.ts --timeout 30000. Test both HTTP backends and add a two-client shared-backend fixture; inspect scoped OpenAPI/SDK drift.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Legacy/Effect/native tool/CLI agree for success/errors/permission and share one writer; tool schema fits T8 shapes.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T9.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T10 — Teach Full Prompt Mode and document complete user journeys

### Work Kind

product_code

### Depends On

- T7
- T9

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/test/mend/prompt/compose.test.ts
- src/mendcode/packages/opencode/src/tool/workflow.ts
- docs/release-channels-and-continuity.md

### Edit Files

- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/test/mend/prompt/compose.test.ts
- docs/fast-compaction-and-model-workflows.md
- docs/examples/ai-profiles.example.json

### New Files

- docs/fast-compaction-and-model-workflows.md
- docs/examples/ai-profiles.example.json

### Symbols

- fullProductCapabilityCatalog and full-mode composition
- Native ai_config and existing workflow tools

### Interfaces

- Document exact implemented schema and role refs; examples referencing roles build/plan/compaction are templates and validation must explain unconfigured roles. No hardcoded unverified model recommendations.
- Full mode includes bounded instructions to inspect actual models, ask only missing material preferences, compare evidence, preview/validate/apply, and invoke a compound workflow only on user intent. Minimal/focus/custom keep current scope.

### Inputs

- Implemented commands/tools/schema plus user prompt: optimize cost, use only my models, compact faster, explain provider support

### Outputs

- Self-contained user docs and truthful Full Prompt Mode guidance with executable schema examples

### Operation Order

1. Update full-mode catalog and concise configuration playbook using actual tool names and required fields.
2. Explain enabling auto native, fallback, separate compaction role, ordinary chat versus compound tasks, reviewer limits and how to disable/recover.
3. Add complete example config and workflow plan with placeholders/roles labelled and a test fixture inventory that validates it.
4. Add tests where recommendations stay within allowed models, unknown prices stay unknown, apply never runs a workflow, and disabled/missing tools are not advertised as available.

### Error Semantics

- Unavailable ai_config falls back to explaining actual observed commands; never invent provider access or claim configured means enabled.
- Full mode must not reinterpret a cost discussion as permission to launch extra models.

### Examples

- User: I have A/B, favor cost. Assistant inspects, compares available evidence, prepares validated preview and applies only when user requests it.
- User: compact faster with my subscription. Assistant explains native capability for this auth and portable role tradeoff, not API billing substitution.

### Counterexamples

- Always use Astra as critic ignores user catalog and configured selection; full catalog injection every turn wastes context.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- Full-mode compose tests and example schema validation pass; docs cover setup, run, inspect receipts, disable, conflicts and native portability.

### Required Capabilities

- repository_read
- code
- command

### Traces To

- R5
- R8
- R9

### Verification

- kind: text_test
- procedure: PROPOSED, NOT RUN: bun test test/mend/prompt/compose.test.ts --timeout 30000; parse docs/examples/ai-profiles.example.json through T1 schema with fixture providers; review actual full/minimal/focus/custom composed text for false availability/cost claims.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: Full-mode compose tests and example schema validation pass; docs cover setup, run, inspect receipts, disable, conflicts and native portability.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T10.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

## T11 — Accept integrated beta candidate and preserve release boundaries

### Work Kind

acceptance

### Depends On

- T4
- T5
- T6
- T7
- T8
- T9
- T10

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/compaction.ts
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/component/compaction-panel.tsx
- src/mendcode/packages/opencode/script/session-runtime-smoke.ts
- docs/release-channels-and-continuity.md
- docs/releases-and-startup-recovery.md

### Edit Files

None.

### New Files

None.

### Symbols

- Integrated session, provider, config and workflow contracts

### Interfaces

- Every R1-R10 maps to current PASS/FAIL/BLOCKED/NOT_RUN evidence; publication is separately authorized.
- Existing TUI layout is reused; test actual /compact and workflow receipt interactions, do not substitute unit/source proof for live backend or PTY behavior.

### Inputs

- Candidate fingerprint, task evidence, temporary fixtures and separately authorized live native adapter evidence

### Outputs

- Final acceptance matrix, measured timing/quality, native support matrix, retained candidate artifacts and release-readiness report

### Operation Order

1. Review diffs and scope, then run one integrated typecheck after all relevant source changes.
2. Exercise inspect -> plan -> validate -> authorized apply -> explicit workflow start -> retained candidate receipt through actual shared backend; repeat in Legacy/Effect only where evidence differs.
3. In isolated PTY run normal turn, /compact, send a queued correction, cancel compact and resume; verify no stranded Generating and unchanged selected model.
4. Exercise compound stop/restart/unknown attempt and both provider directions; verify no review tool access and no original checkout writes.
5. Require T4 live native round-trip and truthful latency results for advertised native adapters; missing credentials/budget leaves relevant criteria unaccepted.
6. Before separately authorized release: version collision/user choice, security checks, pinned installer/asset checksums/attestations and platform-scoped native smoke. No public writes from this packet.

### Error Semantics

- New-feature acceptance cannot PASS with missing integrated evidence; inherited disabled beta.3 features retain their documented limitations.
- A valid config or mock HTTP request is not proof of available OAuth native compaction.

### Examples

- API native PASS and OAuth blocked yields support matrix API verified/OAuth unverified, not native works everywhere.

### Counterexamples

- Changing models to improve a benchmark or silently dropping constraints makes the comparison invalid.

### Non Goals

- No autonomous executor/model selection, publication, global memory writes, provider credential changes or unrelated refactor.

### Acceptance

- R1-R10 have complete current evidence or explicit blockers; isolated ordinary chat/model/config/DB behavior preserved.
- Native latency target reported honestly; no unmeasured savings, skill ROI, global provider compatibility or publication claim.

### Required Capabilities

- repository_read
- command
- terminal_pty
- live_provider_access_when_authorized

### Traces To

- R1
- R2
- R3
- R4
- R5
- R6
- R7
- R8
- R9
- R10

### Verification

- kind: acceptance
- procedure: PROPOSED, NOT RUN: bun run typecheck once after integration; reuse valid focused task evidence. Inspect script/session-runtime-smoke.ts isolation then run bun run test:session-runtime:smoke if applicable. Run precise isolated PTY journeys above and record renderer/backend/provider/platform evidence separately.
- cwd: src/mendcode/packages/opencode
- preconditions: Execution separately authorized. Resolve T0 baseline and file ownership. Use installed supported dependencies. Tests/runtime use explicit fresh temporary MENDCODE_DB with package preload and must reject real-user paths; never run package tests at repository root.
- expected: R1-R10 have complete current evidence or explicit blockers; isolated ordinary chat/model/config/DB behavior preserved.; Native latency target reported honestly; no unmeasured savings, skill ROI, global provider compatibility or publication claim.
- evidence: .agents/plans/mendcode-beta4-fast-context-orchestration.T11.evidence.md


### Stop Condition

Stop affected work on contradictory baseline/interface, unsafe state/ownership, unapproved dependency/schema/provider change, missing essential capability, or failure_limit consecutive ineffective attempts; preserve evidence and revise the contract.

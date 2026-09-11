# Task packet: mendcode-next-beta-context-evidence

Source SHA-256: a400811fdbb52af5fcffb14c7603acad3e9b997e13815f2c29226e4bb4e052f4

## Goal

Deliver an opt-in successor to v0.1.44-beta.3 with structured session working state, truthful bounded context accounting, and reproducible release acceptance.

## Context

SUPERSEDED on 2026-09-07 by .agents/plans/mendcode-beta4-fast-context-orchestration.execution.json after the user changed the scope. Do not execute this older packet. Retained as historical planning context.

Baseline: published v0.1.44-beta.3, commit 995a6a67117adc7894924285fc8c051e3bd72001, verified through GitHub releases and ls-remote on 2026-09-07. Remote dev equals that commit; stable main is 234d4b6034085e1b78d5a73973c62ecc3150d09f. Authoring checkout dev is b5646990, ahead 4/behind 11 against its tracking ref, with concurrent prompt/TUI edits. Inspect committed baseline using git show 995a6a67:path; missing baseline files in the authoring checkout must not be recreated as a substitute for integration. Beta.1 already supplies opt-in async questions/read jobs, session_notes and release channels; beta.2 supplies bounded startup preparation; beta.3 supplies backend Smart Approval, context CLI, frozen per-turn memory and opt-in Code Mode. sessionNotes(directory, config) uses Mailbox.getRecord/putRecord in Database.transaction, kind note, version CAS, 16000-character text, session_recall flag. ContextCommand reads recent messages through withSharedClient, limit 1..100, partsLimit 100, 30-second timeout. contextReport reads step-finish metadata.contextProfile; provider missing metrics are null. processor stores per-step cost and also assistant cumulative cost: never add both. Memory snapshots are synthetic reference data, not permission authority. Package tests use Bun and package preload; set explicit MENDCODE_DB in a verified fresh temporary root, never active user state. No dependency installation is needed. Linear workspace ObeDev identity verified; MendCode exact lookup and Mend fragment empty, full ObeDev-team listing including archives exhausted with no matching project. Global workspace listing was partial; do not claim no project exists elsewhere. No external tracking writes authorized.

## Decisions

Proposed release label v0.1.44-beta.4, subject to maintainer selection and collision check at release time; no version change now. Scope: additive session_notes state, bounded CLI accounting, offline evaluation protocol and acceptance. Preserve all experimental defaults, manual model and reasoning selection, the shared database writer, and beta/stable schema guard. No automatic context reset, automatic routing, new model defaults, new dependencies, schema migration, remote executors, new TUI layout or inferred skill ROI. Research inspiration: https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/ (single/cascade/critic), https://developers.openai.com/codex/changelog (0.153 continuity primitives). These sources do not establish MendCode savings or runtime parity.

## Recovery

Planning only. On implementation, reconcile current source and ownership before edits; do not stash/reset/pull over concurrent changes. Stop affected tasks on baseline/interface contradiction and revise this packet. Preserve historical plain notes and beta databases. Revert only owned source changes; never restore or downgrade a real database automatically. Publication, paid model canaries and version selection need their separately authorized lifecycle.

## Requirements

- R1: Preserve beta.1-.3 compatibility and concurrent local work.
- R2: Read/write bounded structured working state with version conflicts and historical plain-text compatibility.
- R3: Report each observed step once, expose cost coverage and incomplete scope, never imply invoice or complete task-tree accounting.
- R4: Define reproducible evaluation by verified patch outcome, cost coverage, latency and edit scope without vendor-score-based promotion.
- R5: Accept only evidence-supported integrated behavior, preserve beta isolation and disclose inherited beta.3 acceptance gaps.

## Execution Policy


### Profile

backend

### Rationale

Existing shared-writer session state and bounded CLI accounting; additive metadata without schema migration.

### Locked Decisions


#### Entry 1


##### Decision

Build on beta.3, preserve defaults and manual model selection, use existing notes transaction and shared-client command.

##### Reason

These mechanisms already shipped; a second runtime/storage path would increase compatibility risk.

##### Invalidated By

Newer accepted beta supersedes baseline, storage lacks additive JSON support, or current callers disprove the declared contract.

#### Entry 2


##### Decision

Keep routing and full task-tree cost outside this beta; expose partial cost honestly.

##### Reason

Current context command reads a bounded message page; it cannot substantiate complete multi-agent accounting or routing savings.

##### Invalidated By

A verified existing tree ledger and permission-isolated execution contract become available; revise packet before expanding.

### Discretion

- Helper names, local error wording and fixture decomposition may vary while preserving fields, bounds, defaults, transactional behavior and observed tests.

### Escalation

- Conflicting dirty files or newer beta invalidate ownership/baseline: stop affected edits.
- Any required dependency/schema/provider change or authority expansion requires an updated contract; do not infer permission from this plan.

### Validation


#### Required Checks

- T0
- T1
- T2
- T3
- T4

#### Excluded Checks

- Full repository suite and browser runs by ceremony: no frontend layout or global refactor planned.
- Paid model matrix and release publication: separate authorization and concrete cost/version choices required.

#### Rerun When

- Relevant source/tests/dependencies/environment change, evidence is inadequate, or an assertion fails/is flaky.

#### Failure Limit

2

Policy semantics: preserve locked decisions unless current evidence invalidates them; use only the declared local discretion. On an escalation trigger, stop affected work and report the observation and required decision; continue independent authorized work.
Validation required_checks names task IDs, not a waiver of other mandatory criteria. Reuse successful evidence only when relevant source, dependencies, environment and coverage still match. failure_limit counts consecutive ineffective attempts at one criterion before revisiting diagnosis; it never turns missing or failed evidence into acceptance. Policy fields grant no extra edit, publication or device permissions.

## Execution and evidence

Planning state: draft. Execution has not started.
Closure owner: session_lead. Evidence: .agents/plans/mendcode-next-beta-context-evidence.evidence.json. State: .agents/plans/mendcode-next-beta-context-evidence.state.json.
Edit/new files scope product content. The evidence_file and each verification.evidence path authorize only named evidence artifacts; state_file names the execution state. Only the session lead aggregates evidence_file/state_file. Evidence outputs must not overwrite product/input files, existing unrelated artifacts or the planning source. Workers use distinct check-evidence files and required parent directories; no other output paths are implied.
Verify tools and permissions before work. Missing capabilities block only dependent criteria.
Record actual checks as PASS, FAIL, BLOCKED, NOT_RUN or NOT_APPLICABLE with evidence.

## T0 — Resolve implementation baseline and preserve existing work

### Work Kind

decision

### Depends On

None.

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/AGENTS.md
- src/mendcode/packages/opencode/test/AGENTS.md

### Edit Files

None.

### New Files

None.

### Symbols

- Git HEAD, remote dev/main and release targetCommitish

### Interfaces

- Implementation base must contain published beta.3; current dirty checkout is not that base.

### Inputs

- Live branch/release state and scoped diffs

### Outputs

- Recorded safe integration baseline and concurrent-file ownership

### Operation Order

1. Inspect git status including staged/unstaged/untracked and current releases/PRs.
2. Compare beta.3 with intended implementation revision and inventory overlapping edits.
3. Select a clean authorized execution surface or stop overlapping work; do not create an alternate worktree over an ownership blocker.

### Error Semantics

- An unavailable release/source or unresolved ownership blocks dependent edits; do not overwrite current work.

### Examples

- A newer beta containing this behavior requires narrowing or revising tasks.

### Counterexamples

- Implementing missing beta files from scratch on the stale checkout duplicates released work.

### Non Goals

- No publication, model switch, dependency installation, schema migration, global memory writes or automatic routing.

### Acceptance

- Baseline SHA, dirty-file inventory and implementation location are recorded; no unrelated work changed.

### Required Capabilities

- command
- repository_read

### Traces To

- R1

### Verification

- kind: acceptance
- procedure: PROPOSED; NOT RUN. Inspect git status --short --branch, git diff --name-only, git diff --cached --name-only, git ls-remote origin refs/heads/dev refs/heads/main; gh release list --limit 8 and gh pr list. Record a safe integration decision, not a runtime PASS.
- cwd: src/mendcode/packages/opencode
- preconditions: Implementation explicitly authorized; T0 baseline gate passed where applicable. Installed compatible tools. Any runtime/test uses fresh isolated DB with explicit MENDCODE_DB and package preload; no real user state.
- expected: Baseline SHA, dirty-file inventory and implementation location are recorded; no unrelated work changed.
- evidence: .agents/plans/mendcode-next-beta-context-evidence.evidence-T0.md


### Stop Condition

Stop affected work if source ownership conflicts, baseline contracts differ, isolation cannot be proved, or additional schema/dependency/authority is required; record the evidence and revise the contract.

## T1 — Add structured state to versioned session notes

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/tool/session-notes.ts
- src/mendcode/packages/opencode/src/tool/continuity.ts
- src/mendcode/packages/opencode/src/session/runtime-mailbox.ts
- src/mendcode/packages/opencode/src/session/context-memory.ts
- src/mendcode/packages/opencode/test/session/session-notes.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/tool/session-notes.ts
- src/mendcode/packages/opencode/src/session/working-state.ts
- src/mendcode/packages/opencode/test/session/session-notes.test.ts
- src/mendcode/packages/opencode/test/session/working-state.test.ts

### New Files

- src/mendcode/packages/opencode/src/session/working-state.ts
- src/mendcode/packages/opencode/test/session/working-state.test.ts

### Symbols

- sessionNotes(directory, config)
- Mailbox.getRecord/putRecord
- new parseWorkingState(value)

### Interfaces

- Extend parameters additively with state?: WorkingStateV1; write accepts exactly one of text or state plus current version. Read response retains version,text,current_version and adds state: WorkingStateV1|null.
- WorkingStateV1={schemaVersion:1,goal:string,decisions:Entry[],facts:Entry[],failedApproaches:Entry[],acceptance:Entry[],nextActions:Entry[]}; Entry={text:string,source:string}. Reject unknown keys. Max 32 entries per list; goal/text 2000 characters each, source 256; JSON serialization plus readable text <=16000 characters.
- Structured writes persist state alongside deterministic readable text in existing record.data; no SQL changes. Plain writes replace state with null. Historical versions return their own state, absent means null.

### Inputs

- Read/write action; session ID from Tool.Context; CAS version; optional structured state.

### Outputs

- Atomic versioned record and deterministic readable text in fixed order goal, decisions, facts, failed approaches, acceptance, next actions.

### Operation Order

1. Check session_recall before access. Validate action, exactly-one payload, shape, sizes and nonnegative safe CAS integer.
2. Within existing transaction compare head version, increment once, write historical record and head with identical payload.
3. Read historical/head state without cross-session lookup; structured state is retrieved by session_notes, not automatically injected or granted authority.

### Error Semantics

- Malformed state, oversized serialization, stale or missing version and unknown history fail without writes. Legacy plain reads return state:null.
- Aborted tool before transaction performs no write; transaction is synchronous and atomic once entered. No background writes.

### Examples

- Write version 0 with goal Fix queue and a failedApproaches entry produces version 1; stale version 0 fails and leaves version 1.
- Plain notes remain byte-for-byte readable after upgrade; structured version followed by plain replacement does not retain stale state.

### Counterexamples

- Parsing arbitrary legacy text as JSON or injecting state as a new user permission changes trust/compatibility.

### Non Goals

- No publication, model switch, dependency installation, schema migration, global memory writes or automatic routing.

### Acceptance

- CAS, legacy history, empty arrays, oversized fields, unknown keys, cancel-before-write and cross-session isolation are asserted.
- Restart isolated backend and read identical stored state; session_recall off rejects writes; no automatic feature activation or new schema.

### Required Capabilities

- code
- command

### Traces To

- R1
- R2

### Verification

- kind: text_test
- procedure: PROPOSED; NOT RUN. bun test test/session/session-notes.test.ts test/session/working-state.test.ts --timeout 30000; extend the existing Effect fixtures to verify persisted reload across instance disposal. Run bun run typecheck after integrated source changes, once unless invalidated.
- cwd: src/mendcode/packages/opencode
- preconditions: Implementation explicitly authorized; T0 baseline gate passed where applicable. Installed compatible tools. Any runtime/test uses fresh isolated DB with explicit MENDCODE_DB and package preload; no real user state.
- expected: CAS, legacy history, empty arrays, oversized fields, unknown keys, cancel-before-write and cross-session isolation are asserted.; Restart isolated backend and read identical stored state; session_recall off rejects writes; no automatic feature activation or new schema.
- evidence: .agents/plans/mendcode-next-beta-context-evidence.evidence-T1.md


### Stop Condition

Stop affected work if source ownership conflicts, baseline contracts differ, isolation cannot be proved, or additional schema/dependency/authority is required; record the evidence and revise the contract.

## T2 — Make recent context accounting explicit and duplicate-safe

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/cli/cmd/context.ts
- src/mendcode/packages/opencode/src/session/context-profile.ts
- src/mendcode/packages/opencode/src/session/processor.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/test/session/context-profile.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/cli/cmd/context.ts
- src/mendcode/packages/opencode/src/session/context-profile.ts
- src/mendcode/packages/opencode/test/session/context-profile.test.ts
- src/mendcode/packages/opencode/test/cli/context-report.test.ts

### New Files

- src/mendcode/packages/opencode/test/cli/context-report.test.ts

### Symbols

- ContextCommand
- contextReport(messages)
- contextProfile(value)
- step-finish part.id and part.cost

### Interfaces

- Retain report version:1 and all request fields; add stepID:string|null per row, and summary:{scope:"recent_messages",completeTask:false,observedSteps:number,profiledSteps:number,knownCostSteps:number,unknownCostSteps:number,knownCostUsd:number,totalCostUsd:number|null}.
- Count unique step-finish records by part ID within session; conflicting duplicate ID fails explicitly. Missing IDs remain separate observed rows; no guessed identity. Include costs from observed step-finish without profiles in summary, retain request rows only for valid profiles.
- Cost is finite nonnegative stored step cost, API-equivalent estimate; missing/nonfinite/negative is unknown. totalCostUsd is null when any cost is unknown or no steps observed; otherwise equals knownCostUsd for observed steps only. CLI always labels bounded recent-message scope, no children/retries-before-step-finish, and no billing completeness.

### Inputs

- Bounded backend message page and persisted step metadata; existing limit remains 1..100 and timeout 30 seconds.

### Outputs

- Additive JSON summary and concise plain-text coverage line; no new backend endpoint or DB writer.

### Operation Order

1. Collect/deduplicate observed step-finish IDs and validate conflicts.
2. Compute cost coverage once per step independently of profile coverage; preserve null usage metrics.
3. Render current detail rows and summary without unbounded pagination or child traversal.

### Error Semantics

- Backend failure remains an error; empty page reports zero observed, null total and empty requests.
- Do not add message.info.cost to step costs. No pricing lookup or estimated replacement for unavailable provider metrics.

### Examples

- Two distinct steps cost .01 and .02 plus duplicate first ID yield .03, observedSteps 2; an extra unknown-cost step makes totalCostUsd null while knownCostUsd stays .03.
- A page capped at 20 messages remains completeTask:false even when every observed cost is known.

### Counterexamples

- Calling a partial page Total task cost, or treating a failed request with no recorded step as free, is incorrect.

### Non Goals

- No publication, model switch, dependency installation, schema migration, global memory writes or automatic routing.

### Acceptance

- Assertions cover duplicate/conflicting IDs, absent profiles, missing IDs, invalid costs, empty page, unknown usage and JSON/text compatibility.
- Command uses shared backend, preserves limit/error semantics and explicitly labels partial cost.

### Required Capabilities

- code
- command

### Traces To

- R1
- R3

### Verification

- kind: text_test
- procedure: PROPOSED; NOT RUN. bun test test/session/context-profile.test.ts test/cli/context-report.test.ts --timeout 30000; CLI test stubs the shared-client HTTP boundary and checks non-2xx behavior and rendered labels. Integrated acceptance separately checks a real isolated backend.
- cwd: src/mendcode/packages/opencode
- preconditions: Implementation explicitly authorized; T0 baseline gate passed where applicable. Installed compatible tools. Any runtime/test uses fresh isolated DB with explicit MENDCODE_DB and package preload; no real user state.
- expected: Assertions cover duplicate/conflicting IDs, absent profiles, missing IDs, invalid costs, empty page, unknown usage and JSON/text compatibility.; Command uses shared backend, preserves limit/error semantics and explicitly labels partial cost.
- evidence: .agents/plans/mendcode-next-beta-context-evidence.evidence-T2.md


### Stop Condition

Stop affected work if source ownership conflicts, baseline contracts differ, isolation cannot be proved, or additional schema/dependency/authority is required; record the evidence and revise the contract.

## T3 — Author a reproducible evaluation and release canary protocol

### Work Kind

artifact

### Depends On

- T1
- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/test/session/continuity.test.ts
- src/mendcode/packages/opencode/test/mend/code-mode.test.ts
- src/mendcode/packages/opencode/test/mend/smart-service.test.ts
- src/mendcode/packages/opencode/script/session-runtime-smoke.ts

### Edit Files

- docs/beta-context-evaluation.md

### New Files

- docs/beta-context-evaluation.md

### Symbols

- No new runtime entry point; protocol artifact only

### Interfaces

- Evaluation record: case ID, fixture revision, model/provider/effort chosen by user, harness revision, attempt IDs, verification outcome, patch diff, wall time milliseconds, observed cost USD or null, coverage, cancellation and tool failures.

### Inputs

- Beta.3 baseline and candidate; sanitized disposable fixtures; existing test procedures.

### Outputs

- New docs/beta-context-evaluation.md with complete proposed protocol; evidence artifact records its review, never fabricated benchmark results.

### Operation Order

1. Define 12 cases: two each for repository repair, terminal/cancellation, context continuity, permissions, cache accounting, minimal edits. Store exact fixture inputs and oracle before comparing candidates.
2. Run deterministic fake-provider cases first during implementation; model canaries require explicit provider choice and cost budget. No automated model switch.
3. For approved paid canaries compare same fixtures/model/effort/limits: three attempts per case, sequential, fixed time/token/cost caps selected before calls. Sum all attempts and descendants once; missing usage makes total unknown.
4. Use accepted patches with oracle PASS as denominator; zero successes gives unavailable cost-per-accepted-patch. Record files/lines changed, allowed-path violations and unnecessary edits separately from correctness.
5. Include negative controls: incomplete tool call, hostile note text posing as permission, duplicated usage, stale note version, cancelled job and terminal error before EOF. These are test cases, not proven existing defects.

### Error Semantics

- No credentials/budget means paid comparison NOT_RUN; deterministic protocol remains useful. A missing cost is never zero.
- Hypothesized SSE defect needs reproduction before a repair task is added.

### Examples

- An incorrect patch with lower cost is not an improvement; a zero-edit failed run is not minimal successful work.

### Counterexamples

- Vendor benchmark rank or a single successful run cannot promote a default model or prove skill ROI.

### Non Goals

- No publication, model switch, dependency installation, schema migration, global memory writes or automatic routing.

### Acceptance

- Protocol defines inputs/oracles, matched revisions, bounded execution, privacy and honest missing-data accounting.
- No speed/savings/default-model claim is made without measured comparable evidence.

### Required Capabilities

- command
- repository_read

### Traces To

- R4

### Verification

- kind: acceptance
- procedure: PROPOSED; NOT RUN. Inspect the 12-case protocol for independent oracles and baseline/candidate parity. Record deterministic executed cases separately from NOT_RUN paid cases. Reuse T1/T2 evidence for matching cases; do not rerun merely for a new report.
- cwd: src/mendcode/packages/opencode
- preconditions: Implementation explicitly authorized; T0 baseline gate passed where applicable. Installed compatible tools. Any runtime/test uses fresh isolated DB with explicit MENDCODE_DB and package preload; no real user state.
- expected: Protocol defines inputs/oracles, matched revisions, bounded execution, privacy and honest missing-data accounting.; No speed/savings/default-model claim is made without measured comparable evidence.
- evidence: .agents/plans/mendcode-next-beta-context-evidence.evidence-T3.md


### Stop Condition

Stop affected work if source ownership conflicts, baseline contracts differ, isolation cannot be proved, or additional schema/dependency/authority is required; record the evidence and revise the contract.

## T4 — Accept integrated candidate and document release gates

### Work Kind

acceptance

### Depends On

- T0
- T1
- T2
- T3

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/tool/session-notes.ts
- src/mendcode/packages/opencode/src/cli/cmd/context.ts
- src/mendcode/packages/opencode/test/session/continuity.test.ts
- src/mendcode/packages/opencode/test/mend/code-mode.test.ts
- src/mendcode/packages/opencode/test/mend/smart-service.test.ts
- src/mendcode/packages/opencode/script/session-runtime-smoke.ts

### Edit Files

None.

### New Files

None.

### Symbols

- Session notes, ContextCommand, beta channel and shared writer

### Interfaces

- Acceptance statuses PASS|FAIL|BLOCKED|NOT_RUN; packaging/publication is a later explicitly authorized operation.

### Inputs

- Integrated source fingerprint, T1/T2 checks, T3 protocol and inherited beta.3 release limitations.

### Outputs

- Requirement/evidence matrix and release readiness decision in aggregate evidence file; no release created.

### Operation Order

1. Review current diff and fingerprints; reuse unchanged successful evidence.
2. On isolated backend write/read structured notes, reconnect second client, and inspect context JSON after a fake-provider step; verify no second writer and preserved version.
3. Run existing session runtime smoke only after inspecting its isolation inputs; exercise terminal completion/cancellation and existing continuity tests.
4. Keep inherited native keyboard, Smart Approval TUI and Code Mode resource/permission lifecycle gaps explicit: do not enable or claim these mature without dedicated evidence.
5. Before any later publication recheck release tag collision and maintainer-selected version, beta channel, frozen locks/security gates, pinned installers, archive checksums/attestations, isolated installer and platform coverage. No stable database downgrade.

### Error Semantics

- Missing new-feature integration evidence blocks candidate acceptance. Inherited opt-in feature gaps require unchanged limitation text and defaults; enabling them requires a separate revised acceptance contract.
- No publication authorization leaves publication NOT_RUN, not failed implementation.

### Examples

- Unit PASS plus shared-backend failure is not accepted. Unchanged opt-in Code Mode limitations must remain in beta notes.

### Counterexamples

- A source-only review cannot claim packaged/native acceptance; previous beta checksums do not validate this candidate.

### Non Goals

- No publication, model switch, dependency installation, schema migration, global memory writes or automatic routing.

### Acceptance

- R1-R5 have current evidence or explicit blocked status; no missing new-feature criterion marked PASS.
- No product changes beyond declared scope; beta/stable guards and experimental defaults retained; release remains pending separately authorized lifecycle.

### Required Capabilities

- command
- repository_read

### Traces To

- R1
- R2
- R3
- R4
- R5

### Verification

- kind: acceptance
- procedure: PROPOSED; NOT RUN. bun test test/session/continuity.test.ts test/mend/code-mode.test.ts test/mend/smart-service.test.ts --timeout 30000 only where changed boundaries invalidate earlier evidence; bun run test:session-runtime:smoke after verifying explicit isolated DB. Inspect integrated CLI/backend behavior using fake provider and two clients; record exact commands and platform.
- cwd: src/mendcode/packages/opencode
- preconditions: Implementation explicitly authorized; T0 baseline gate passed where applicable. Installed compatible tools. Any runtime/test uses fresh isolated DB with explicit MENDCODE_DB and package preload; no real user state.
- expected: R1-R5 have current evidence or explicit blocked status; no missing new-feature criterion marked PASS.; No product changes beyond declared scope; beta/stable guards and experimental defaults retained; release remains pending separately authorized lifecycle.
- evidence: .agents/plans/mendcode-next-beta-context-evidence.evidence-T4.md


### Stop Condition

Stop affected work if source ownership conflicts, baseline contracts differ, isolation cannot be proved, or additional schema/dependency/authority is required; record the evidence and revise the contract.

# Task packet: smart-approval-real

Source SHA-256: 0ee9aa8fe1aef5110d59ec995a11adf0ed321a1c94ced87e005a07bfde0fd484

## Goal

Make Smart Approval a backend-owned, context-aware permission system that safely removes unnecessary manual prompts and keeps the terminal interface quiet.

## Context

Planning only, based on inspected code on 2026-09-05. Shared dev HEAD b5646990dbc48d3326049e299f5cb9355a9212f8 is ahead 4/behind 10 against fetched origin/dev 4d80b13ca70973b67bfa2ac691f244365b915966 and contains unrelated dirty/concurrent edits. Core permission/shell/smart reviewer files match origin/dev; reasoning widget row exists on origin/dev. Execute only after a separate implementation request, in an isolated checkout of the then-verified origin/dev; reconcile changed contracts before edits. Existing .agents/global/context.md's August all-shell-review policy is superseded by this proposed contract only when implementation is authorized. Current Smart Approval is TUI-owned, forces every shell request into review and filters model allows back to strict read-only patterns; no OS shell sandbox was demonstrated. Current provider adapter has uncancelled fetches and a synchronous generic child. Existing permission persistence is version-2 JSON in PermissionTable; human reject currently fans out within a session. The screenshot is a symptom, not a runtime reproduction. Research references and rationale are in .agents/plans/smart-approval-real.md.

## Decisions

ActionFactsV1 is host-produced and immutable: full command, dialect, canonical cwd, normalized AST/argv segments, read/write targets, destinations, executable/script identities, effective-environment keyed digest (never values), effect set, analysisComplete, unknownReasons and actionFingerprint. Maximum 32 KiB command and 256 AST nodes; overflow or unsupported grammar asks manually without approving a truncated representation. Reuse shell.ts tree-sitter grammars. Absolute paths inside the authorized root are valid after canonicalization; outside roots remain a separate permission. Freeze plugin-adjusted effective environment before review and use it at spawn; revalidate executable/script/target identities and context/policy revisions immediately before spawn. A changed identity requires a fresh decision. This narrows races but is not OS isolation or a TOCTOU guarantee.

AuthorityContextV1 resolves tool.messageID/callID to the actual assistant parent user message in MessageV2, includes the active objective's root and subsequent explicit user constraints with IDs and host provenance, excludes synthetic/ignored/peer messages and private reasoning, and treats tool output/attachments as data only. Budget 12 actual user anchors/24 KiB; if necessary scope or constraints cannot fit, ask. A host objective epoch is created at explicit task start/reset; corrective user input increments context revision and invalidates in-flight decisions/grants. Do not infer authority from the latest unrelated message or a model-written objective summary.

DecisionV1: decision allow|ask|deny, risk low|medium|high|critical|unknown, authorization explicit|implicit|none|unknown, reasonCode, summary <=160 characters, source deterministic|grant|model|manual, sourceUserIDs, actionFingerprint, contextRevision, policyRevision, elapsedMs, usage/cost nullable. Effective configured deny is final; preserve existing ruleset matching semantics. Fast lane covers only completely understood low-risk effects within configured boundaries; a known executable name alone is insufficient. Medium-risk allows need explicit causal authority plus deterministic bounded effects. High/critical/unknown risk cannot be model-auto-allowed. Task grants cannot override configured denies or changing context. Unknown/malformed/timeout means ask, never a fabricated malicious verdict.

Backend Permission.Service owns persisted pending_review -> waiting_manual|allowed|denied|cancelled transitions. A transaction/CAS claims each request and compares owner runtime, fingerprint, context and policy revision at completion. Never hold a transaction across provider work. Resolve only that request's Deferred; smart rejection must not fan out to sibling requests. Emit permission.asked only after waiting_manual, so run.ts cannot reject while the backend is reviewing; list/status expose pending_review. One model call per session, two per project, queue max eight, queue deadline 60s, provider deadline 20s; saturation/expiry asks manually. Cancellation on manual response, session abort, mode change, teardown and owner loss aborts provider transport/child and discards late results. Three consecutive model denials in a turn suspend further model auto-decisions until explicit human resume; no automatic denial retry. Restart interrupts reviews, expires task grants, and never replays tools.

Store an additive optional smart:{version:1,grants,reviews} envelope in existing version-2 PermissionTable JSON; no SQL/schema migration. Grant = host-generated id, project/session/objective epoch, exact normalized action fingerprint/effects/cwd/targets/executable and script identities, context/policy revision, createdAt, expiresAt=min(30 minutes, objective end), revokedAt. Only explicit human Allow for this task creates it; allow once does not. Model allow never persists permissions. A different action/context/environment/script invalidates reuse. Keep at most 100 review records per session and 500 per project, summaries <=160 chars and hashed identifiers; no command secrets, environment values or full transcripts in audit. Bound grants to 100 active per project, reject new grants at the cap with an actionable manual-once option. Old or malformed envelopes drop to manual; preserve legacy approved rules unchanged.

Extend provider input with optional AbortSignal, deadline and maximum response budget (2048 output tokens where supported plus bounded byte collection); preserve all existing role/model/auth selection. Thread cancellation through API and subscription fetch and replace only generic adapter spawnSync execution with an owned asynchronous child, bounded stdout/stderr and termination/reaping. Review calls are toolless, strict schema, one call, no retry and no subagent. Cancellation and timeout are separate reason codes; unsupported transport cancellation must be reported and cannot pass lifecycle acceptance.

Permission requests expose versioned smart metadata {version:1,status,actionFingerprint,contextRevision,reviewSummary?,manualChallenge?}; fields are server-authored, never trusted from tool metadata. POST /permission/:requestID/reply keeps reply/message and adds smart:{version:1,actionFingerprint,contextRevision,manualChallenge,grant:'once'|'task'} for smart allows; challenge is issued only at waiting_manual and invalidated on any state change. Legacy allows for server-managed smart requests return 409 SMART_CLIENT_UPGRADE_REQUIRED; rejection remains exact and safe. New TUI never runs local review. Older TUI may attempt its old reviewer but its allow cannot resolve a managed request; show upgrade need through error and document incompatibility. Manual/full_access contracts and non-smart clients remain unchanged. GET /permission/reviews requires sessionID, opaque cursor and limit default50/max100, returns {items,nextCursor}; POST /permission/grants/:grantID/revoke returns {revoked:boolean}, idempotent for already-revoked existing grants, 404 for unknown/out-of-project ids. Match project/session ownership with existing authenticated instance middleware. Implement identical schemas/status codes in Hono and Effect and regenerate SDK from observed generator.

Remove only the session prompt-area Show/text rendering widgetReasoningLabel above RenderWidgets; retain reasoning state, algorithm, selector and any intentional Info detail. Automatic allow and ask produce no toast. Existing permission.tsx panel shows 'Permission required', action, a <=160-character reason, risk and exact scope; Details expands local explanation. Actions: Allow once, Allow for this task, Reject; disable task grant when the exact scope cannot be represented. Pending reviewing is a subtle existing status item with cancel, no duplicate panel or new top banner. Ctrl+T tray gains Smart Approval details/history and revoke controls using existing widget composition. Preserve typed prompt, editor focus, parked hover ownership, scroll position and bottom keybar on asynchronous updates.

ActionFactsV1 is a discriminated union: kind=shell has command/dialect/AST; kind=native_file has trusted built-in read/edit/write/apply_patch identity, canonical source/destination paths, operation create/update/read/move/delete and before/after content digests. Native facts are assembled by host code from validated inputs and the actual prepared changes, not from a client metadata assertion or trimmed display diff. Include formatter/post-write executable effects; unknown project formatter or hook means incomplete analysis and manual permission. Revalidate file identity/content immediately before applying the prepared change. Deletion remains high-risk/manual. Other tool/MCP families retain existing configured rules/manual behavior until they have an independently proven action adapter; do not apply the shell fast lane to arbitrary metadata.

## Recovery

Stop affected work if the current base contradicts these contracts. Keep an isolated checkout and focused patches; preserve all concurrent shared edits. No stash/reset/clean, release, deploy, secret changes or model selection. Roll back only owned changes; switch Smart mode to manual behavior on runtime reviewer failure, never to full_access. Persist interruption explicitly and do not replay tools.

## Requirements

- R1: Smart mode automatically permits understood, bounded low-risk diagnostics without requiring the user to spell shell syntax; effective configured denies remain final and approval/full_access modes preserve their contracts.
- R2: Decisions use immutable structured action facts and host-resolved causal user authority. Risk and authorization are distinct; unknown facts, prompt injection, stale context and unsupported syntax cannot produce automatic permission.
- R3: One backend owner reviews each request across TUI, headless and workflow clients, with bounded cancellable work, exact-request resolution, durable atomic transitions and no late-result execution.
- R4: An explicitly authorized bounded medium-risk task can be automatically permitted; high/critical/unknown risk or insufficient authority requires precise human permission or an applicable hard deny. Model output never overrides boundaries.
- R5: Human permission can be once or an exact task grant with expiry and revocation; automatic decisions never create broad or permanent grants. Audit data is bounded and excludes secrets and prompt transcripts.
- R6: The TUI presents concise actionable permissions without Smart Approval toasts, preserves prompt and activity controls, removes the Last request reasoning row, and provides optional details/history in the existing panel and Ctrl+T tray.
- R7: Equivalent Hono/Effect/SDK behavior, old-client fail-closed compatibility, API/OAuth transport parity and isolated focused evidence cover legitimate actions, unsafe actions, lifecycle races and visual states.
- R8: Freeze a baseline corpus before implementation; reduce unnecessary manual prompts by at least two thirds on eligible legitimate cases while producing zero unsafe automatic permissions on the risk corpus. Report real provider and PTY evidence separately from deterministic tests.

## Design Contract


### Intent

Keep normal chat and prompt readable while offering precise human control only when Smart Approval cannot safely resolve the requested action.

### Baseline

Inspected screenshot shows a long top-right Smart Approval toast and Last request: Manual max immediately above Thinking Activity. origin/dev uses widgetReasoningLabel in the session prompt area and an existing Ctrl+T widget tray.

### Delta


#### Preserve

- Existing green theme, chat/editor geometry, Activity controls, reasoning selection and Ctrl+T tray.

#### Add

- Concise exact permission actions, expandable reason, and history/revoke in the existing tray.

#### Change

- Permission UI consumes backend review state instead of launching client reviews.

#### Remove

- Long Smart Approval allow/ask toasts and the Last request row above Activity.

### References


#### Reference 1


##### Source

User-provided screenshot inspected in this conversation; sanitized symptom and geometry reproduced in baseline T0.

##### Status

inspected

##### Take

Preserve the chat, green accents, bottom editor and horizontal Activity placement.

##### Avoid

Do not copy the intrusive toast or the redundant reasoning row.

#### Reference 2


##### Source

.agents/tui-standard.md and src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx

##### Status

inspected

##### Take

Existing theme tokens, single border, padding 1, keybar and focus/hover ownership.

##### Avoid

No new decorative cards, top banner, theme palette or permanent extra status row.

### Composition

- Normal chat remains the primary region; only the existing permission panel expands when human input is needed.
- Details is secondary; history/grants belong inside Ctrl+T. The bottom editor and Activity retain their ordering after the reasoning row is removed.

### Tokens

- Use existing useTheme/theme.text, theme.textMuted, theme.border and semantic success/warning/error tokens as supported by the inspected components; no hardcoded new RGB palette.
- Retain single-line borders, one-cell panel padding and current terminal typography. Reason summary max160 characters; wrap inside available panel width.

### Content

- Permission required; Allow once; Allow for this task; Reject; Details; Revoke. Keep product copy neutral English.
- Show actual action scope and backend reason, never invented safety percentages or hidden reasoning.

### States

- Reviewing is cancellable and subtle; allowed is quiet.
- Manual ask displays reason and exact actions; long detail is collapsed.
- Stale grant/context refreshes inline; transport failure exposes manual options; revoked/expired grants cannot be reused.

### Adaptation

- At 80x24, prioritize action/reason/buttons and scroll details within the existing panel without hiding the editor. At 120x36 and 200x50 retain alignment and bounded text width.
- Keyboard focus, typed prompt, detached scroll and parked hover remain stable under asynchronous updates; every action has a visible focus state.

### Acceptance

- T5 implements each state; T7 captures and inspects actual PTY frames/interactions at all three sizes; T8 closes only with that evidence.
- No Last request row or Smart Approval ask/allow toast; reasoning selection and Activity continue to work.

## Execution Policy


### Profile

backend

### Rationale

Permission authority and execution effects require bounded integration/race tests; focused real PTY and small authorized provider samples cover the separate UI/model gaps. No full suite or deployment is justified by this scope.

### Locked Decisions


#### Entry 1


##### Decision

Backend owns all Smart decisions and exact lifecycle transitions; TUI only renders and submits explicit manual actions.

##### Reason

Current client-owned review fails across disconnection/headless/multiple clients.

##### Invalidated By

Current source already has a different authoritative engine; reconcile and reuse it rather than installing a second owner.

#### Entry 2


##### Decision

Use causal host authority plus complete action facts; deterministic low-risk lane and bounded medium-risk authorization; no model override of configured denies.

##### Reason

String allowlists and a permissive prompt cannot safely distinguish authorized work from injected or ambiguous actions.

##### Invalidated By

Parser, executable provenance or host message schema cannot support the promised facts; affected actions remain manual pending a revised contract.

#### Entry 3


##### Decision

No OS sandbox or broad persistent auto-grants; add optional bounded data to existing permission JSON.

##### Reason

Scope is permission intelligence, and no shell isolation was demonstrated.

##### Invalidated By

Current persistence or runtime isolation differs; inspect actual boundaries before revising storage or claims.

#### Entry 4


##### Decision

Preserve existing role/model/auth selection and concise existing TUI layout.

##### Reason

User requested smarter approvals and removal of a redundant label, not model switching or UI redesign.

##### Invalidated By

User supplies a new explicit provider or design requirement.

### Discretion

- Choose internal pure helper names, local data structures and Effect service wiring while preserving the declared contracts.
- Use observed theme tokens and widget primitives; choose concise wording within the 160-character limit.
- Adjust generator-owned output paths only to actual generator output; record the scoped path correction.
- Refine deterministic grammar support only when effects and provenance are completely proven with positive and adversarial tests; otherwise keep manual.

### Escalation

- Stop affected work on authority/persistence/source contradictions, missing required sandbox facts, incompatible package tooling or additional external cost. Provide evidence and the narrow decision needed.
- Do not switch models, infer user grant from untrusted data, add broad permissions, repair unrelated baseline errors or publish.

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

#### Excluded Checks

- Full repository suites/builds and browser testing: permission service fixtures plus actual PTY cover this scope; expand only for a concrete uncovered regression.
- OS isolation, production deployment and cross-machine security certification are outside this plan and must never be implied by permission tests.

#### Rerun When

- Relevant code, tests, dependencies or runtime changed; evidence failed/flaked; missing assertions or integration changes invalidate prior results.

#### Failure Limit

3

Policy semantics: preserve locked decisions unless current evidence invalidates them; use only the declared local discretion. On an escalation trigger, stop affected work and report the observation and required decision; continue independent authorized work.
Validation required_checks names task IDs, not a waiver of other mandatory criteria. Reuse successful evidence only when relevant source, dependencies, environment and coverage still match. failure_limit counts consecutive ineffective attempts at one criterion before revisiting diagnosis; it never turns missing or failed evidence into acceptance. Policy fields grant no extra edit, publication or device permissions.

## Execution and evidence

Planning state: draft. Execution has not started.
Closure owner: session_lead. Evidence: .agents/plans/smart-approval-real.evidence.json. State: .agents/plans/smart-approval-real.state.json.
Edit/new files scope product content. The evidence_file and each verification.evidence path authorize only named evidence artifacts; state_file names the execution state. Only the session lead aggregates evidence_file/state_file. Evidence outputs must not overwrite product/input files, existing unrelated artifacts or the planning source. Workers use distinct check-evidence files and required parent directories; no other output paths are implied.
Verify tools and permissions before work. Missing capabilities block only dependent criteria.
Record actual checks as PASS, FAIL, BLOCKED, NOT_RUN or NOT_APPLICABLE with evidence.

## T0 — Establish the actual runtime baseline and frozen corpus

### Work Kind

decision

### Depends On

None.

### Parallel Group

None.

### Read First

- .agents/global/context.md
- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/src/tool/shell.ts
- src/mendcode/packages/opencode/src/mend/tui/widgets-runtime.tsx

### Edit Files

None.

### New Files

None.

### Symbols

- reviewPermissionRequestWithModel
- Permission.Service
- widgetReasoningLabel

### Interfaces

- Baseline record contains checkout/runtime version, fingerprints, mode/role ids without secrets, exact screenshot command and per-case expected permission.

### Inputs

- Current source, user screenshot and installed runtime after authorization.

### Outputs

- Baseline and immutable corpus identities in task evidence; no product changes.

### Operation Order

1. Create an isolated checkout from current verified origin/dev and measure divergence; do not transplant unrelated dirty edits.
2. Reproduce screenshot diagnostics in an isolated session; distinguish the installed runtime from the source checkout.
3. Freeze at least 18 legitimate cases and 18 unsafe/ambiguous cases with independent expected outcomes before policy edits. Record baseline unnecessary manual prompts. Include positive build/test/write cases and command-v/if/version diagnostics.

### Error Semantics

- If exact screenshot command is unavailable, capture it from a new reproduction; mark original-command parity unproven.
- If baseline legitimate false prompts = 0, relative reduction is undefined: report absolute rates and reconcile R8 before acceptance.

### Examples

- A scoped environment inspection can legitimately use printf, uname, command -v and known binary --version without exact user CLI syntax.

### Counterexamples

- Treating a toast or source search as a successful runtime reproduction.

### Non Goals

- No implementation, publication or provider/model changes in this baseline task.

### Acceptance

- Baseline corpus is frozen, annotated and fingerprinted before T1; runtime provenance is explicit.

### Required Capabilities

- code-read
- command
- terminal

### Traces To

- R1
- R7
- R8

### Verification

- kind: text_test
- procedure: Inspect current git/runtime and reproduce the bounded diagnostics only in an isolated test session; record exact commands, events, screenshots and outcomes in T0 evidence.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: A reproducible baseline separates legitimate prompts, legitimate approvals and unsafe cases.
- evidence: .agents/plans/smart-approval-real-evidence/T0.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T1 — Extract trustworthy action facts and causal authority

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/tool/shell.ts
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/session/message-v2.ts
- src/mendcode/packages/opencode/src/session/agent-command.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
- src/mendcode/packages/opencode/src/tool/read.ts
- src/mendcode/packages/opencode/src/tool/edit.ts
- src/mendcode/packages/opencode/src/tool/write.ts
- src/mendcode/packages/opencode/src/tool/apply_patch.ts

### Edit Files

- src/mendcode/packages/opencode/src/tool/shell.ts
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/tool/shell-analysis.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-context.ts
- src/mendcode/packages/opencode/test/mend/smart-context.test.ts
- src/mendcode/packages/opencode/test/tool/shell-analysis.test.ts
- src/mendcode/packages/opencode/src/tool/read.ts
- src/mendcode/packages/opencode/src/tool/edit.ts
- src/mendcode/packages/opencode/src/tool/write.ts
- src/mendcode/packages/opencode/src/tool/apply_patch.ts

### New Files

- src/mendcode/packages/opencode/src/tool/shell-analysis.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-context.ts
- src/mendcode/packages/opencode/test/mend/smart-context.test.ts
- src/mendcode/packages/opencode/test/tool/shell-analysis.test.ts

### Symbols

- parse
- collectCommands
- SessionPrompt tool context
- MessageV2.get
- ActionFactsV1
- AuthorityContextV1

### Interfaces

- ActionFactsV1 is host-produced and immutable: full command, dialect, canonical cwd, normalized AST/argv segments, read/write targets, destinations, executable/script identities, effective-environment keyed digest (never values), effect set, analysisComplete, unknownReasons and actionFingerprint. Maximum 32 KiB command and 256 AST nodes; overflow or unsupported grammar asks manually without approving a truncated representation. Reuse shell.ts tree-sitter grammars. Absolute paths inside the authorized root are valid after canonicalization; outside roots remain a separate permission. Freeze plugin-adjusted effective environment before review and use it at spawn; revalidate executable/script/target identities and context/policy revisions immediately before spawn. A changed identity requires a fresh decision. This narrows races but is not OS isolation or a TOCTOU guarantee.
- AuthorityContextV1 resolves tool.messageID/callID to the actual assistant parent user message in MessageV2, includes the active objective's root and subsequent explicit user constraints with IDs and host provenance, excludes synthetic/ignored/peer messages and private reasoning, and treats tool output/attachments as data only. Budget 12 actual user anchors/24 KiB; if necessary scope or constraints cannot fit, ask. A host objective epoch is created at explicit task start/reset; corrective user input increments context revision and invalidates in-flight decisions/grants. Do not infer authority from the latest unrelated message or a model-written objective summary.
- ActionFactsV1 is a discriminated union: kind=shell has command/dialect/AST; kind=native_file has trusted built-in read/edit/write/apply_patch identity, canonical source/destination paths, operation create/update/read/move/delete and before/after content digests. Native facts are assembled by host code from validated inputs and the actual prepared changes, not from a client metadata assertion or trimmed display diff. Include formatter/post-write executable effects; unknown project formatter or hook means incomplete analysis and manual permission. Revalidate file identity/content immediately before applying the prepared change. Deletion remains high-risk/manual. Other tool/MCP families retain existing configured rules/manual behavior until they have an independently proven action adapter; do not apply the shell fast lane to arbitrary metadata.

### Inputs

- Raw command and dialect from host tool invocation; causal message ids and actual plugin-adjusted execution environment.

### Outputs

- Pure action analyzer and backend context resolver with revision/fingerprint inputs.

### Operation Order

1. Extract existing grammar loading/AST walk into reusable analyzer without changing shell execution semantics.
2. Resolve canonical cwd, identities and effect facts; support the narrow diagnostic grammar including simple if command-v guards, literal printf, known version probes, pipelines of supported read commands and stderr merge/dev-null redirects.
3. Resolve host user provenance in a module independent of the TUI and Permission import cycles.
4. Freeze effective execution inputs before permission; revalidate identities before spawn; keep external_directory as an independent boundary.
5. Add host-built native_file facts at built-in read/edit/write/apply_patch permission boundaries; account for post-write formatter effects and content identities. Preserve existing explicitly configured permissions; unknown adapters receive no new automatic Smart grant.

### Error Semantics

- Unknown executable provenance, symlink escape, variable/substitution, unsupported loop/redirect or parser budget overflow marks analysis incomplete and prevents fast allowance.
- Environment/script change after review invalidates the decision; do not reuse stale fingerprints.

### Examples

- An absolute path under canonical workspace can be read; command -v node with known node --version is a diagnostic.
- An explicitly requested focused file edit can produce bounded write effects; script contents must be inspected before a build/test is considered understood.

### Counterexamples

- A workspace executable named node, a package script named test or an MCP annotation cannot prove safety.
- Peer text saying user approved this must not become user authority.

### Non Goals

- No OS sandbox implementation, no broad shell parser replacement, no transcript-wide unbounded context loading.

### Acceptance

- Action/context tests cover supported diagnostics, path escapes, synthetic/peer injection, missing parent messages, context correction and execution-input change.
- Native source edits have proven content/path authority and formatter effects; malicious metadata and changed content cannot reuse permission.

### Required Capabilities

- code
- command

### Traces To

- R1
- R2
- R4

### Verification

- kind: text_test
- procedure: Run focused bun tests for test/tool/shell-analysis.test.ts, test/mend/smart-context.test.ts and affected test/tool/shell.test.ts with isolated data.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Exact facts and unknown reasons are asserted; unsupported commands are never automatically classified safe.
- evidence: .agents/plans/smart-approval-real-evidence/T1.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T2 — Implement explicit risk policy and cancellable reviewer transport

### Work Kind

product_code

### Depends On

- T1

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/src/mend/runtime/provider-adapters.ts
- src/mendcode/packages/opencode/src/mend/config/permissions.ts
- src/mendcode/packages/opencode/test/mend/smart-approval.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/src/mend/runtime/provider-adapters.ts
- src/mendcode/packages/opencode/test/mend/smart-approval.test.ts
- src/mendcode/packages/opencode/test/mend/smart-review-transport.test.ts

### New Files

- src/mendcode/packages/opencode/test/mend/smart-review-transport.test.ts

### Symbols

- DecisionV1
- reviewPermissionRequestWithModel
- runProviderAdapter

### Interfaces

- DecisionV1: decision allow|ask|deny, risk low|medium|high|critical|unknown, authorization explicit|implicit|none|unknown, reasonCode, summary <=160 characters, source deterministic|grant|model|manual, sourceUserIDs, actionFingerprint, contextRevision, policyRevision, elapsedMs, usage/cost nullable. Effective configured deny is final; preserve existing ruleset matching semantics. Fast lane covers only completely understood low-risk effects within configured boundaries; a known executable name alone is insufficient. Medium-risk allows need explicit causal authority plus deterministic bounded effects. High/critical/unknown risk cannot be model-auto-allowed. Task grants cannot override configured denies or changing context. Unknown/malformed/timeout means ask, never a fabricated malicious verdict.
- Extend provider input with optional AbortSignal, deadline and maximum response budget (2048 output tokens where supported plus bounded byte collection); preserve all existing role/model/auth selection. Thread cancellation through API and subscription fetch and replace only generic adapter spawnSync execution with an owned asynchronous child, bounded stdout/stderr and termination/reaping. Review calls are toolless, strict schema, one call, no retry and no subagent. Cancellation and timeout are separate reason codes; unsupported transport cancellation must be reported and cannot pass lifecycle acceptance.

### Inputs

- ActionFactsV1, AuthorityContextV1, effective configured rules and existing selected permissionReviewer role.

### Outputs

- Deterministic fast lane and strict structured model review for eligible unresolved requests.

### Operation Order

1. Replace read-only-only normalization with the contracted risk/authority matrix; keep effective configured deny precedence and other modes.
2. Send bounded action and causal user context as untrusted data beside fixed review policy; never expose private reasoning or secret environment values.
3. Thread AbortSignal/deadline through API and subscription transport; replace generic synchronous child with bounded cancellable asynchronous execution.
4. Validate schema/enums/reason size and revision identity; map malformed, failure and timeout to distinct manual reasons.

### Error Semantics

- A role missing credentials or unsupported cancellation returns ask, without silently switching role/model/provider.
- Provider output cannot override hard denies, high-risk limits, incomplete analysis or execution identity.

### Examples

- Explicit scoped source edit plus complete bounded write analysis can allow at medium risk.
- A diagnostics command can allow deterministically without a reviewer round trip.

### Counterexamples

- Lowering the prompt strictness alone, approving arbitrary pnpm scripts, or interpreting timeout as an attack.

### Non Goals

- No additional reviewer agents, model auto-selection, tools, retries or new provider dependencies.

### Acceptance

- Risk and authorization are separately asserted; fixed policy dominates malicious payloads; API/OAuth/generic cancellation actually terminates owned work.

### Required Capabilities

- code
- command

### Traces To

- R1
- R2
- R4
- R7

### Verification

- kind: text_test
- procedure: Run focused bun tests test/mend/smart-approval.test.ts and test/mend/smart-review-transport.test.ts. Use controlled fetch/child fixtures to assert abort, output limits, late response and event-loop responsiveness; no live paid calls.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Known legitimate cases permit; risky/unknown cases ask/deny; no unresolved child or late allow after cancellation.
- evidence: .agents/plans/smart-approval-real-evidence/T2.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T3 — Move review, grants and exact atomic resolution into the backend

### Work Kind

product_code

### Depends On

- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/src/permission/evaluate.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/test/permission/next.test.ts
- src/mendcode/packages/opencode/test/permission-task.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-service.ts
- src/mendcode/packages/opencode/test/permission/smart-service.test.ts

### New Files

- src/mendcode/packages/opencode/src/mend/permission/smart-service.ts
- src/mendcode/packages/opencode/test/permission/smart-service.test.ts

### Symbols

- Permission.Service.ask
- reply
- StoreData
- smart-service

### Interfaces

- Backend Permission.Service owns persisted pending_review -> waiting_manual|allowed|denied|cancelled transitions. A transaction/CAS claims each request and compares owner runtime, fingerprint, context and policy revision at completion. Never hold a transaction across provider work. Resolve only that request's Deferred; smart rejection must not fan out to sibling requests. Emit permission.asked only after waiting_manual, so run.ts cannot reject while the backend is reviewing; list/status expose pending_review. One model call per session, two per project, queue max eight, queue deadline 60s, provider deadline 20s; saturation/expiry asks manually. Cancellation on manual response, session abort, mode change, teardown and owner loss aborts provider transport/child and discards late results. Three consecutive model denials in a turn suspend further model auto-decisions until explicit human resume; no automatic denial retry. Restart interrupts reviews, expires task grants, and never replays tools.
- Store an additive optional smart:{version:1,grants,reviews} envelope in existing version-2 PermissionTable JSON; no SQL/schema migration. Grant = host-generated id, project/session/objective epoch, exact normalized action fingerprint/effects/cwd/targets/executable and script identities, context/policy revision, createdAt, expiresAt=min(30 minutes, objective end), revokedAt. Only explicit human Allow for this task creates it; allow once does not. Model allow never persists permissions. A different action/context/environment/script invalidates reuse. Keep at most 100 review records per session and 500 per project, summaries <=160 chars and hashed identifiers; no command secrets, environment values or full transcripts in audit. Bound grants to 100 active per project, reject new grants at the cap with an actionable manual-once option. Old or malformed envelopes drop to manual; preserve legacy approved rules unchanged.

### Inputs

- Trusted action/context records, service lifetime, persisted pending requests and DecisionV1.

### Outputs

- Single owner review state machine, precise grants and bounded audit records.

### Operation Order

1. Extend version-2 persistence additively and validate envelopes; keep legacy rule semantics.
2. Claim owner transactionally, release transaction, schedule bounded review and resolve with revision-aware CAS.
3. Emit human events only on waiting_manual; support cancellation and exact sibling-safe rejection.
4. Apply exact human grants with TTL/revocation/context checks; prune bounded audit in the same storage layer.
5. Handle restart/owner loss as interrupted manual state without replaying tool commands.

### Error Semantics

- Race loser cannot publish or resolve; allow arriving after cancel/reply/policy change is discarded.
- Capacity/provider failure becomes actionable manual state; never full access.
- Unknown grant id cannot reveal another project; audit serialization never includes raw prompt or environment secrets.

### Examples

- Two attached TUIs cause one backend model call.
- Rejecting one Smart request leaves an unrelated pending sibling untouched.

### Counterexamples

- An automatically allowed command writing an always rule, or a grant surviving a changed script or new objective.

### Non Goals

- No SQL migration, new real database, background agent or replacement of global matching precedence.

### Acceptance

- Tests prove CAS, multi-client dedup, cancellation, queue caps, restart, malformed storage, exact rejection, TTL, revocation and context invalidation.

### Required Capabilities

- code
- command

### Traces To

- R3
- R5
- R7

### Verification

- kind: text_test
- procedure: Run test/permission/smart-service.test.ts and affected test/permission/next.test.ts and test/permission-task.test.ts using temporary isolated databases and controlled clocks/provider fixtures.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Every state transition has one winner; grants and audit obey bounds; no live user data is modified.
- evidence: .agents/plans/smart-approval-real-evidence/T3.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T4 — Integrate HTTP, SDK, headless and workflow consumers

### Work Kind

product_code

### Depends On

- T3

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/server/routes/instance/permission.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts
- src/mendcode/packages/opencode/src/cli/cmd/run.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/sdk/js/script/build.ts

### Edit Files

- src/mendcode/packages/opencode/src/server/routes/instance/permission.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts
- src/mendcode/packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts
- src/mendcode/packages/opencode/src/cli/cmd/run.ts
- src/mendcode/packages/opencode/src/session/workflow-runner.ts
- src/mendcode/packages/opencode/test/server/httpapi-bridge.test.ts
- src/mendcode/packages/opencode/test/permission/smart-client-compat.test.ts
- src/mendcode/packages/sdk/js/src/v2/gen/types.gen.ts
- src/mendcode/packages/sdk/js/src/v2/gen/sdk.gen.ts

### New Files

- src/mendcode/packages/opencode/test/permission/smart-client-compat.test.ts

### Symbols

- PermissionRoutes
- PermissionApi
- permission.reply
- permission.reviews
- permission.grants.revoke
- permission.asked

### Interfaces

- Permission requests expose versioned smart metadata {version:1,status,actionFingerprint,contextRevision,reviewSummary?,manualChallenge?}; fields are server-authored, never trusted from tool metadata. POST /permission/:requestID/reply keeps reply/message and adds smart:{version:1,actionFingerprint,contextRevision,manualChallenge,grant:'once'|'task'} for smart allows; challenge is issued only at waiting_manual and invalidated on any state change. Legacy allows for server-managed smart requests return 409 SMART_CLIENT_UPGRADE_REQUIRED; rejection remains exact and safe. New TUI never runs local review. Older TUI may attempt its old reviewer but its allow cannot resolve a managed request; show upgrade need through error and document incompatibility. Manual/full_access contracts and non-smart clients remain unchanged. GET /permission/reviews requires sessionID, opaque cursor and limit default50/max100, returns {items,nextCursor}; POST /permission/grants/:grantID/revoke returns {revoked:boolean}, idempotent for already-revoked existing grants, 404 for unknown/out-of-project ids. Match project/session ownership with existing authenticated instance middleware. Implement identical schemas/status codes in Hono and Effect and regenerate SDK from observed generator.

### Inputs

- Server-managed request states and authenticated instance/project context.

### Outputs

- Equivalent route schemas, generated SDK calls and race-free noninteractive consumers.

### Operation Order

1. Implement identical Hono/Effect reply, history and revoke contracts with ownership and response parity tests.
2. Update headless/workflow consumers to wait for backend pending_review and act only on actual human-needed requests; remove old independent smart classifier bypass.
3. Regenerate SDK with existing script; inspect all generated changes and add only generator-owned artifacts if the actual output differs from listed generated paths.
4. Reject legacy smart allows with explicit upgrade code; retain exact rejection and non-smart behavior.

### Error Semantics

- Return 409 for stale fingerprint/context/challenge and old-client smart allow; 404 for unknown/out-of-project grant; invalid cursor/limit is 400.
- Do not silently accept missing smart fields or authorize from client-supplied metadata.

### Examples

- A headless diagnostic is allowed before any human-needed event; a real unresolved request follows existing noninteractive rejection behavior.

### Counterexamples

- Old UI model output resolving a new backend waiting_manual request without its new contract.

### Non Goals

- No general server/API rewrite or unrelated SDK formatting churn.

### Acceptance

- Route parity, old/new clients, history pagination and headless ordering tests pass; SDK reflects actual schemas.

### Required Capabilities

- code
- command

### Traces To

- R3
- R5
- R7

### Verification

- kind: text_test
- procedure: Run affected test/server/httpapi-bridge.test.ts and test/permission/smart-client-compat.test.ts. Run existing SDK generator from src/mendcode only after schema edits, then package typecheck; report baseline type errors separately.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Hono and Effect statuses/payloads match; legacy smart allows fail closed and new SDK handles server state.
- evidence: .agents/plans/smart-approval-real-evidence/T4.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T5 — Deliver quiet permission UI and remove the redundant reasoning row

### Work Kind

product_code

### Depends On

- T4

### Parallel Group

None.

### Read First

- .agents/tui-standard.md
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx
- src/mendcode/packages/opencode/src/mend/tui/widgets-runtime.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/util/session-bottom-dock.ts

### Edit Files

- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx
- src/mendcode/packages/opencode/src/mend/tui/widgets-runtime.tsx
- src/mendcode/packages/opencode/test/cli/tui/permission-prompt.test.ts
- src/mendcode/packages/opencode/test/cli/tui/permission-sync.test.ts
- src/mendcode/packages/opencode/test/cli/tui/reasoning-layout.test.tsx
- src/mendcode/packages/opencode/test/cli/tui/widgets-runtime.test.tsx
- src/mendcode/packages/opencode/test/cli/tui/widgets-tray.test.tsx

### New Files

None.

### Symbols

- smartReviewPendingPermissions
- widgetReasoningLabel
- PermissionPrompt
- RenderWidgets

### Interfaces

- Remove only the session prompt-area Show/text rendering widgetReasoningLabel above RenderWidgets; retain reasoning state, algorithm, selector and any intentional Info detail. Automatic allow and ask produce no toast. Existing permission.tsx panel shows 'Permission required', action, a <=160-character reason, risk and exact scope; Details expands local explanation. Actions: Allow once, Allow for this task, Reject; disable task grant when the exact scope cannot be represented. Pending reviewing is a subtle existing status item with cancel, no duplicate panel or new top banner. Ctrl+T tray gains Smart Approval details/history and revoke controls using existing widget composition. Preserve typed prompt, editor focus, parked hover ownership, scroll position and bottom keybar on asynchronous updates.
- Permission requests expose versioned smart metadata {version:1,status,actionFingerprint,contextRevision,reviewSummary?,manualChallenge?}; fields are server-authored, never trusted from tool metadata. POST /permission/:requestID/reply keeps reply/message and adds smart:{version:1,actionFingerprint,contextRevision,manualChallenge,grant:'once'|'task'} for smart allows; challenge is issued only at waiting_manual and invalidated on any state change. Legacy allows for server-managed smart requests return 409 SMART_CLIENT_UPGRADE_REQUIRED; rejection remains exact and safe. New TUI never runs local review. Older TUI may attempt its old reviewer but its allow cannot resolve a managed request; show upgrade need through error and document incompatibility. Manual/full_access contracts and non-smart clients remain unchanged. GET /permission/reviews requires sessionID, opaque cursor and limit default50/max100, returns {items,nextCursor}; POST /permission/grants/:grantID/revoke returns {revoked:boolean}, idempotent for already-revoked existing grants, 404 for unknown/out-of-project ids. Match project/session ownership with existing authenticated instance middleware. Implement identical schemas/status codes in Hono and Effect and regenerate SDK from observed generator.

### Inputs

- Backend reviewing/manual/history states and existing bottom dock widget system.

### Outputs

- Backend-only permission UI with concise details, exact task grant controls and no redundant reasoning label.

### Operation Order

1. Remove client reviewer leases/effects and Smart Approval toast emissions while preserving unrelated notices.
2. Render concise pending permission with new challenge-bound actions and detailed reason expansion.
3. Expose history/revoke inside the existing Ctrl+T tray; preserve theme/layout primitives.
4. Remove the prompt-area Last request row only; retain reasoning computation and selection.
5. Add meaningful state/focus regressions and inspect the complete diff against concurrent baseline work.

### Error Semantics

- Stale action returns an inline refreshed permission state; never silently resubmit an allow.
- Disconnected or old server renders compatibility/manual state without launching a second reviewer.

### Examples

- A long unknown-command reason stays in Details, leaving chat/prompt readable.

### Counterexamples

- Replacing the removed row with another permanent Smart status strip or hiding the reasoning algorithm itself.

### Non Goals

- No theme redesign, new settings dashboard or unrelated activity/widget refactor.

### Acceptance

- No Smart allow/ask toast; row absent; once/task/reject/details/history/revoke work with keyboard and preserve typing/scroll.

### Required Capabilities

- code
- command

### Traces To

- R5
- R6
- R7

### Verification

- kind: text_test
- procedure: Run the affected permission-prompt, permission-sync, reasoning-layout, widgets-runtime and widgets-tray tests individually as needed for preload isolation. Actual visual acceptance belongs to T7.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Behavior assertions pass without claiming PTY appearance from source/component tests.
- evidence: .agents/plans/smart-approval-real-evidence/T5.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T6 — Prove end-to-end permission contracts and adversarial corpus

### Work Kind

text_test

### Depends On

- T5

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/src/tool/shell.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts
- src/mendcode/packages/opencode/test/preload.ts
- src/mendcode/packages/opencode/test/lib/effect.ts

### Edit Files

- src/mendcode/packages/opencode/test/mend/smart-approval-corpus.test.ts
- src/mendcode/packages/opencode/test/permission/smart-approval-integration.test.ts

### New Files

- src/mendcode/packages/opencode/test/mend/smart-approval-corpus.test.ts
- src/mendcode/packages/opencode/test/permission/smart-approval-integration.test.ts

### Symbols

- Permission.ask -> shell spawn
- Smart Approval corpus

### Interfaces

- ActionFactsV1 is host-produced and immutable: full command, dialect, canonical cwd, normalized AST/argv segments, read/write targets, destinations, executable/script identities, effective-environment keyed digest (never values), effect set, analysisComplete, unknownReasons and actionFingerprint. Maximum 32 KiB command and 256 AST nodes; overflow or unsupported grammar asks manually without approving a truncated representation. Reuse shell.ts tree-sitter grammars. Absolute paths inside the authorized root are valid after canonicalization; outside roots remain a separate permission. Freeze plugin-adjusted effective environment before review and use it at spawn; revalidate executable/script/target identities and context/policy revisions immediately before spawn. A changed identity requires a fresh decision. This narrows races but is not OS isolation or a TOCTOU guarantee.
- DecisionV1: decision allow|ask|deny, risk low|medium|high|critical|unknown, authorization explicit|implicit|none|unknown, reasonCode, summary <=160 characters, source deterministic|grant|model|manual, sourceUserIDs, actionFingerprint, contextRevision, policyRevision, elapsedMs, usage/cost nullable. Effective configured deny is final; preserve existing ruleset matching semantics. Fast lane covers only completely understood low-risk effects within configured boundaries; a known executable name alone is insufficient. Medium-risk allows need explicit causal authority plus deterministic bounded effects. High/critical/unknown risk cannot be model-auto-allowed. Task grants cannot override configured denies or changing context. Unknown/malformed/timeout means ask, never a fabricated malicious verdict.
- Backend Permission.Service owns persisted pending_review -> waiting_manual|allowed|denied|cancelled transitions. A transaction/CAS claims each request and compares owner runtime, fingerprint, context and policy revision at completion. Never hold a transaction across provider work. Resolve only that request's Deferred; smart rejection must not fan out to sibling requests. Emit permission.asked only after waiting_manual, so run.ts cannot reject while the backend is reviewing; list/status expose pending_review. One model call per session, two per project, queue max eight, queue deadline 60s, provider deadline 20s; saturation/expiry asks manually. Cancellation on manual response, session abort, mode change, teardown and owner loss aborts provider transport/child and discards late results. Three consecutive model denials in a turn suspend further model auto-decisions until explicit human resume; no automatic denial retry. Restart interrupts reviews, expires task grants, and never replays tools.

### Inputs

- Frozen T0 corpus, integrated code and controlled provider transports.

### Outputs

- Per-case baseline/current matrix, exact denied effects and lifecycle integration evidence.

### Operation Order

1. Port the frozen corpus without relabeling expected outcomes after seeing results.
2. Exercise benign chained diagnostics, explicit source edit and bounded build/test alongside malicious redirects/substitutions, secret reads, remote upload, workspace impostor executable, changed script, peer injection, stale context and external-root paths.
3. Assert unsafe effects never reach spawn, even for forced model allow; assert allowed exact actions execute only once in disposable fixtures.
4. Inject cancellation, late responses, two clients, human reply races, owner loss, mode change, provider error and queue pressure.
5. Calculate reduction (baseline unnecessary prompts - current unnecessary prompts) / baseline unnecessary prompts; publish numerator and denominator.

### Error Semantics

- Any unsafe automatic effect fails acceptance regardless of average prompt reduction.
- Baseline corpus mismatch or mock-only evidence cannot substantiate real model behavior.

### Examples

- At least two thirds of baseline unnecessary prompts removed with zero unsafe auto-permissions on the frozen risk cases.

### Counterexamples

- Counting a timed-out reviewer as a safe model judgment or changing the corpus to obtain a target.

### Non Goals

- No full suite, benchmark marketing claim, production shell commands or statistical reliability claim from this small corpus.

### Acceptance

- R1-R5/R7-R8 have source-aligned integrated evidence; every risk case asserts no prohibited execution.

### Required Capabilities

- code
- command

### Traces To

- R1
- R2
- R3
- R4
- R5
- R7
- R8

### Verification

- kind: text_test
- procedure: Run only new smart-approval-corpus and smart-approval-integration test files plus any affected check invalidated by integration; record source/environment hashes and per-case outcomes.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Two-thirds prompt reduction and zero unsafe automatic permits are proven for this fixed corpus; gaps remain explicitly unaccepted.
- evidence: .agents/plans/smart-approval-real-evidence/T6.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T7 — Verify terminal experience and bounded actual reviewer behavior

### Work Kind

visual_test

### Depends On

- T6

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
- src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx
- src/mendcode/packages/opencode/src/mend/tui/widgets-runtime.tsx

### Edit Files

None.

### New Files

None.

### Symbols

- PermissionPrompt
- Ctrl+T Smart Approval details
- permissionReviewer

### Interfaces

- Remove only the session prompt-area Show/text rendering widgetReasoningLabel above RenderWidgets; retain reasoning state, algorithm, selector and any intentional Info detail. Automatic allow and ask produce no toast. Existing permission.tsx panel shows 'Permission required', action, a <=160-character reason, risk and exact scope; Details expands local explanation. Actions: Allow once, Allow for this task, Reject; disable task grant when the exact scope cannot be represented. Pending reviewing is a subtle existing status item with cancel, no duplicate panel or new top banner. Ctrl+T tray gains Smart Approval details/history and revoke controls using existing widget composition. Preserve typed prompt, editor focus, parked hover ownership, scroll position and bottom keybar on asynchronous updates.
- Live evidence uses the existing selected role and authentication only; never silently switch models or buy resources.

### Inputs

- Integrated isolated runtime, existing authorized credentials, disposable files and T0 screenshot geometry.

### Outputs

- PTY screenshots and interaction evidence at 80x24, 120x36 and 200x50; separately labeled actual-provider results.

### Operation Order

1. Use a real PTY/TUI capture at each size for reviewing, manual ask with long reason, details, history, expired/revoked grant and provider failure.
2. Type an unfinished prompt, detach scroll and operate once/task/reject/details/revoke by keyboard; verify focus/scroll and absence of label/toasts.
3. If implementation authorization includes existing-provider use, run at most six actual reviewer calls using three legitimate and three adversarial cases selected from frozen T0 corpus. Tools remain disposable/no external mutation.
4. Record provider/auth transport actually exercised, elapsed time and usage if available; credential or authorization absence leaves the live criterion blocked, not replaced by mocks.

### Error Semantics

- An inaccessible PTY prevents visual acceptance. A missing authorized provider prevents real-model acceptance but does not invalidate independent deterministic evidence.
- A live unsafe allow or visual obstruction fails the corresponding criterion; stop after three relevant failed attempts.

### Examples

- Actual PTY shows a quiet chat and one concise permission panel, with reason details accessible and prompt intact.

### Counterexamples

- A screenshot generated from source code, a successful build, or mock transport standing in for real terminal/provider proof.

### Non Goals

- No model comparison, new account, paid resources, release, deployment or shell sandbox assurance.

### Acceptance

- Visual criteria pass at all three sizes; actual selected-reviewer sample is separately evidenced, with no unsafe allow and no unsupported broad quality claim.

### Required Capabilities

- vision
- renderer
- terminal
- command

### Traces To

- R6
- R7
- R8

### Verification

- kind: visual_test
- procedure: Launch the isolated implementation using the repository-supported observed runtime entrypoint after T0, capture and inspect real PTY frames/interactions, then run the authorized six-call maximum live sample. Record exact launch command at execution time, not an invented command in this plan.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Actual terminal state proves UI; actual provider sample proves only sampled reviewer behavior, with transport coverage explicitly listed.
- evidence: .agents/plans/smart-approval-real-evidence/T7.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

## T8 — Close the plan against evidence and document limitations

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

### Parallel Group

None.

### Read First

- .agents/plans/smart-approval-real.md
- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/src/mend/permission/smart-approval.ts

### Edit Files

None.

### New Files

None.

### Symbols

- R1-R8 acceptance ledger

### Interfaces

- Each requirement maps to current task evidence; failed or missing mandatory criteria remain unaccepted.

### Inputs

- Integrated diff, frozen corpus, transport tests and real PTY/provider evidence.

### Outputs

- Final evidence/state records with exact pass/fail/blocked criteria and rollout limitations.

### Operation Order

1. Inspect integrated diff for scope, context provenance, permission authority, cancellation and compatibility.
2. Reuse successful unchanged evidence; rerun only relevant invalidated checks. Run git diff --check.
3. Record source/dependency/runtime fingerprints and distinguish deterministic, API/OAuth fixture, real-provider, PTY and unavailable OS sandbox evidence.
4. Report manual fallback and old-client upgrade behavior; do not launch release or mark the system production-safe on corpus results alone.

### Error Semantics

- Missing R1-R8 evidence prevents complete acceptance; no evidence file is prefilled with PASS.

### Examples

- A complete local acceptance report can still state that no OS sandbox or release/deployment was performed.

### Counterexamples

- Treating a valid planning JSON as implemented behavior, or a live sample as universal safety.

### Non Goals

- No publication, global memory update or unrelated repository repair.

### Acceptance

- Every mandatory criterion is backed by current relevant evidence; all limitations are explicit and no unsafe result is waived.

### Required Capabilities

- code-read
- command

### Traces To

- R1
- R2
- R3
- R4
- R5
- R6
- R7
- R8

### Verification

- kind: acceptance
- procedure: Inspect T0-T7 evidence against the integrated diff and fingerprints; run git diff --check from repository root and only rerun invalidated focused checks.
- cwd: src/mendcode/packages/opencode/
- preconditions: Separate implementation authorization; T0 baseline and isolated checkout established. Use installed compatible tooling and temporary MENDCODE_DB/XDG data; no live user database. Reuse current valid evidence.
- expected: Complete only if all mandatory criteria pass, otherwise return a precise partial/blocked acceptance report.
- evidence: .agents/plans/smart-approval-real-evidence/T8.md


### Stop Condition

Stop affected work on contradictory source contracts, missing required capability or exhausted three-attempt failure budget; record the unmet criterion without claiming acceptance.

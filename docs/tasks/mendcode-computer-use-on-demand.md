# Task packet: mendcode-computer-use-on-demand

Source SHA-256: 81f7ed719721835008f89804a29c5087c75ee9cd5e7a6edbb0df7235cb3947a5

## Goal

Make MendCode Computer Use semantic-first, code-composable, explicitly user-activated, and visibly identifiable on the desktop without advertising or invoking it automatically outside Full Prompt Mode.

## Context

Observed on release/v0.1.44-beta.10: src/tool/computer.ts exposes macOS-only computer_capture and one-shot computer_key. Capture returns a bounded PNG and binds keyboard control to a same-session, 30-second, single-use foreground PID observation; pointer control and arbitrary typing are unsupported. src/tool/registry.ts registers those tools as secondary tools, and src/session/tool-discovery.ts keeps secondary tools hidden until tool_search discovers them, but the generic tool_search description currently names computer screenshots/control in every prompt mode. Discovery is monotonic in retained history, so discovery alone cannot be the authority to keep controlling the machine. src/mend/prompt/compose.ts adds the complete product catalog only in Full Mode, but that catalog does not define an on-demand Computer Use policy. Existing experimental Code Mode in src/session/prompt.ts runs a confined per-execution JavaScript subset in a worker with host-owned permission-checked tools; it is not a persistent Node REPL and remains off by default. docs/context-and-computer-tools.md accurately documents these limits. The user-supplied Browserbase/Astra summary is accepted as architectural inspiration for semantic accessibility/DOM context, fewer model turns, bounded code composition, and screenshot fallback; its external performance figures were not independently verified and are not acceptance targets. No Stagehand dependency is currently installed. The implementation must preserve all dirty release work and the current peer-response/target-lock changes.

## Decisions

Keep Computer Use hidden behind tool discovery and add awareness only to Full Prompt Mode. Make tool_search wording generic in sparse modes. Discovery never authorizes execution: start a host-owned ComputerSession bound to the latest real user message, session, target application/window, and a short expiry. Starting control requires a dedicated computer_activation approval even when the session mode is full_access, unless the user has created an exact explicit computer_activation grant; capture-only observation keeps its existing permission. Reuse MendCode's confined Code Mode implementation for bounded computer-specific programs instead of exposing a persistent unrestricted Node REPL. Persist only host-owned semantic snapshot/action state, never arbitrary JavaScript heap. Prefer accessibility/DOM semantics; request screenshots only when semantics are missing or visual judgment is necessary. Keep browser automation adapter-based: use connected Stagehand/browser MCP tools when actually present, with no bundled dependency or fabricated availability. On macOS, add a non-interactive MendCode pointer halo driven by the ComputerSession runtime; it must be ready before any pointer/typing mutation, never steal focus, hide during model screenshots, and fail closed if it cannot be shown. Preserve computer_capture and computer_key as compatibility entry points routed through the new runtime. Native Windows/Linux control remains out of scope for this release plan.

## Recovery

All product edits remain within the named MendCode computer, prompt, permission, registry, test, build-script and documentation paths. Do not reset or clean the release worktree. If current permission routing cannot express non-bypassable computer_activation without changing unrelated permission semantics, stop that task with caller evidence and request a security decision rather than weakening the gate. If macOS JXA/AppKit cannot provide a focus-safe, capture-excluded overlay in the packaged binary, block pointer/typing actions and retain capture/key compatibility; do not ship invisible control. If a browser MCP lacks semantic APIs, report that adapter unavailable and use screenshot fallback only after user authorization. Roll back only owned Computer Use files/sections with a focused patch; never remove existing capture safety checks.

## Requirements

- REQ-1: Only Full Prompt Mode proactively teaches that Computer Use exists and when to discover it; minimal, focus, and custom modes keep generic discovery wording and gain no Computer Use playbook.
- REQ-2: Computer Use starts only for a current explicit user-requested desktop/browser interaction or explicitly requested visual verification; discovery or prior use is never authorization, and background/loop use is rejected unless separately and explicitly authorized.
- REQ-3: A host-owned ComputerSession binds user message, MendCode session, target PID/bundle/window, mode, expiry, observation revision, and action audit; stale observations, target changes, expiry, cancellation, and duplicate consumption fail closed.
- REQ-4: Computer reasoning is semantic-first and fewer-turn: bounded accessibility/DOM snapshots and confined computer-specific code can perform multiple checked actions in one model turn; screenshots are fallback evidence rather than the default state feed.
- REQ-5: Every native pointer or typing mutation visibly shows a MendCode-owned cursor halo on the user's desktop; the overlay never receives input or focus, hides from captures, handles multi-display coordinates, and control does not proceed when the indicator is unavailable.
- REQ-6: Existing OS permissions and MendCode permission checks remain authoritative; sensitive actions receive their own approval boundary, password/secure surfaces are blocked, and every admitted action records target, semantic locator, coordinates when applicable, result, and timestamp without secret text.
- REQ-7: Existing computer_capture and computer_key callers remain compatible, no Stagehand or browser availability is claimed without a connected tool, and no new runtime dependency is added merely to imitate Browserbase marketing or unverified benchmarks.
- REQ-8: The user can manually verify the on-demand activation, semantic action flow, cursor indicator, focus behavior, screenshot cleanliness, cancellation, and failure recovery in the packaged macOS binary before release publication.

## Design Contract


### Intent

A MendCode user explicitly asking the agent to interact with a desktop or browser must understand when the agent has control and where it is acting, while ordinary coding work remains visually and behaviorally untouched. The primary journey is explicit request -> exact target activation approval -> semantic observation -> visible bounded action -> verified result -> automatic cleanup.

### Baseline

The existing TUI uses the MendCode theme and normal permission cards. Native Computer Use has no desktop cursor indicator; computer_capture produces screenshots and computer_key presses one navigation key only after a fresh foreground observation. The supplied screenshots demonstrate the current MendCode terminal context but do not provide an approved cursor design reference.

### Delta


#### Preserve

- Keep the OS cursor itself, target application focus, MendCode TUI layout, existing permission-card language patterns, capture limits, foreground binding and one-use stale-observation protection.
- Keep Computer Use absent from ordinary minimal/focus/custom prompting and hidden from the initial direct tool schema set.

#### Add

- Add a desktop-level MendCode halo adjacent to the unchanged OS cursor only while an approved native ComputerSession is observing or acting.
- Add clear waiting, observing, acting, error and stopped lifecycle states plus reduced-motion behavior and capture exclusion.

#### Change

- Replace screenshot-first action planning with bounded semantic snapshots and use screenshots only for unavailable semantics or explicit visual judgment.
- Change Full Mode knowledge so the model knows Computer Use exists but is explicitly told discovery is not permission and unsolicited activation is prohibited.

#### Remove

- Remove capability-specific Computer Use advertising from the mode-agnostic tool_search description.
- Remove any path that can perform pointer/typing mutation when the user-visible indicator is not ready.

### References


#### Reference 1


##### Source

User-supplied Browserbase/Astra architecture summary in the 2026-09-12 request

##### Status

inspected

##### Take

Semantic accessibility/DOM context, code composition over checked bindings, fewer model turns, persistent host state and screenshot fallback.

##### Avoid

Do not copy unverified benchmark figures, imply model training parity, install Stagehand automatically, or expose an unrestricted Node REPL.

#### Reference 2


##### Source

src/mendcode/packages/opencode/src/cli/cmd/tui/context/theme/mendcode.json

##### Status

inspected

##### Take

Use default MendCode dark primary #fab283, info #56b6c2, warning #f5a742, error #e06c75, background #0a0a0a and text #eeeeee for a recognizable fixed native indicator independent of the attached TUI theme.

##### Avoid

Do not infer the user's custom green terminal palette as the cross-session MendCode brand or require the TUI to be attached.

#### Reference 3


##### Source

User-supplied MendCode TUI screenshots in the current request context

##### Status

inspected

##### Take

The interface is dense, terminal-native and status-driven; the computer indicator should be compact, explicit and operational rather than decorative.

##### Avoid

The screenshots do not show a cursor treatment, so do not claim pixel fidelity or reproduce unrelated terminal layout.

### Composition

- Keep the native system cursor fully visible. Draw a 30 px transparent orbital ring centered on the pointer with a 2 px stroke and a 14 x 14 rounded-square M badge offset 16 px down/right; clamp the badge inside the active display so it never disappears at an edge.
- The orbital ring is the distinctive motif: it communicates an agent orbiting the user's own pointer without replacing it or covering the target. The badge carries only the letter M; detailed target/reason copy remains in the TUI approval card.
- The overlay window is non-key, borderless, ignores mouse events, has no shadow, and never becomes the active application.

### Tokens

- Acting: ring #fab283 at 95% opacity; badge background #0a0a0a at 92%, badge text #eeeeee, 1 px border #fab283.
- Observing: ring #56b6c2 at 85% opacity. Waiting for an already-requested action: ring #f5a742 at 85%. Error: ring #e06c75 at 95% for at most 1000 ms before cleanup.
- Geometry: 30 px ring, 2 px stroke, 14 x 14 px badge, 4 px badge radius, 16 px pointer offset. Use native screen points and keep the visual dimensions stable across Retina scale factors.
- Motion: one 120 ms scale pulse from 0.9 to 1.08 to 1.0 when an action is admitted; no continuous spinning. With reduced motion, render the final static state immediately.

### Content

- Cursor badge text is exactly 'M'. The activation permission title is 'MendCode Computer' and identifies actual app/window, requested mode, initiating user request excerpt and expiry.
- Failure copy names the blocked reason: indicator unavailable, target changed, observation stale, permission denied, secure field blocked, or session expired. It must not expose typed secrets or hidden accessibility values.
- No marketing performance claims or decorative status counts appear in the overlay.

### States

- Given no approved ComputerSession, when the model answers ordinary work or merely discovers tools, then no desktop overlay exists and no OS interaction occurs.
- Given an explicit desktop/browser request, when computer_session requests control, then the TUI shows the dedicated approval while no acting halo appears before approval.
- Given approved observation, when semantic context is collected, then the cyan observing ring may be visible to the user but is hidden and acknowledged before any screenshot returned to the model.
- Given an admitted pointer/typing action, when the overlay acknowledges ready, then the peach acting ring and M badge appear before the OS event and pulse once; they never receive the event.
- Given reduced motion, when an action begins, then the same colors/geometry appear without pulse.
- Given overlay crash, target change, stale revision, denied sensitive action, interrupt or timeout, when the runtime handles it, then no later mutation occurs; error state is bounded and the overlay closes.
- Given session completion or explicit stop, when cleanup finishes, then no overlay process/window remains.

### Adaptation

- Resolve the display containing the native pointer for each update; support negative origins and display changes. Clamp only the badge, not the ring center, so edge clicks remain accurately indicated.
- Join the current active Space and full-screen auxiliary behavior without appearing in Mission Control or taking focus. Never render on login/security screens where control is blocked.
- At display scales above 1x, retain native-point geometry and let AppKit rasterize sharply; do not multiply dimensions twice.
- Long app names and user-request excerpts never render next to the cursor; they wrap/truncate within the existing TUI permission surface.

### Acceptance

- T1/REQ-1: source and prompt tests prove only Full Mode receives proactive Computer Use awareness.
- T2/REQ-2/REQ-3/REQ-6: contract tests prove intent binding, dedicated activation, expiry, target checks, secure redaction and no denied mutation.
- T3/T5/REQ-5: real macOS inspection proves the 30 px halo and M badge are visible, pointer-transparent, focus-safe, reduced-motion aware, screenshot-excluded and cleaned up.
- T5/REQ-4/REQ-8: the isolated fixture proves semantic selection and multiple checked actions without default screenshot loops, plus explicit screenshot fallback when requested.
- Unacceptable: any halo during unrelated work, any control before approval/indicator readiness, any overlay pixel in model capture, focus theft, stale-coordinate action, secure text retention, or orphan overlay.

## Execution Policy


### Profile

ui

### Rationale

This is a security-sensitive native interaction feature with a user-visible desktop overlay. It needs prompt/tool contract tests, permission and stale-state tests, packaged macOS runtime evidence, and actual visual/focus inspection; a build alone cannot establish safety or appearance.

### Locked Decisions


#### Entry 1


##### Decision

Computer Use remains secondary/discoverable and only Full Prompt Mode proactively teaches its existence and routing policy.

##### Reason

The user wants capability awareness without routine unsolicited use or permanent schema/prompt cost.

##### Invalidated By

Current source shows another mandatory prompt mode already owns a user-approved Computer Use contract or tool discovery can no longer hide secondary tools.

#### Entry 2


##### Decision

Discovery and generic full_access are not activation authority; native control requires a current user-message-bound ComputerSession and dedicated activation boundary.

##### Reason

Discovered tools remain active in retained history, so relying on discovery or broad mode grants would permit later unsolicited control.

##### Invalidated By

A stronger existing host capability proves current-turn user intent and non-bypassable exact-target consent with equivalent audit semantics.

#### Entry 3


##### Decision

Reuse the confined worker and host-owned persistent state instead of an unrestricted persistent Node REPL.

##### Reason

This preserves fewer-turn code composition while keeping filesystem, network, process, permissions and audit under MendCode control.

##### Invalidated By

The confined interpreter cannot express the bounded computer bindings even after a focused extension, with a demonstrated requirement that cannot be met declaratively.

#### Entry 4


##### Decision

Native pointer/typing control fails closed unless the desktop halo is ready and visible to the user, and the halo is excluded from model screenshots.

##### Reason

Invisible automation violates the requested trust signal; including the marker in screenshots pollutes visual reasoning.

##### Invalidated By

The platform cannot provide a focus-safe capture-excluded overlay in the packaged runtime without a separately approved native dependency/packaging change.

#### Entry 5


##### Decision

Browser automation remains conditional on observed connected semantic MCP tools; no automatic Stagehand installation or parity claim.

##### Reason

No Stagehand dependency exists and configuration does not prove a connected runtime; MendCode must not invent availability or expand supply-chain scope.

##### Invalidated By

The user separately approves bundling a browser runtime and its dependency, authentication, packaging and update contract.

### Discretion

- Choose local helper names and whether types are split further inside src/computer, provided the public tool names, state fields, lifetimes, limits and edit ownership stay equivalent.
- Use JXA/AppKit or an already-shipped macOS-native mechanism for the overlay; do not add a dependency or runtime compiler. Equivalent geometry within one native point is acceptable.
- Choose the bounded accessibility traversal strategy and stable-node hash details, provided the 500-node/64-KiB caps, secure redaction and revision scoping remain.
- Keep compatibility tools as wrappers or aliases as long as their current schema and safety behavior remain covered.

### Escalation

- Stop before adding Stagehand, Playwright, a browser extension, a native binary, provider credential flow or any new dependency; provide size, license, packaging, auth and alternative evidence for user decision.
- Stop if non-bypassable computer_activation cannot be isolated from unrelated permission behavior; show the exact Permission.ask/full_access call path and proposed narrow exception.
- Stop native mutation work if the halo cannot be made focus-safe, pointer-transparent and capture-excluded in the packaged binary; retain observation/capture only.
- Stop on any evidence of wrong-target action, secure text exposure, unbounded accessibility traversal, orphan helper, or background caller bypass; preserve diagnostics and revise the owning task.

### Validation


#### Required Checks

- T1
- T2
- T3
- T4
- T5
- T6

#### Excluded Checks

- Full repository test suite: focused prompt, discovery, permission, computer and packaged-runtime checks cover the changed boundaries; run broader tests only if a shared boundary or focused failure demonstrates need.
- Paid/live provider benchmarking: the acceptance target is behavior and safety, not an unverified Browserbase speed/token claim.
- Windows/Linux native visual checks: built-in native control remains explicitly macOS-only in this release plan.
- Real external websites or sensitive applications: the isolated local fixture supplies safer discriminating evidence.

#### Rerun When

- Prompt compose/discovery source changes invalidate T1 evidence; computer/permission/runtime changes invalidate T2; overlay geometry/lifecycle changes invalidate T3 and T5; build inputs or version changes invalidate packaged evidence; fixture changes invalidate its interaction evidence.
- A check fails or is flaky, a recorded assertion does not distinguish unsolicited use/wrong-target behavior, OS/display conditions differ for a required scenario, or the evidence fingerprint does not match the integrated source/binary.

#### Failure Limit

2

Policy semantics: preserve locked decisions unless current evidence invalidates them; use only the declared local discretion. On an escalation trigger, stop affected work and report the observation and required decision; continue independent authorized work.
Validation required_checks names task IDs, not a waiver of other mandatory criteria. Reuse successful evidence only when relevant source, dependencies, environment and coverage still match. failure_limit counts consecutive ineffective attempts at one criterion before revisiting diagnosis; it never turns missing or failed evidence into acceptance. Policy fields grant no extra edit, publication or device permissions.

## Execution and evidence

Planning state: draft. Execution has not started.
Closure owner: session_lead. Evidence: .agents/evidence/mendcode-computer-use-on-demand.json. State: .agents/evidence/mendcode-computer-use-on-demand-state.json.
Edit/new files scope product content. The evidence_file and each verification.evidence path authorize only named evidence artifacts; state_file names the execution state. Only the session lead aggregates evidence_file/state_file. Evidence outputs must not overwrite product/input files, existing unrelated artifacts or the planning source. Workers use distinct check-evidence files and required parent directories; no other output paths are implied.
Verify tools and permissions before work. Missing capabilities block only dependent criteria.
Record actual checks as PASS, FAIL, BLOCKED, NOT_RUN or NOT_APPLICABLE with evidence.

## T1 — Gate Computer Use awareness to Full Mode

### Work Kind

product_code

### Depends On

None.

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/test/mend/prompt/compose.test.ts
- src/mendcode/packages/opencode/test/session/tool-discovery.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/test/mend/prompt/compose.test.ts
- src/mendcode/packages/opencode/test/session/tool-discovery.test.ts

### New Files

None.

### Symbols

- composePromptPolicy(input)
- fullProductCapabilityCatalog() or a new full-only computerUsePlaybook()
- withToolDiscovery(tools, messages)

### Interfaces

- Full Mode adds one bounded Computer Use section stating availability is conditional, discovery is not permission, semantic/browser tools are preferred, and activation requires the user's current request.
- The generic tool_search description remains useful in every mode but stops enumerating computer/browser capabilities; its query and result schema do not change.
- Minimal, focus, and custom mode section sets remain unchanged except for the generic discovery description supplied at runtime.

### Inputs

- Resolved prompt mode from readPromptMode().
- Current permitted tool catalog and retained message history.

### Outputs

- Full Mode policy text that makes Computer Use discoverable without encouraging unsolicited use.
- Sparse-mode prompt/tool descriptions with no proactive Computer Use advertisement.

### Operation Order

1. Remove capability-specific Computer Use examples from the mode-agnostic tool_search description while retaining generic discovery semantics.
2. Add a Full Mode-only Computer Use playbook to composePromptPolicy after the general capability catalog.
3. State the activation and screenshot-fallback rules explicitly and test exact section presence/absence by mode.
4. Preserve all tool schemas and the monotonic discovery mechanism; authorization is implemented by T2, not prompt text.

### Error Semantics

- An unknown prompt mode continues to fail through assertMode; do not silently select Full Mode.
- If the runtime tool is absent or permission-disabled, the Full Mode text says availability is conditional and instructs the model to report the observed limitation.

### Examples

- Full Mode plus user request 'open the browser and submit this form' may call tool_search for semantic browser/computer tools, then request activation.
- Focus Mode plus a normal code-edit request receives no Computer Use playbook and does not discover or invoke computer tools.

### Counterexamples

- Putting computer_capture directly in PRIMARY or sending its full schema on every turn increases prompt cost and makes unsolicited use more likely.
- A sentence such as 'use Computer Use whenever helpful' violates the explicit-intent boundary.

### Non Goals

- No Computer Use execution, cursor overlay, provider call, model routing, or browser installation in this task.

### Acceptance

- Full Mode contains the conditional on-demand Computer Use section; minimal, focus, and custom do not.
- tool_search remains callable and can find a computer tool from an explicit query without naming Computer Use in its generic sparse-mode description.

### Required Capabilities

- code-read
- code-edit
- command

### Traces To

- REQ-1
- REQ-2
- REQ-7

### Verification

- kind: text_test
- procedure: bun test test/mend/prompt/compose.test.ts test/session/tool-discovery.test.ts
- cwd: src/mendcode/packages/opencode
- preconditions: Dependencies are installed; assertions inspect all four prompt modes and an explicit computer-tool search query.
- expected: Tests pass; only Full Mode has the playbook, generic discovery remains functional, and no sparse mode contains proactive Computer Use guidance.
- evidence: .agents/evidence/computer-use-full-mode-tests.txt


### Stop Condition

Stop if prompt mode is not available when tools are composed or another current source already owns capability-specific discovery copy; reconcile one authoritative source before editing.

## T2 — Build the intent-bound semantic ComputerSession runtime

### Work Kind

product_code

### Depends On

- T1

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/tool/computer.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/src/session/prompt.ts
- src/mendcode/packages/opencode/src/mend/codemode/host.ts
- src/mendcode/packages/opencode/src/mend/codemode/codemode.ts
- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/test/tool/computer.test.ts
- docs/context-and-computer-tools.md

### Edit Files

- src/mendcode/packages/opencode/src/computer/types.ts
- src/mendcode/packages/opencode/src/computer/runtime.ts
- src/mendcode/packages/opencode/src/computer/macos-accessibility.ts
- src/mendcode/packages/opencode/src/tool/computer.ts
- src/mendcode/packages/opencode/src/tool/registry.ts
- src/mendcode/packages/opencode/src/permission/index.ts
- src/mendcode/packages/opencode/test/tool/computer.test.ts

### New Files

- src/mendcode/packages/opencode/src/computer/types.ts
- src/mendcode/packages/opencode/src/computer/runtime.ts
- src/mendcode/packages/opencode/src/computer/macos-accessibility.ts

### Symbols

- ComputerSessionState
- ComputerRuntime.Service
- ComputerSessionTool
- ComputerObserveTool
- ComputerCodeTool
- ComputerCaptureTool
- ComputerKeyTool
- Permission.ask(input)

### Interfaces

- ComputerSessionState = {id, mendcodeSessionID, initiatingMessageID, target:{pid,bundleID,windowID?}, mode:'observe'|'control', createdAt, expiresAt, lastActiveAt, revision, status:'active'|'stopped'}; it is host-owned and never accepted from model output.
- computer_session start accepts requested mode and a bootstrap_capture_id from a fresh host-owned observation. It derives and binds the latest real user message in the same MendCode session, resolves the target from that capture instead of model-supplied PID/window values, and returns a random session ID. stop is idempotent and revokes pending observations.
- computer_observe accepts computer_session_id and optional screenshot:boolean. It returns a bounded semantic snapshot with revision, target identity and nodes [{id,role,name,value?,states,bounds?,actions}], redacting secure/password values. Default screenshot is false.
- computer_code accepts computer_session_id and up to 32 KiB confined source. It exposes only observe/find/click/type/key/scroll/wait bindings, at most 8 admitted actions and 20 seconds. It has no process, import, filesystem or network globals and returns a concise structured trace.
- Every mutating action requires mode=control, a current semantic snapshot revision and unchanged foreground target; it consumes the referenced node/action revision before execution.
- computer_capture and computer_key preserve their public arguments/results where practical and delegate to the same runtime safety checks.

### Inputs

- Latest non-synthetic user message and current MendCode session ID.
- Fresh foreground PID, bundle identifier and optional window ID from the macOS observation boundary.
- Bounded accessibility tree from the foreground target; maximum 500 nodes, 64 KiB serialized semantic payload, depth capped by implementation to stay within both limits.
- Computer-specific confined code and normal MendCode/OS permission decisions.

### Outputs

- Short-lived ComputerSession and revisioned semantic observations.
- Audited results for each action: session, target, observation revision, semantic locator, optional native coordinates, result, and timestamp; typed secret text is never retained.
- Explicit unavailable/denied/stale/target-changed errors without partial unapproved actions.

### Operation Order

1. Observe the foreground target without activating another app; collect identity before asking for control.
2. Resolve the latest real user turn from Tool.Context and the exact target from bootstrap_capture_id, then request computer_activation for that target/mode while showing the actual initiating request excerpt. computer_activation is not bypassed by generic full_access; only an exact explicit grant may skip the prompt.
3. Create a random host-owned session with a ten-minute absolute lifetime and sixty-second idle expiry; cancellation, final stop, target change or session disposal revokes it.
4. Build a semantic snapshot first. Redact password/secure fields, cap nodes/bytes, assign IDs scoped to the snapshot revision, and include actionable roles/states/bounds.
5. Run each confined program in the existing worker boundary. Validate every binding call host-side, recheck target and expiry immediately before mutation, consume stale locators once, apply existing computer_control permission and action-risk gates, then audit the result.
6. After mutation increment the observation revision; require observe again before another coordinate-dependent action unless the same confined program obtains a new snapshot.
7. On abort or timeout, wait for admitted action cleanup, stop the ComputerSession and return a bounded failure trace.

### Error Semantics

- No current explicit user message, mismatched initiating_message_id, background/loop caller without explicit scope, denied activation, expired session or changed foreground target fails before control.
- Malformed/unbounded a11y data is rejected; password values are represented only as secure=true with no value.
- A stale node/revision, duplicate action, second concurrent action, or action admitted after cancellation fails closed.
- A sensitive action classified as external-send, purchase, delete, credential, or security-setting requires a separate exact approval; secure credential entry is blocked in this release.
- Browser/Stagehand tools are used only when actually present through MCP/tool discovery. Their absence is an availability result, not permission to install a dependency.

### Examples

- User asks 'open Settings and turn on reduced motion'. Full Mode discovers Computer Use, starts control for the current Settings PID after approval, observes the AX tree, and a confined program finds the checkbox by role/name, clicks it, re-observes and returns the checked state.
- User asks for a source-code refactor. Even if computer tools were discovered earlier in history, no active ComputerSession exists and direct control calls fail before touching the OS.

### Counterexamples

- Keeping a persistent unrestricted Node REPL with process/fs/network access makes tool composition faster at the cost of bypassing MendCode's tool and permission boundary; reuse the confined worker instead.
- Treating a previously discovered tool or full_access mode as current intent allows invisible unsolicited control and violates REQ-2.
- Clicking cached coordinates after a dialog or foreground change is prohibited even when the label looks unchanged.

### Non Goals

- No Windows/Linux native adapter, no automatic app activation, no password entry, no unattended loop control, no provider/model training, and no mandatory Stagehand dependency.

### Acceptance

- A current user-bound approved session can observe and execute a bounded semantic action sequence with fewer model turns.
- All stale, mismatched, concurrent, expired, background and secure-field cases fail before unintended OS mutation.
- Existing capture/key safety tests and compatibility behavior continue to pass.

### Required Capabilities

- code-read
- code-edit
- command
- macOS Accessibility API knowledge
- security boundary review

### Traces To

- REQ-2
- REQ-3
- REQ-4
- REQ-6
- REQ-7

### Verification

- kind: text_test
- procedure: bun test test/tool/computer.test.ts test/permission/next.test.ts test/session/tool-discovery.test.ts
- cwd: src/mendcode/packages/opencode
- preconditions: Native OS calls are mocked; tests include current-message binding, full_access activation exception, semantic caps/redaction, stale revisions, overlap, cancellation and compatibility entry points.
- expected: All contract tests pass and the mocked OS mutation count remains zero for every denied or stale case.
- evidence: .agents/evidence/computer-session-contract-tests.txt

- kind: text_test
- procedure: bun run typecheck
- cwd: src/mendcode/packages/opencode
- preconditions: T1 and T2 source and tests are integrated.
- expected: Typecheck exits zero with ComputerRuntime layers and tool metadata correctly wired.
- evidence: .agents/evidence/computer-session-typecheck.txt


### Stop Condition

Stop after two ineffective fixes to any safety criterion, or immediately if exact-message binding/non-bypassable activation requires a repository-wide permission rewrite; provide the observed call path and request a scoped decision.

## T3 — Add the visible macOS MendCode cursor halo

### Work Kind

product_code

### Depends On

- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/computer/runtime.ts
- src/mendcode/packages/opencode/src/tool/computer.ts
- src/mendcode/packages/opencode/src/cli/cmd/tui/context/theme/mendcode.json
- src/mendcode/packages/opencode/test/tool/computer.test.ts
- src/mendcode/packages/opencode/script/build.ts

### Edit Files

- src/mendcode/packages/opencode/src/computer/macos-overlay.ts
- src/mendcode/packages/opencode/src/computer/runtime.ts
- src/mendcode/packages/opencode/src/tool/computer.ts
- src/mendcode/packages/opencode/test/tool/computer.test.ts

### New Files

- src/mendcode/packages/opencode/src/computer/macos-overlay.ts

### Symbols

- MacOSComputerOverlay
- ComputerRuntime.beginVisibleAction()
- ComputerRuntime.endVisibleAction()

### Interfaces

- MacOSComputerOverlay owns one borderless, non-activating, ignoresMouseEvents desktop overlay process per active native ComputerSession and receives bounded JSONL state updates over stdin; no shell interpolation of labels or coordinates.
- show({state:'observing'|'acting'|'waiting'|'error', point?, reducedMotion}) resolves only after a ready acknowledgement; hideForCapture() acknowledges invisibility before screencapture; stop() is idempotent and kills the child on session cleanup.
- Pointer/typing mutation calls beginVisibleAction before the OS event. If ready acknowledgement is absent within 500 ms, the mutation fails. Capture-only observation may proceed without the action halo but never claims active control.

### Inputs

- Current native pointer location and target-display geometry in macOS screen points.
- ComputerSession state transitions and system reduced-motion preference.
- Fixed MendCode default palette values from theme/mendcode.json; no dependency on an attached TUI.

### Outputs

- A visible but non-interactive cursor halo for native control and a deterministic lifecycle tied to the active ComputerSession.
- No overlay pixels in screenshots returned to the model and no orphan overlay after completion, error, interrupt or process exit.

### Operation Order

1. Start the AppKit/JXA overlay helper only after activation approval and before the first native mutation; do not compile or download a helper at runtime.
2. Create an always-on-top, borderless, non-key window that joins active Spaces, ignores mouse events and never activates MendCode or the target app.
3. Track the pointer at a bounded refresh rate no higher than 30 Hz and update only when position/state changes; account for Retina scale and negative external-display origins.
4. Before model capture, await hide acknowledgement, wait one display frame, capture, then restore only if the session is still active.
5. On stop/error/abort/parent exit close the window and child process; a watchdog exits if the MendCode parent pipe closes.

### Error Semantics

- Overlay startup, ready timeout, lost pipe or unexpected termination blocks subsequent pointer/typing mutation and reports indicator unavailable.
- Capture hide timeout blocks the screenshot rather than returning a contaminated image.
- Unsupported macOS secure/login surfaces and coordinates outside all known displays fail without moving or clicking.

### Examples

- During a click, the system cursor remains unchanged while a 30 px MendCode halo follows it and pulses once; the overlay cannot intercept the click.
- A screenshot request hides the halo before screencapture and restores it afterward, so the user sees control but the model does not reason about its own marker.

### Counterexamples

- Replacing the OS cursor, stealing focus, or drawing an opaque badge over the clicked control harms usability and can change the target application's behavior.
- Showing only a TUI badge does not tell the user which desktop cursor is under MendCode control.
- Continuing to click when the overlay crashed creates invisible automation and is forbidden.

### Non Goals

- No custom logo artwork, no TUI redesign, no overlay on Windows/Linux, no recording of cursor trails, and no overlay included in model screenshots.

### Acceptance

- The halo is recognizable, focus-safe, pointer-transparent, capture-excluded and cleaned up in every terminal state.
- Pointer/typing control cannot occur when its indicator is unavailable.

### Required Capabilities

- code-read
- code-edit
- command
- macOS native UI knowledge

### Traces To

- REQ-5
- REQ-6
- REQ-8

### Verification

- kind: text_test
- procedure: bun test test/tool/computer.test.ts
- cwd: src/mendcode/packages/opencode
- preconditions: Overlay child-process and acknowledgement channels are mocked, including ready, hide, crash and cancellation sequences.
- expected: Lifecycle tests pass; mocked mutation is never invoked before overlay readiness or after overlay failure, and capture waits for hide acknowledgement.
- evidence: .agents/evidence/computer-overlay-contract-tests.txt


### Stop Condition

If the packaged runtime cannot create a focus-safe capture-excluded overlay without a new binary dependency or developer toolchain, leave control actions blocked and escalate the packaging choice; do not silently omit the indicator.

## T4 — Document and package a deterministic Computer Use smoke

### Work Kind

text_test

### Depends On

- T3

### Parallel Group

None.

### Read First

- docs/context-and-computer-tools.md
- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/script/queue-compaction-smoke.ts
- src/mendcode/packages/opencode/test/tool/computer.test.ts

### Edit Files

- docs/context-and-computer-tools.md
- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/script/computer-use-smoke.ts

### New Files

- src/mendcode/packages/opencode/script/computer-use-smoke.ts

### Symbols

- package.json scripts.test:computer-use:manual
- computer-use-smoke.ts

### Interfaces

- test:computer-use:manual starts a bounded localhost fixture with named buttons, text field, scroll target and a state readout; it prints manual steps, owns a single-run lock, does not read global MendCode credentials/database, and cleans up server/lock/temp files on exit.
- Documentation distinguishes Full Mode awareness, actual runtime availability, activation approval, semantic-first flow, screenshot fallback, native macOS support and connected browser MCP support.

### Inputs

- Integrated computer tools and current beta build command.
- A real macOS terminal with Screen Recording, Accessibility and Automation permissions for manual evidence.

### Outputs

- Self-contained documentation and a local no-provider smoke fixture for the user/operator.
- No credentials, external service calls or paid model calls from the fixture itself.

### Operation Order

1. Add the script entry and isolated fixture with a single active-owner lock and signal-safe cleanup.
2. Document exact activation, permission, cursor, semantic and recovery behavior plus unsupported platforms.
3. Document connected Stagehand/browser MCP as conditional integration rather than a bundled dependency.
4. Keep benchmark claims absent unless later measured in MendCode with a recorded fixture.

### Error Semantics

- A second smoke run reports the owning PID and exits without taking over.
- Port conflict selects an OS-assigned localhost port or reports a bounded actionable failure; no fixed public listener.
- Signal/terminal exit removes only fixture-owned files and processes.

### Examples

- The fixture page exposes 'Increment', 'Open dialog', a labeled text field and a status region so semantic selection can be verified without external websites.
- Documentation says 'available when connected' for Stagehand MCP, not 'MendCode includes Stagehand'.

### Counterexamples

- A smoke that drives the user's real browser automatically, consumes provider tokens or reads the production database is not isolated evidence.
- Repeating an unverified '80% token saving' figure as a MendCode claim is prohibited.

### Non Goals

- No public benchmark, cloud Browserbase account, external website mutation or release publication in this task.

### Acceptance

- The fixture is deterministic, local, single-owner and cleans up on success/failure.
- Documentation is consistent with the actual schemas and clearly separates built-in macOS support from conditional MCP browser support.

### Required Capabilities

- code-read
- code-edit
- command

### Traces To

- REQ-4
- REQ-7
- REQ-8

### Verification

- kind: text_test
- procedure: bun test test/tool/computer.test.ts test/session/tool-discovery.test.ts test/mend/prompt/compose.test.ts && bun run typecheck
- cwd: src/mendcode/packages/opencode
- preconditions: T1-T4 are integrated and dependencies are unchanged or reinstalled with the repository package manager.
- expected: Focused behavioral tests and typecheck exit zero; documentation names only implemented or conditional capabilities.
- evidence: .agents/evidence/computer-use-integrated-tests.txt

- kind: text_test
- procedure: MENDCODE_VERSION=0.1.44-beta.10 MENDCODE_CHANNEL=beta bun run script/build.ts --single --skip-install --skip-embed-web-ui
- cwd: src/mendcode/packages/opencode
- preconditions: Run only during implementation after focused tests. Current release remains 0.1.44-beta.10 and the user still intends this work for that beta; otherwise use the approved version rather than silently reusing the command.
- expected: The native macOS binary builds, signs, and passes its version/help smoke without requiring a runtime compiler for the overlay.
- evidence: .agents/evidence/computer-use-build.txt


### Stop Condition

Stop if the fixture would need production credentials/database access, an external website, or a new browser dependency; replace it with a local deterministic surface.

## T5 — Verify native interaction and cursor states on macOS

### Work Kind

visual_test

### Depends On

- T4

### Parallel Group

None.

### Read First

- docs/context-and-computer-tools.md
- src/mendcode/packages/opencode/script/computer-use-smoke.ts
- src/mendcode/packages/opencode/src/computer/macos-overlay.ts

### Edit Files

None.

### New Files

None.

### Symbols

- test:computer-use:manual
- MacOSComputerOverlay state machine

### Interfaces

- Manual operator verification uses the packaged beta and isolated fixture; automation cannot self-certify the desktop visual/focus contract.
- Evidence records screen configuration, reduced-motion setting, prompt mode, permission decision, observed states and artifact paths without capturing private desktop content.

### Inputs

- Packaged macOS binary, isolated fixture, one-display and available external-display setup, and OS permissions.
- Explicit operator request authorizing the fixture interactions.

### Outputs

- Rendered/native evidence for activation, cursor states, focus, screenshot exclusion, cancellation and cleanup.
- PASS/FAIL/BLOCKED per scenario; missing external display is BLOCKED for only that adaptation scenario.

### Operation Order

1. Operator runs bun run test:computer-use:manual and starts the packaged MendCode binary in Full Mode.
2. Confirm no halo or computer activation appears during an unrelated coding prompt.
3. Ask MendCode to interact with the fixture, inspect the dedicated activation approval, approve the exact target and observe the halo before each pointer/typing mutation.
4. Verify semantic selection of labeled controls, state readout after action, screenshot without overlay pixels, target-change rejection, interruption cleanup and reduced-motion behavior.
5. Repeat display-edge/negative-origin behavior on an external display when available and record actual evidence.

### Error Semantics

- Any invisible control, focus theft, overlay captured by the model, stale-target action or orphan halo is FAIL and blocks release.
- Unavailable macOS permission is BLOCKED with the exact OS setting; it is not bypassed or called PASS.

### Examples

- Approved click on 'Increment' shows the acting halo, leaves browser focus behavior correct, and the fixture state changes from 0 to 1.
- Switching foreground apps after observation makes the pending action fail and removes the halo without clicking the new app.

### Counterexamples

- A unit test or build alone cannot prove that the overlay is visible, non-blocking and absent from screenshots.
- Testing against personal email, payments or production settings introduces unacceptable side effects.

### Non Goals

- No paid provider benchmark, real purchase/send/delete action, private-app capture, Windows/Linux visual acceptance or release publication.

### Acceptance

- All required one-display scenarios pass in the real packaged macOS binary and no action occurs for the unrelated prompt.
- The user/operator explicitly confirms the halo is clear but unobtrusive and that no focus or capture contamination occurred.

### Required Capabilities

- native macOS application interaction
- renderer
- vision
- visual inspection
- screen capture inspection
- keyboard and pointer interaction

### Traces To

- REQ-2
- REQ-4
- REQ-5
- REQ-6
- REQ-8

### Verification

- kind: visual_test
- procedure: Run `bun run test:computer-use:manual` from src/mendcode/packages/opencode, then execute the documented Full Mode scenarios with the packaged binary. Save only fixture-window screenshots for idle, activation, observing, acting, capture-clean, error and stopped states.
- cwd: src/mendcode/packages/opencode
- preconditions: Human operator present; macOS Screen Recording/Accessibility/Automation permissions granted; fixture contains no private data; packaged binary matches the implementation revision.
- expected: Computer Use is absent for unrelated work, requires activation for requested work, uses semantic controls, displays the exact halo states without focus theft, excludes the halo from model captures, and cleans up on every terminal path.
- evidence: .agents/evidence/computer-use-macos-visual.txt


### Stop Condition

Stop immediately on interaction with the wrong app, invisible control, focus theft, secure/private capture or an orphan overlay; preserve logs and do not continue mutations until repaired.

## T6 — Accept the integrated on-demand Computer Use contract

### Work Kind

acceptance

### Depends On

- T5

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/src/session/tool-discovery.ts
- src/mendcode/packages/opencode/src/tool/computer.ts
- src/mendcode/packages/opencode/src/computer/runtime.ts
- src/mendcode/packages/opencode/src/computer/macos-overlay.ts
- src/mendcode/packages/opencode/src/permission/index.ts
- docs/context-and-computer-tools.md

### Edit Files

None.

### New Files

None.

### Symbols

- Full Mode Computer Use playbook
- ComputerRuntime.Service
- ComputerSessionTool
- ComputerObserveTool
- ComputerCodeTool
- MacOSComputerOverlay

### Interfaces

- The accepted feature is the combined prompt, discovery, activation, semantic/code, permission, overlay, compatibility and documentation contract from REQ-1 through REQ-8.

### Inputs

- Integrated source and current evidence fingerprints from T1-T5.
- Operator confirmation for native rendered behavior.

### Outputs

- Acceptance ledger with actual revision, commands, native scenarios, result statuses, limitations and release blocker state.

### Operation Order

1. Inspect the integrated diff and current callers against every requirement and design scenario.
2. Reuse T1-T5 evidence only when relevant source, dependencies, packaged binary and environment fingerprints remain unchanged; otherwise rerun only invalidated checks and state why.
3. Confirm no Computer Use section appears outside Full Mode, no discovered tool acts without an active session, no invisible mutation path exists, and compatibility entry points retain their safety constraints.
4. Record unsupported Windows/Linux native control and absent browser MCP as limitations rather than failures of the contracted macOS release.
5. Block commit/push/tag/release until all required checks pass and the user confirms the manual native scenario.

### Error Semantics

- Any required FAIL, BLOCKED or NOT_RUN criterion prevents overall acceptance and release publication.
- A model assertion, source-file presence, unit-only result or screenshot-only result cannot substitute for the native interaction evidence.

### Examples

- Acceptance may reuse passing focused tests after a documentation-only correction, but must rerun visual evidence if overlay geometry or lifecycle changed.
- A connected Stagehand MCP can be documented as observed integration evidence; no MCP configured remains a truthful conditional limitation.

### Counterexamples

- Calling the feature complete because the beta builds ignores unsolicited-use and invisible-control risks.
- Publishing before the user's real TUI/native confirmation violates the MendCode release gate.

### Non Goals

- No merge, tag, GitHub release, deployment, dependency installation or cross-platform claim is authorized by this acceptance task itself.

### Acceptance

- REQ-1 through REQ-8 each have current discriminating evidence and no safety or visual criterion is unrun.
- The accepted release remains honest about macOS-only built-in control and conditional browser MCP availability.

### Required Capabilities

- code-read
- command
- native macOS application interaction
- visual inspection
- acceptance review

### Traces To

- REQ-1
- REQ-2
- REQ-3
- REQ-4
- REQ-5
- REQ-6
- REQ-7
- REQ-8

### Verification

- kind: acceptance
- procedure: Compare the integrated implementation and evidence artifacts against REQ-1 through REQ-8 and the design contract. Verify relevant file/build fingerprints; rerun only checks invalidated by changed inputs and record the reason.
- cwd: .
- preconditions: T1-T5 completed with current evidence, packaged binary and explicit user/operator native confirmation.
- expected: Every requirement and mandatory visual scenario is PASS, limitations are explicit, and publication remains a separate user-authorized release action.
- evidence: .agents/evidence/computer-use-acceptance.txt


### Stop Condition

If any required evidence is missing, stale or failing, mark acceptance blocked and return to its owning task; do not publish or relabel it PASS.

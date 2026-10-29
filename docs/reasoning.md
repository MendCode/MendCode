# Reasoning controls

`/model reasoning` (or `a` in `/model`) opens the shared bordered policy/runtime grid. Below 70 columns, `1`/`2` switches panels. Hints stay in the header; arrows scroll. Policy edits are drafts until Enter confirms; Esc discards and returns to models. `r` reloads, `o`/`s`/`a` chooses off/shadow/adaptive, `c` toggles evaluator processing consent, `p` selects the evaluator provider, `f` switches pause/baseline, `l` cycles 1/2/5 generations, `+`/`-` bounds decisions to 1–20 per turn, and `t` toggles Reasoning Auto. Saving neither changes the selected model/provider nor starts a model call.

## Opt-in policy

Default: off, no evaluator processing, OpenRouter, two-generation leases, eight decisions per turn, pause on failure. Host consent is stored atomically with mode 0600 under `<dataDir>/reasoning/<sha256(canonical-project)>/consent.json`. Project `.mendcode/adaptive-reasoning.json` may only reduce `mode`, `remoteProcessing`, `maxLeaseSteps` and `maxDecisionsPerTurn`; it cannot grant consent. Invalid, oversized or symlinked policy data fails off. Revisions reject stale saves. This is separate from user/project extension configuration.

The additive daemon commands are `reasoning.status { directory, sessionId? }` and `reasoning.configure { directory, config, expectedRevision, confirm: true }`. Typed client helpers are `reasoningStatus` and `configureReasoning`. Neither is exposed to read-only remote peers; configuration is not an agent tool.

Shadow evaluates but keeps baseline effort. Adaptive applies supported efforts to native main/plan generations only. Manual efforts, named variants, provider parameters, and manual changes during a turn win. Helper/child/compaction generations do not consume evaluator leases. A lease counts actual dispatches, not tool executions; it expires on turn completion, cancellation, compaction, policy or binding changes. Evaluation has a five-second deadline, at most two HTTP attempts, at most 20 decisions per turn and 64 active turns. Failures or decision exhaustion pause adaptive mode, or keep baseline for the rest of the turn when configured. Shadow always falls back to baseline. Diagnostics contain no prompts, credentials, tool outputs or upstream error bodies.

## Reasoning Auto

The remote JEV evaluator may select only supported `low`, `medium` and `high` efforts. Recommendations above `high` are rejected, including from custom evaluators. Manual higher efforts remain unchanged; this cap does not restrict the model picker.

`experimental.reasoning_auto` is false unless explicitly enabled, independently of evaluator consent. It selects the supported balanced effort (medium, otherwise low/high). The native `reasoning_auto` tool accepts `reason: verification_failed | technical_block` and concrete `evidence` of 1–1000 characters. It requests one supported increase, capped at high, for that turn only. Network errors, permission requests, unanswered questions and routine work are not escalation reasons. Manual choices always win. Shadow records requests without applying them. No evaluator or paid call is needed for this local policy.

## Evaluator boundary

No external service is connected automatically. Explicit daemon environment variables `MENDCODE_REASONING_ENDPOINT` and `MENDCODE_REASONING_TOKEN` enable a **literal loopback** HTTP(S) endpoint (`127.0.0.1` or `::1`), with bearer authentication and no redirects. Both variables and per-project processing consent are required. Supply credentials through the host's secret-backed environment, not a project file. The daemon budget guard runs before evaluation; measured tokens/cost enter its existing ledger, and unavailable usage remains unknown. Expensive-call confirmation is never implicitly approved.

The adapter sends only the public current goal (not expanded file mentions), latest visible progress and up to four paired/redacted tool results. It excludes system prompts, memory/instructions, attachments, tool arguments and private reasoning. Bounds: goal 8 KiB, progress 4 KiB, result 2 KiB each, request 24 KiB, response 64 KiB. Redaction is defensive, not proof that arbitrary user prose is nonsensitive; consent covers this data and potential evaluator charges.

Local proxies must preserve JEV's pinned contract: OpenRouter `typesafe/jev-1.13` with TypeSafe only and no fallbacks, or Gateway `typesafe-ai/jev` with `typesafe-ai` only. Answers are `answers.effort` and `answers.lease`, each `{ type: "choice", choice: "..." }`; leases are `"1"`, `"2"` or `"5"`. OpenRouter responses include `model`, `provider: "TypeSafe"` and optional snake-case usage; Gateway uses `model` and optional camel-case usage. Unexpected providers/models/efforts/leases fail closed. Tests inject transports and never use the network.

Open gap: real OpenRouter/Gateway authentication, deployment, billing and live contract acceptance require an explicitly authorized external-service run. The local adapter/runtime is not evidence of a working live service. Claude Code's own reasoning remains unchanged.

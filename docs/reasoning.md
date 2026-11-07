Choose a reasoning policy and control Reasoning Auto without changing your selected model or provider. Saving a policy does not start a model call.

## Reasoning controls

1. Open `/model reasoning`, or press `a` in `/model`. The shared bordered policy/runtime grid opens.
2. Adjust the policy with the keys below. Edits remain drafts.
3. Press Enter to confirm, or Esc to discard and return to models.

Hints stay in the header; arrows scroll.

| Key | Does |
| --- | --- |
| `1`/`2` | Switch panels below 70 columns |
| `r` | Reload |
| `o`/`s`/`a` | Choose off/shadow/adaptive |
| `c` | Toggle evaluator processing consent |
| `p` | Select the evaluator provider |
| `f` | Switch pause/baseline |
| `l` | Cycle 1/2/5 generations |
| `+`/`-` | Bound decisions to 1–20 per turn |
| `t` | Toggle Reasoning Auto |

## Opt-in policy

Start with the defaults, then opt in to evaluation and processing separately:

| Policy | Default |
| --- | --- |
| Mode | off |
| Evaluator processing | none |
| Provider | OpenRouter |
| Lease | two-generation leases |
| Decisions | eight decisions per turn |
| Failure behavior | pause on failure |

### Consent and policy files

Host consent is stored atomically with mode 0600 under `<dataDir>/reasoning/<sha256(canonical-project)>/consent.json`. This is separate from user/project extension configuration.

Project `.mendcode/adaptive-reasoning.json` may only reduce `mode`, `remoteProcessing`, `maxLeaseSteps` and `maxDecisionsPerTurn`; it cannot grant consent.

- Invalid, oversized or symlinked policy data fails off.
- Revisions reject stale saves.

### Effort and leases

| Mode | Behavior |
| --- | --- |
| Shadow | Evaluates but keeps baseline effort; always falls back to baseline |
| Adaptive | Applies supported efforts to native main/plan generations only |

Manual efforts, named variants, provider parameters, and manual changes during a turn win. Helper/child/compaction generations do not consume evaluator leases.

A lease counts actual dispatches, not tool executions. It expires on turn completion, cancellation, compaction, policy or binding changes.

| Evaluation limit | Bound |
| --- | --- |
| Deadline | five-second deadline |
| HTTP attempts | at most two HTTP attempts |
| Decisions | at most 20 decisions per turn |
| Active turns | 64 active turns |

Failures or decision exhaustion pause adaptive mode, or keep baseline for the rest of the turn when configured. Diagnostics contain no prompts, credentials, tool outputs or upstream error bodies.

### Daemon commands

The additive daemon commands and typed client helpers are:

| Command | Helper |
| --- | --- |
| `reasoning.status { directory, sessionId? }` | `reasoningStatus` |
| `reasoning.configure { directory, config, expectedRevision, confirm: true }` | `configureReasoning` |

Neither is exposed to read-only remote peers; configuration is not an agent tool.

## Reasoning Auto

The remote JEV evaluator may select only supported `low`, `medium` and `high` efforts. Recommendations above `high` are rejected, including from custom evaluators. Manual higher efforts remain unchanged; this cap does not restrict the model picker.

`experimental.reasoning_auto` is false unless explicitly enabled, independently of evaluator consent. It selects the supported balanced effort (medium, otherwise low/high).

The native `reasoning_auto` tool accepts `reason: verification_failed | technical_block` and concrete `evidence` of 1–1000 characters.

It requests one supported increase, capped at high, for that turn only. No evaluator or paid call is needed for this local policy.

- Network errors, permission requests, unanswered questions and routine work are not escalation reasons.
- Manual choices always win.
- Shadow records requests without applying them.

## Evaluator boundary

No external service is connected automatically. Both explicit daemon environment variables and per-project processing consent are required.

1. Supply `MENDCODE_REASONING_ENDPOINT` and `MENDCODE_REASONING_TOKEN` through the host's secret-backed environment, not a project file.
2. Grant per-project processing consent.

The variables enable a **literal loopback** HTTP(S) endpoint (`127.0.0.1` or `::1`), with bearer authentication and no redirects.

### Budget and data

The daemon budget guard runs before evaluation. Measured tokens/cost enter its existing ledger, and unavailable usage remains unknown. Expensive-call confirmation is never implicitly approved.

The adapter sends only the public current goal (not expanded file mentions), latest visible progress and up to four paired/redacted tool results.

It excludes system prompts, memory/instructions, attachments, tool arguments and private reasoning.

| Data | Bound |
| --- | --- |
| Goal | 8 KiB |
| Progress | 4 KiB |
| Result | 2 KiB each |
| Request | 24 KiB |
| Response | 64 KiB |

**Warning:** Redaction is defensive, not proof that arbitrary user prose is nonsensitive; consent covers this data and potential evaluator charges.

### Proxy contract

Local proxies must preserve JEV's pinned contract:

| Service | Model and provider |
| --- | --- |
| OpenRouter | `typesafe/jev-1.13` with TypeSafe only and no fallbacks |
| Gateway | `typesafe-ai/jev` with `typesafe-ai` only |

Answers are `answers.effort` and `answers.lease`, each `{ type: "choice", choice: "..." }`; leases are `"1"`, `"2"` or `"5"`.

| Response | Fields |
| --- | --- |
| OpenRouter | `model`, `provider: "TypeSafe"` and optional snake-case usage |
| Gateway | `model` and optional camel-case usage |

Unexpected providers/models/efforts/leases fail closed. Tests inject transports and never use the network.

### What remains unverified

Open gap: real OpenRouter/Gateway authentication, deployment, billing and live contract acceptance require an explicitly authorized external-service run.

The local adapter/runtime is not evidence of a working live service. Claude Code's own reasoning remains unchanged.

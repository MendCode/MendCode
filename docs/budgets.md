# Global USD budgets

Use global USD budgets to track known spend and gate model calls for this daemon data directory. Configure a policy and explicit prices, then check its status; this is a local known-spend gate, not a billing ceiling or account reconciliation.

## Configure a budget

1. Choose mode, thresholds and expensive-model confirmation in setup. You can opt into `api-usage` with a $1 warning, $3 stop and expensive confirmation enabled.
2. Use the additive `budget.set` command or the typed client's `setBudget` to configure tariffs and supplied spend. `settings.set` also accepts the validated policy.

The daemon setting `budgets` holds these fields:

| Setting | Default or requirement |
|---|---|
| `mode` | Default: `subscription` |
| `warnUsd` | Default: null; an empty threshold disables the warning |
| `stopUsd` | Default: null; an empty threshold disables the stop |
| `expensiveModelRequiresConfirm` | Default: off |
| `prices` | Explicit local tariffs in USD per million tokens, keyed by the exact catalog model ID |
| `suppliedUsd` | Explicitly supplied additional USD |

Amounts must be finite and nonnegative; stop must be at least warning. No historical or guessed price is used.

For example:

```json
{
  "mode": "api-usage",
  "warnUsd": 1,
  "stopUsd": 3,
  "expensiveModelRequiresConfirm": true,
  "prices": { "provider:model": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.5, "expensive": true } },
  "suppliedUsd": null
}
```

## Understand known spend

Known spend is lifetime cost for this daemon data directory plus explicitly supplied additional USD. It survives restarts and session deletion.

| Usage | How cost is counted |
|---|---|
| Provider-reported `costMicros` | Takes precedence over tariffs |
| Token usage without provider-reported cost | Priced using explicit tariffs |
| Cache usage | Needs explicit cache rates |
| Unknown calls | Stay counted as unknown, never free |
| Memory extraction adapters without detailed usage | Report unknown cost |

The ledger counts turns and daemon helpers alike, each once. `/usage` shows the helpers' calls apart, by role and model; see [usage](usage.md#auxiliary-calls).

## Know when calls stop

In API mode with known pricing, warning/stop compare `>=` before model calls. Stop blocks the next call, including native tool-loop steps, retries, compaction and daemon helpers.

**Warning:** A call already in flight can exceed the threshold.

- Subscription mode and unpriced models report `not-enforced`; unknown cost is visible.
- A malformed ledger fails closed.
- Explicitly marked expensive models require a foreground approval for each call. Unattended helpers fail instead of approving themselves.
- The daemon checks spend again after approval.

## Check status and diagnose failures

Use `control-plane budget status|doctor [--json]` to report policy, pricing availability, known/supplied spend and unknown calls.

Doctor validates the policy and ledger and exits 1 for failures. Reaching a valid stop threshold is reported as enforcement state, not corrupted configuration.

No network request occurs during these commands.

## How it works

`<dataDir>/budget/spend.json` retains known spend across restarts and session deletion. When no ledger exists, it is seeded once from retained usage.

Existing transport authentication applies; no new listener or external cost service is created. Tests use local fake services only.

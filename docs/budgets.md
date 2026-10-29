# Global USD budgets

The daemon setting `budgets` has `mode`, `warnUsd`, `stopUsd`, `expensiveModelRequiresConfirm`, `prices` and `suppliedUsd`. Default mode is `subscription`; thresholds are null and expensive confirmation is off. Setup can opt into `api-usage` with $1 warning/$3 stop and expensive confirmation enabled. Empty thresholds disable that threshold. Finite nonnegative amounts are required; stop must be at least warning.

Tariffs are explicit local values in USD per million tokens, keyed by the exact catalog model ID. No historical or guessed price is used:

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

Use the additive `budget.set` command or typed client's `setBudget` to configure tariffs/supplied spend; setup edits mode, thresholds and confirmation. `settings.set` also accepts the validated policy. Existing transport authentication applies; no new listener or external cost service is created.

Known spend is lifetime cost for this daemon data directory plus explicitly supplied additional USD. `<dataDir>/budget/spend.json` retains it across restarts and session deletion, seeded once from retained usage when no ledger exists. Provider-reported `costMicros` takes precedence; otherwise explicit tariffs price token usage. Cache usage needs explicit cache rates. Unknown calls stay counted as unknown, never free. Memory extraction adapters without detailed usage report unknown cost. This is a local known-spend gate, not a billing ceiling or account reconciliation.

In API mode with known pricing, warning/stop compare `>=` before model calls. Stop blocks the next call, including native tool-loop steps, retries, compaction and daemon helpers. A call already in flight can exceed the threshold. Subscription mode and unpriced models report `not-enforced`; unknown cost is visible. A malformed ledger fails closed. Explicitly marked expensive models require a foreground approval for each call; unattended helpers fail instead of approving themselves. The daemon checks spend again after approval.

`control-plane budget status|doctor [--json]` reports policy, pricing availability, known/supplied spend and unknown calls. Doctor validates policy/ledger and exits 1 for failures; reaching a valid stop threshold is reported as enforcement state, not corrupted configuration. No network request occurs during these commands. Tests use local fake services only.

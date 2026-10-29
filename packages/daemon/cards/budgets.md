---
summary: spend limits, token prices and usage figures
docs: budgets, usage, usage-limit
aliases: budget, cost, costs, spend, pricing
---
The daemon setting budgets: { "mode": "subscription" | "api-usage", "warnUsd", "stopUsd", "expensiveModelRequiresConfirm", "prices", "suppliedUsd" }. Default is subscription with no thresholds. Empty thresholds disable that threshold; amounts are finite and non-negative; stopUsd is at least warnUsd.
  { "mode": "api-usage", "warnUsd": 1, "stopUsd": 3, "expensiveModelRequiresConfirm": true,
    "prices": { "provider:model": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.5, "expensive": true } } }
Prices are explicit local USD per million tokens, keyed by the exact catalog model id; nothing is guessed, and a call without a known price is counted as unknown, never free. Known spend is the lifetime cost for the data dir (<data dir>/budget/spend.json) plus any suppliedUsd.
Read: {{program}} control-plane budget status | doctor; usage over time: {{program}} usage [--days N] [--models] [--tools N]; the user has /usage and /status. Change: the user's /setup (mode, thresholds, confirmation) or /settings, or mendcode_settings propose {"budgets":{...}} (the whole object), saved only on the user's Apply. A limit is the user's decision: never raise or remove one unless the user asked for that exact change.
The prompt's own cost per call: {{program}} docs prompt-modes. Provider quota windows (5h, weekly) and context: {{program}} docs usage. /stats-project inspects this project's usage.
When a provider limit stops a turn (feature usage_resume, on in every tier) the turn is paused, not lost: the transcript says when the window resets and the daemon resumes the same conversation then, even after a restart. The user's /limit shows, snoozes, resumes or cancels it; esc cancels when idle. Peers cannot schedule or resume it. Turning it off affects new pauses only.

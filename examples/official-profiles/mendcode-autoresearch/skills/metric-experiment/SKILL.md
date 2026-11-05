---
name: metric-experiment
description: Set up bounded metric experiments when explicitly requested
on-demand: true
---
Use the existing loop lifecycle, checks, audit and usage ledger. Before running, require the user's metric, direction, correctness checks, maximum iterations and token/cost budget. Work only in an explicitly authorized isolated worktree and select loop workspace `in-place` within it. Do not select loop-managed workspace `worktree`, whose release lifecycle commits changes. Never commit, reset, revert or modify the primary checkout automatically.

Record each iteration's numeric baseline, candidate, correctness gates, usage and receipt. A lower latency or higher score with any failed correctness gate is rejected. Unknown cost is not zero: stop when a cost cap cannot be enforced. Use the numeric acceptance helper in packages/loops/src/experiments.ts. Stop at the iteration cap or exhausted budget. Missing requirements remain pending; do not create another scheduler or infer authority from this skill's presence.

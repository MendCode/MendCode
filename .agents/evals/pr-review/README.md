# PR reviewer eval

Measures the PR reviewer (`packages/daemon/src/pr-review/`, docs/pr-review.md) on pull requests with seeded defects and on clean
ones: how much of what it would publish is right (precision), how many seeded defects it finds (recall), how many findings it
publishes on a PR with nothing wrong, and the provider-reported tokens per PR. Not part of the product.

```
bun .agents/evals/pr-review/run.ts --dry-run          # builds every case, checks each seeded line is one the diff adds; no model
bun .agents/evals/pr-review/run.ts --self-test --profiles quiet,normal,strict   # scoring end to end with a scripted reviewer; no model
./node_modules/.bin/tsc -p .agents/evals/pr-review/tsconfig.json --noEmit
```

## Cases

`cases/seeded.ts` (16 PRs, 17 defects) and `cases/clean.ts` (6 PRs, no defect). Each case is a base snapshot, the files the PR
writes and the seeded defects as `path:line` on the head with a category. The seeded ones cover an off-by-one, a missing await, an
optional dereference, SQL built from input, path traversal, a lost update across awaits, an inverted permission guard, a listener
leak, a quadratic loop, a swallowed failure, local time where UTC is required, non-integer money, a token written to logs, a cache
key missing a dimension, a test that asserts nothing, and two bugs in one function. The clean ones are correct versions of the same
shapes, so a reviewer that flags the shape and not the bug scores false positives there.

## What a run does

For every case, profile and repetition: a temp git repository with the base and head commits, the code graph indexed, the
review context built (`buildReviewContext`), then `reviewPullRequest` (review pass, verify pass, rank) with cap 30 so nothing is
folded away. The children are real sessions of a daemon started on a dedicated temp data dir (`--data-dir`, never `~/.mendcode*`;
the harness kit's `assertSafeStateRoot` refuses anything else), on the read-only `explore` agent in plan mode, with an isolated
`HOME`. `--auth-from ~/.codex` links that directory's `auth.json` and `models_cache.json` into the isolated home (read-only; the
daemon never rewrites them), exactly as the harness kit does.

Scoring: a published finding is a hit when it names the seeded file within ±2 lines of a defect; each defect counts once.
Precision = hits / published findings on seeded PRs; recall = hits / seeded defects (a case that times out counts as misses and is
also listed under timeouts); findings per clean PR = published findings / clean PRs. Tokens are summed from `usage.recorded` events
only (input = uncached + cache read + cache write; uncached = the `input` field). If any finished run reported no usage, the token
columns say "unreadable" and the run exits 2; they are never estimated. Each statistic is the mean ± sample sd over repetitions.

## Measurement

```
bun .agents/evals/pr-review/run.ts --reps 3 --model gpt-6-luna --effort medium --profiles quiet,normal,strict \
  --auth-from ~/.codex --data-dir /tmp/mcpr-data --out /tmp/mcpr-out
```

Only `gpt-6-luna` (any Claude model is refused). Writes `runs.jsonl` (one line per case run: findings with their hit, candidates,
whether verification succeeded, tokens, time), `daemon.log` and `t9.md` (the table) to `--out`. Target before calling the reviewer
better than anything: precision ≥ 0.8 on seeded PRs and ≤ 0.2 findings per clean PR, over 3 repetitions.

The self-test's token columns are 0 by construction (the scripted reviewer reports no usage); they say nothing about real cost.

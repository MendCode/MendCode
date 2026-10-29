---
summary: PR reviewer, repo watch, hosted Action, @mendcode
docs: pr-review
aliases: pr-reviewer, code-review, review-yaml
---
For: "review this PR", "why did MendCode comment on my PR", "configure the reviewer", "teach the reviewer".

A review has two passes in plan-mode child sessions: one finds candidate defects as JSON (line on the diff's new side, severity, category, file:line evidence), a fresh one tries to refute each. Only confirmed findings are published (strict also publishes plausible ones), ranked, at most `cap` (8); the rest are one "and N smaller notes" line. Context is the diff plus the code graph's callers and callees of each changed symbol, within half of budget.tokens_per_pr (200000).

Repo config .mendcode/review.yaml: enabled (false), profile quiet|normal|strict, cap 1..30, paths [{glob, instructions}], ignore, checks (run in the OS sandbox, no network, output to the verifier), fixes, triggers, budget. The base branch decides everything but path instructions, so a PR cannot turn checks or publishing on for itself. Learnings: .mendcode/review-learnings.md, one bullet each, read from the base branch, cut to 4 KB.

Switch: off until experimental.pr_review (feature pr_review, balanced tier up, permit). The user types /pr review [pr] (one PR now), /pr watch-repo (a new PR or new head starts a review; no model call while nothing changes), /pr unwatch-repo, /pr repos, /pr publish on|off (asked once before the first post to a repository). Posts are one COMMENT review with inline comments and hidden markers, never twice for the same finding or head. State: <dir>/pr-review/watches.json and one file per PR.

PR comments (write access only): @mendcode review | pause | resume | explain (reply to a MendCode comment) | fix (needs fixes: true; local daemon only; pushes one commit only if checks pass) | learn <text> (proposes the learnings line). A failing check on a reviewed head gets one explaining comment per failing set.

Hosted: `mendcode github install --hosted --model PROVIDER/MODEL --release TAG --sha256 HEX [--write]` writes .github/workflows/mendcode-review.yml (ubuntu-latest, pull_request never pull_request_target, the provider key secret plus GITHUB_TOKEN with pull-requests: write). It runs `github run --publish --review`, state from GitHub markers, no checks. A fork's run has no secret and says a maintainer can comment `@mendcode review`.

Data honesty: say which findings were confirmed and which were folded; never call a finding verified when the summary says verification failed.

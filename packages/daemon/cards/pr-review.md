---
summary: PR reviewer, repo watch, hosted Action, @mendcode
docs: pr-review, pr-review-setup
aliases: pr-reviewer, code-review, review-yaml
---
For: "review this PR", "set up PR review", "why did MendCode comment on my PR", "configure the reviewer", "teach the reviewer".

Two read-only child passes: one finds defects (JSON, file:line evidence), a fresh one tries to refute each. Only confirmed findings are posted (strict also plausible), at most `cap` (8). Context: diff plus code-graph callers/callees, within half of budget.context_tokens (200000/call); a larger diff is reviewed in parts.

Repo config .mendcode/review.yaml (base branch decides; a PR only adds path instructions): enabled (false), preset, profile quiet|normal|strict, cap, paths, ignore, checks (sandbox, no network), fixes, triggers, budget.tokens_per_pr (1000000 per head; null = no cap; at the cap candidates are kept, unposted), backlog {max_prs: 10, window_days: 30}, template.language (English, a name or auto = the PR author's; repo only). Learnings: .mendcode/review-learnings.md.

Set up PR review: call review_config setup first (read only, no scope): forge, login, configs, watches, claims, role signals, what is missing and the questions. Confirm the role, then preview/apply (with a scope). Review a PR now: pr_review review (or /pr review <n>); never post @mendcode from the user's account.

Switch: experimental.pr_review. /pr watch-repo [all|requested] reviews each new PR or head and, at start, up to backlog.max_prs open PRs with no review; /pr unwatch-repo, /pr repos, /pr publish on|off (asked once). A watch keeps the daemon up and survives restarts, sleep and outages (a lost repo ends it). Posts one COMMENT review with inline comments, never twice.

Platform: a budget, quota or rate-limit stop checkpoints (on_quota: wait) and resumes. .mendcode/reviewers.yaml routes to the global reviewer or personal ones (own memory); capabilities review|fix|publish are enforced. Jobs claim their PR (best-effort, checked before each write). fix.mode review|fix-once|fix-loop pushes only with fix.push and /pr publish on, else keeps a local ref; no force push. Stages none|fixed|dynamic; a stacked PR: own range. Forges: GitHub (gh), GitLab (glab), Gitea/Forgejo (GITEA_TOKEN); not on GitLab/Gitea: check follow-up, hosted run; Gitea: no thread resolve. /reviews (or /pr dashboard): jobs, retry, take over, audit (session only), config. State in <dir>/pr-review: watches.json outbox.json jobs.json effects.json accounting.json device.json ownership.json. Notices: no model turn unless experimental.pr_review_prompts.

PR comments (write access only): @mendcode review | pause | resume | explain | fix (needs fixes: true; local daemon) | learn <text>. Checked in order: permission, filters, reviewed head (one reply; the next push is reviewed).

Hosted: `mendcode github install --hosted --model PROVIDER/MODEL --release TAG --sha256 HEX [--write]` writes .github/workflows/mendcode-review.yml (pull_request, never pull_request_target).

Data honesty: say which findings were confirmed or folded; never call one verified if verification failed.

# GitHub automation (B48)

```sh
mendcode --dir /tmp/mend-ci github install --model openai/MODEL
mendcode --dir /tmp/mend-ci github install --model openai/MODEL --write
mendcode --dir /tmp/mend-ci github run --event "$EVENT_JSON"
mendcode --dir /tmp/mend-ci github run --publish --approve
mendcode --dir /tmp/mend-ci github run --attachments
mendcode --dir /tmp/mend-local pr 42
```

`install` previews `.github/workflows/mendcode.yml`; `--write` creates it without overwriting an existing file or following a symlink outside the checkout. Choose `--model PROVIDER/MODEL` or `MODEL`. The workflow uses a self-hosted runner with Git, `gh`, `mendcode` and provider credentials already configured. It is manual (`workflow_dispatch`), with publish and tool approval off by default. No App is installed, no browser opens and no workflow is pushed.

`run` accepts v1's `--event` JSON context (`eventName`, `repo: { owner, repo }`, `actor`, `payload`), or the invoking client's `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY` and `GITHUB_ACTOR`. Supported events: issue comments, review comments, issues, pull requests, schedules and workflow dispatch. `--prompt`/`PROMPT` is required for issues, schedules and workflow dispatch; PRs default to review. Comment mentions default to `/mendcode`, `/mc`, `/opencode`, `/oc`; configure `--mentions`/`MENTIONS`. Bare mentions summarize a thread or review the commented lines. Issue/PR context includes up to 100 comments, changed files, commits, reviews and review comments; the triggering comment is excluded. Context exceeding 180 KiB fails explicitly.

Authentication is `--token TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` (environment preferred to avoid shell history/process argv). The token stays in daemon memory until the run finishes; subprocesses receive it in their environment. It is never persisted to Git config, settings or transcript. No donor token exchange is contacted. The event repository must match the GitHub origin; actors must have write/admin/maintain permission, including workflow dispatch. Schedules rely on the explicitly provided token. `--model`/`MODEL` and `--variant`/`VARIANT` select the daemon's catalog; `--effort`/`EFFORT` sets the model's reasoning effort. Session permissions start at `ask`, even with a full-access default. `--approve` grants requested tools once; questions are denied by the existing headless runner.

The checkout must be clean, including staged and untracked files. Each run checks out its own branch and opens a daemon session. Output and changes stay local unless `--publish` is supplied. Publishing adds/removes the eyes reaction, commits changes, pushes to the issue branch or PR's actual head repository and posts the response. Issue/schedule/dispatch changes open a PR only when there are new commits; an existing PR for that branch is reused. If the agent changes branches, infrastructure does not commit or push. Failed/cancelled turns never publish; reactions and locks are released. No Git global identity/config is modified. An unfinished run after client loss is retained until daemon shutdown; do not start another run in that checkout until it is closed.

`pr NUMBER` uses authenticated `gh` to check out `pr/NUMBER` without `--force`, sets fork remotes/upstream when needed and enters the existing v2 TUI. It preserves conflicting remotes and refuses dirty checkouts. `--no-tui` and `--json` perform only checkout and exit. Donor `opncd.ai` session links are skipped, matching v1 MendCode mode.

All four protocol commands (`github.install`, `github.run`, `github.finish`, `pr.checkout`) require the local Unix socket; none is read-only. CLI remote attaches are refused before connection. No listener, webhook server, network dependency or provider is enabled by installation. A MendCode-owned GitHub App/action, OIDC exchange, and public session sharing (no sharing service) remain unavailable. Attachment links stay as context unless `run --attachments` is given: then up to five `github.com/user-attachments` links in the prompt, issue/PR body or comments are saved (5 MiB each, 15 s) to a private temp directory and replaced by `[attachment saved at PATH]`. The token goes only to github.com, redirects must stay on GitHub hosts and carry no token, and the files are deleted when the run ends. Reading them is an external-directory read, so it still needs `--approve` or an answered prompt. A turn that ends with tool calls and no text posts a short list of those calls instead of an empty reply. Live GitHub/runner validation requires the user's repository and credentials; automated tests use temp directories and local process/engine fakes.

Frames: `bun scripts/render-frames.ts .agents-frames/B48 --b48 100x30 180x50`.

## Hosted PR reviewer

```sh
mendcode --dir /tmp/mend-ci github install --hosted --model openai/gpt-6-luna --release v0.4.0 --sha256 HEX
mendcode --dir /tmp/mend-ci github install --hosted --model openai/gpt-6-luna --release v0.4.0 --sha256 HEX --write
```

`--hosted` previews `.github/workflows/mendcode-review.yml`, the [PR reviewer](pr-review.md) on GitHub's own `ubuntu-latest`
runners: on `pull_request` (opened, synchronize, ready_for_review) and on a comment that mentions `@mendcode` from an owner, member
or collaborator. `--write` creates it only when absent; an existing file is refused with its path. The workflow pins one release:
`--release TAG` and `--sha256 HEX`, the `install.sh` line of that release's `SHA256SUMS`; the job checks the installer against that
hash before running it, and `install.sh` checks the binary's SHA256 and cosign signature. A model the catalog does not know is
refused with the nearest ids; a provider with no API key (a local server, a cloud login) is refused with the ones that have one.

Secrets: the provider key named after the provider (`OPENAI_API_KEY` for `openai/...`, `OPENROUTER_API_KEY`, ...) as a repository
secret, and the job's own `GITHUB_TOKEN` with `contents: read` and `pull-requests: write`. Nothing else is stored, no App is
installed and the workflow is never pushed for you. The job runs `mendcode --dir "$RUNNER_TEMP/mc" github run --publish --review`,
which reviews the event's pull request in the checkout and appends the result to the job summary; posting still needs
`enabled: true` in `.mendcode/review.yaml` on the base branch. The runner keeps nothing: the state is rebuilt from the markers of
the earlier reviews that `GITHUB_TOKEN` itself wrote (a marker anyone else pasted is ignored).

Forks: the workflow uses `pull_request`, never `pull_request_target`, so a fork's code never runs with secrets. A fork's run gets no
secret, writes "MendCode review skipped: OPENAI_API_KEY is not available to this run ... A maintainer can comment `@mendcode review`"
to the job summary and succeeds without a review. The maintainer's comment runs in the base repository, which has the secret; the
review only reads the fork's code (plan-mode children, no checks: a hosted review never runs the repo's `checks`, since the job's
environment holds the provider key). It runs with `--safe-mode`, so extensions, packages, hooks, MCP servers and project tools
the checked-out pull request brings are never loaded next to that key. `github run --review` takes `--publish`, `--model`, `--mentions` and `--event`/`--token` like
`run`, not `--approve`, `--prompt` or `--attachments`.

# GitHub automation (B48)

Use GitHub automation to run MendCode against an issue or pull request, or check out a PR in the TUI. Runs keep output and changes local unless you choose to publish.

## Install a manual workflow

1. Preview `.github/workflows/mendcode.yml`:

```sh
mendcode --dir /tmp/mend-ci github install --model openai/MODEL
```

2. Add `--write` to create it. An existing file is not overwritten, and a symlink outside the checkout is not followed:

```sh
mendcode --dir /tmp/mend-ci github install --model openai/MODEL --write
```

For `install`, choose `--model PROVIDER/MODEL` or `MODEL`. The workflow uses a self-hosted runner with Git, `gh`, `mendcode` and provider credentials already configured.

The workflow is manual (`workflow_dispatch`), with publish and tool approval off by default. No App is installed, no browser opens and no workflow is pushed.

## Run against an event

```sh
mendcode --dir /tmp/mend-ci github run --event "$EVENT_JSON"
mendcode --dir /tmp/mend-ci github run --publish --approve
mendcode --dir /tmp/mend-ci github run --attachments
```

`run` accepts v1's `--event` JSON context (`eventName`, `repo: { owner, repo }`, `actor`, `payload`). Alternatively, it uses the invoking client's `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY` and `GITHUB_ACTOR`.

| Event | Prompt behavior |
|---|---|
| Issues, schedules, workflow dispatch | Require `--prompt`/`PROMPT` |
| Pull requests | Default to review |
| Issue comments, review comments | Mentions default to `/mendcode`, `/mc`, `/opencode`, `/oc`; configure `--mentions`/`MENTIONS`. Bare mentions summarize a thread or review the commented lines |

Issue/PR context includes up to 100 comments, changed files, commits, reviews and review comments; the triggering comment is excluded. Context exceeding 180 KiB fails explicitly.

### Authentication and permissions

Authenticate with `--token TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`. Prefer the environment to avoid shell history/process argv. The token stays in daemon memory until the run finishes; subprocesses receive it in their environment.

It is never persisted to Git config, settings or transcript. No donor token exchange is contacted.

The event repository must match the GitHub origin. Actors must have write/admin/maintain permission, including workflow dispatch. Schedules rely on the explicitly provided token.

| Option / environment | Does |
|---|---|
| `--model`/`MODEL`, `--variant`/`VARIANT` | Select from the daemon's catalog |
| `--effort`/`EFFORT` | Set the model's reasoning effort |
| `--approve` | Grant requested tools once |

Session permissions start at `ask`, even with a full-access default. Questions are denied by the existing headless runner.

### Checkout and publishing

The checkout must be clean, including staged and untracked files. Each run checks out its own branch and opens a daemon session. Output and changes stay local unless `--publish` is supplied.

Publishing adds/removes the eyes reaction, commits changes, pushes to the issue branch or PR's actual head repository and posts the response. A turn that ends with tool calls and no text posts a short list of those calls instead of an empty reply.

- Issue/schedule/dispatch changes open a PR only when there are new commits; an existing PR for that branch is reused.
- If the agent changes branches, infrastructure does not commit or push.
- Failed/cancelled turns never publish; reactions and locks are released.
- No Git global identity/config is modified.

**Warning:** An unfinished run after client loss is retained until daemon shutdown. Do not start another run in that checkout until it is closed.

### Attachments

Attachment links stay as context unless you give `run --attachments`. Then up to five `github.com/user-attachments` links in the prompt, issue/PR body or comments are saved to a private temp directory (5 MiB each, 15 s).

Saved links are replaced by `[attachment saved at PATH]`. The token goes only to github.com; redirects must stay on GitHub hosts and carry no token. The files are deleted when the run ends.

Reading them is an external-directory read, so it still needs `--approve` or an answered prompt.

## Check out a PR locally

```sh
mendcode --dir /tmp/mend-local pr 42
```

`pr NUMBER` uses authenticated `gh` to check out `pr/NUMBER` without `--force`, sets fork remotes/upstream when needed and enters the existing v2 TUI. It preserves conflicting remotes and refuses dirty checkouts.

`--no-tui` and `--json` perform only checkout and exit. Donor `opncd.ai` session links are skipped, matching v1 MendCode mode.

## Hosted PR reviewer

1. Preview `.github/workflows/mendcode-review.yml` with `--hosted`:

```sh
mendcode --dir /tmp/mend-ci github install --hosted --model openai/gpt-6-luna --release v0.4.0 --sha256 HEX
```

2. Add `--write` to create it only when absent. An existing file is refused with its path:

```sh
mendcode --dir /tmp/mend-ci github install --hosted --model openai/gpt-6-luna --release v0.4.0 --sha256 HEX --write
```

The workflow runs the [PR reviewer](pr-review.md) on GitHub's own `ubuntu-latest` runners:

- On `pull_request`: opened, synchronize, ready_for_review.
- On a comment mentioning `@mendcode` from an owner, member or collaborator.

### Pin a release and model

The workflow pins one release with `--release TAG` and `--sha256 HEX`, using the `install.sh` line of that release's `SHA256SUMS`. The job checks the installer against that hash before running it.

Then `install.sh` checks the binary's SHA256 and cosign signature. A model the catalog does not know is refused with the nearest ids. A provider with no API key (a local server, a cloud login) is refused with the ones that have one.

### Secrets and posting

| Secret | Requirement |
|---|---|
| Provider key | Repository secret named after the provider: `OPENAI_API_KEY` for `openai/...`, `OPENROUTER_API_KEY`, ... |
| Job's own `GITHUB_TOKEN` | `contents: read` and `pull-requests: write` |

Nothing else is stored, no App is installed and the workflow is never pushed for you. The job runs `mendcode --dir "$RUNNER_TEMP/mc" github run --publish --review` to review the event's pull request in the checkout and append the result to the job summary.

Posting still needs `enabled: true` in `.mendcode/review.yaml` on the base branch. The runner keeps nothing: state is rebuilt from markers of earlier reviews that `GITHUB_TOKEN` itself wrote. A marker anyone else pasted is ignored.

### Forks and safe mode

The workflow uses `pull_request`, never `pull_request_target`, so a fork's code never runs with secrets. A fork's run gets no secret and succeeds without a review. It writes this to the job summary:

> MendCode review skipped: OPENAI_API_KEY is not available to this run ... A maintainer can comment `@mendcode review`

The maintainer's comment runs in the base repository, which has the secret. The review only reads the fork's code with plan-mode children and no checks: a hosted review never runs the repo's `checks`, since the job's environment holds the provider key.

It runs with `--safe-mode`. Extensions, packages, hooks, MCP servers and project tools the checked-out pull request brings are never loaded next to that key.

| `github run --review` options | Support |
|---|---|
| `--publish`, `--model`, `--mentions`, `--event`/`--token` | Accepted, like `run` |
| `--approve`, `--prompt`, `--attachments` | Not accepted |

## Implementation and limits

All four protocol commands (`github.install`, `github.run`, `github.finish`, `pr.checkout`) require the local Unix socket; none is read-only. CLI remote attaches are refused before connection.

Installation enables no listener, webhook server, network dependency or provider. A MendCode-owned GitHub App/action, OIDC exchange and public session sharing (no sharing service) remain unavailable.

Live GitHub/runner validation requires your repository and credentials. Automated tests use temp directories and local process/engine fakes.

Frames: `bun scripts/render-frames.ts .agents-frames/B48 --b48 100x30 180x50`.

# Community

This page describes the public contribution surfaces for MendCode.

## Issues

Use issues for:

- reproducible bugs
- concrete feature requests
- docs bugs
- installer/release failures

Do not use issues for private vulnerabilities or leaked credentials. Use [SECURITY.md](../SECURITY.md).

## Discussions

Use discussions for:

- setup questions
- examples
- plugin/widget help
- package sharing patterns
- mflow/worktree usage
- model/provider configuration
- roadmap conversations

Suggested first announcement:

```markdown
# Welcome to MendCode Discussions

MendCode is now public.

Use this space for setup questions, package sharing, plugin/widget examples, mflow coordination, TSM/worktree workflows, model/provider configuration, and roadmap ideas.

Start here:

- Docs: https://github.com/MendCode/MendCode/tree/main/docs
- TUI plugins and widgets: https://github.com/MendCode/MendCode/blob/main/docs/tui-plugins-and-widgets.md
- Packages and team sharing: https://github.com/MendCode/MendCode/blob/main/docs/packages-and-team-sharing.md
- mflow: https://github.com/MendCode/MendCode/blob/main/docs/mflow.md
- Security policy: https://github.com/MendCode/MendCode/blob/main/SECURITY.md

Please do not post secrets, private config, API keys, or private vulnerability details.
```

## Pull Requests

PRs should be small, tested, and documented. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Labels

Recommended labels:

- `bug`
- `enhancement`
- `documentation`
- `security`
- `dependencies`
- `installer`
- `release`
- `tui`
- `plugins`
- `packages`
- `mflow`
- `worktrees`
- `question`
- `good first issue`

Labels can be created with `gh`:

```bash
gh label create installer --repo MendCode/MendCode --color 0E8A16 --description "Installer or install script"
gh label create release --repo MendCode/MendCode --color 5319E7 --description "Release process or assets"
gh label create tui --repo MendCode/MendCode --color 1D76DB --description "Terminal UI"
gh label create plugins --repo MendCode/MendCode --color BFDADC --description "Plugins, widgets, slots, or extension SDK"
gh label create packages --repo MendCode/MendCode --color FEF2C0 --description "Runtime packages and team sharing"
gh label create mflow --repo MendCode/MendCode --color C5DEF5 --description "mflow coordination"
gh label create worktrees --repo MendCode/MendCode --color D4C5F9 --description "TSM or worktree workflows"
```

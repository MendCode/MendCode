# Wiki

GitHub Wikis are backed by a separate Git repository:

```text
https://github.com/MendCode/MendCode.wiki.git
```

If the repository returns `Repository not found`, the wiki is enabled but has not been initialized with its first page.

## Suggested Wiki Structure

- `Home.md`: short overview and doc links.
- `Installation.md`: installer and release assets.
- `Packages.md`: company package sharing.
- `TUI-Plugins-and-Widgets.md`: plugin examples.
- `mflow.md`: coordination model.
- `TSM-and-Worktrees.md`: worktree workflows.
- `Security.md`: security reporting and public audit summary.

## Sync Docs to Wiki

Clone or initialize the wiki:

```bash
git clone https://github.com/MendCode/MendCode.wiki.git /tmp/mendcode-wiki
```

If the wiki repo does not exist yet:

```bash
mkdir -p /tmp/mendcode-wiki
cd /tmp/mendcode-wiki
git init
git remote add origin https://github.com/MendCode/MendCode.wiki.git
```

Copy selected docs:

```bash
cp /path/to/MendCode/docs/cli-setup-configuration.md Installation.md
cp /path/to/MendCode/docs/packages-and-team-sharing.md Packages.md
cp /path/to/MendCode/docs/tui-plugins-and-widgets.md TUI-Plugins-and-Widgets.md
cp /path/to/MendCode/docs/mflow.md mflow.md
cp /path/to/MendCode/docs/tsm-and-worktrees.md TSM-and-Worktrees.md
```

Create `Home.md`:

```markdown
# MendCode Wiki

MendCode is a terminal-first coding runtime built around the `mend` CLI, reusable packages, mflow coordination, optional TSM/worktrees, and a customizable terminal UI.

Start with:

- Installation
- Packages
- TUI Plugins and Widgets
- mflow
- TSM and Worktrees
- Security
```

Push:

```bash
git add .
git commit -m "Initialize MendCode wiki"
git push origin HEAD:master
```

The normal repo docs remain the source of truth. The wiki is a friendlier reading surface for the same material.

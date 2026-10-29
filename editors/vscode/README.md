# MendCode for VS Code

Runs the MendCode terminal client inside VS Code (also Cursor, VSCodium, Windsurf), types `@file` mentions into its prompt, and can share the active selection with it. See `docs/editor.md` (IDE context) in the repository.

Plain JavaScript, no build step, no dependencies. Install from the checkout:

```
cd editors/vscode && npx @vscode/vsce package && code --install-extension mendcode-0.1.0.vsix
```

or copy/symlink this folder to `~/.vscode/extensions/mendcode.mendcode-0.1.0`.

## Commands (Command Palette, `MendCode:`)

| command | does |
|---|---|
| Control Center (status bar item) | quick pick of everything below |
| Open / New Session | show or start `mendcode` in an editor terminal, cwd at the workspace folder |
| Add Selection to Prompt (`cmd/ctrl+alt+m`, editor menu) | types `@path?start=10&end=20` into the prompt, without sending |
| Add File to Prompt (explorer menu) | types `@path` |
| Fix Problems in File | types the file's errors and warnings (at most 20) into the prompt |
| Connect Editor Context | turns `mendcode.shareContext` on and types `/ide on vscode`; press Enter in the terminal |

## Settings

| setting | default | |
|---|---|---|
| `mendcode.command` / `mendcode.args` | `mendcode` / `[]` | run directly, never through a shell; machine scope, a workspace cannot change it |
| `mendcode.dataDir` | empty (`~/.mendcode-v2`) | passed as `--dir`; where the context is published |
| `mendcode.terminalLocation` | `panel` | or `editor` |
| `mendcode.shareContext` | `false` | publish the active file and selection to `<data dir>/ide/vscode/<hash>.json` (mode 600) for `/ide on vscode`; removed when the window closes |

The extension opens no network connection and starts no process: the terminal is VS Code's own. Only the daemon, after `/ide on vscode` in a project, reads the published file, and it refuses files outside that project.

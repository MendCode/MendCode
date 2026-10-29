# Uninstall

```
mendcode uninstall [--keep-config|-c] [--keep-data|-d] [--dry-run] [--force|-f] [--dir D] [--json]
```

This local command never connects to, launches, stops or signals a daemon. It reviews exact existing paths and byte counts before confirmation. The interactive review uses the shared panel grid; arrows/PageUp/PageDown scroll, `y` confirms, and Enter/Esc/`n` cancel. Piped input requires `--force` after reviewing `--dry-run` (exit 4 otherwise). `--force` skips only confirmation.

The data directory follows `--dir`, `MENDCODE_V2_DIR`, then `~/.mendcode-v2`. A copied SQLite is checked for the v2 schema; review never opens the original SQLite or creates WAL sidecars. A live writer-lock owner blocks execution, including forced execution. An invalid lock or a socket without a verifiable lock also blocks it. The daemon's writer lock is held while executing, so a daemon starting during confirmation causes refusal.

Only known v2 files are moved. Unknown files, symlinks and unverified databases/binaries stay in place and are listed in the report. v1/Codex locations and their ancestors are refused, including physical paths behind symlink aliases. Project files and shell startup files are not modified.

| Option | Preserved |
|---|---|
| `--keep-config` | SQLite settings, providers/ACP/MCP, terminal profile/keybindings, extensions, packages, agents, skills, commands, tools, themes, recipes and pet sources |
| `--keep-data` | SQLite sessions/events, usage/memory, encrypted session secrets and their key, blobs, snapshots, goals, reviews, side chats and project scratchpads |
| Both | Original database and both file groups |

Because settings and history share one SQLite, keeping only one prepares a retained database with the other group's records removed. The original is moved to Trash before the retained database is written. Cache/builtins and managed binaries are removed regardless of the keep flags. A changed target aborts before moving files; a failed move restores earlier moves. A cross-filesystem Trash rename fails safely rather than deleting the source.

Removed targets live in a private recovery folder under `~/.Trash` on macOS, `${XDG_DATA_HOME:-~/.local/share}/Trash/files` on Linux, or `%LOCALAPPDATA%/MendCodeV2/Trash` on Windows (a recovery folder, not the Windows Recycle Bin). `restore.json` maps original paths to the numbered filenames in that folder. Original database/WAL/SHM files must be restored together while no daemon is running. Trash retains credentials present in the original configuration; the report never prints those contents.

Installation ownership:

- `<data dir>/bin/mendcode-next[.exe]`, `.prev` and `.new` belong to the upgrade contract (the managed binary keeps its name `mendcode-next` inside the data directory) when the database is verified.
- POSIX/PowerShell installers now write `.mendcode-v2-install` beside `mendcode[.exe]`, containing its exact basename and SHA256 (and, since `--tier`, the starting tier as a fourth `tier=` line that uninstall accepts but does not need; see [releases](release.md#starting-tier)). Only a matching receipt permits removing that binary. `MENDCODE_INSTALL_DIR` selects a custom installer destination; a standalone executable also inspects its own installed path. Source runs never target the Bun executable.
- The development wrapper must match `scripts/install-dev.sh`'s exact marker/shape. `MENDCODE_NEXT_BIN_DIR` selects its directory.

Older unmarked installations, manually created links, package-manager ownership and Windows user PATH cleanup remain blocked pending destination/ownership policy. They are never inferred from the name `mendcode`, which v1 also uses. No package-manager command runs. Safe owned targets can still be removed; skipped targets return exit 1 with a partial result.

Exit codes: 0 complete/dry-run, 1 failure or partial, 2 cancelled, 4 needs confirmation, 64 usage. `--json`/`--format json` emits the existing `mendcode-next.cli.v1` envelope with `plan`, then `result` or `error`; no credential values are included.

Evidence: `bun scripts/render-frames.ts .agents-frames/B76 --b76 100x30 180x50`. This uses the production **local** review factory and temporary v2 stores, not a daemon-backed session screen.

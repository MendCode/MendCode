# Uninstall

Use uninstall to review exact existing paths and byte counts before moving known v2 files to Trash. You can keep configuration, data or both; this local command never connects to, launches, stops or signals a daemon.

## Review and confirm removal

1. Review the targets with `--dry-run`:

   ```sh
   mendcode uninstall --dry-run
   ```

2. Run uninstall with the options you want:

   ```sh
   mendcode uninstall [--keep-config|-c] [--keep-data|-d] [--dry-run] [--force|-f] [--dir D] [--json]
   ```

3. Check the exact paths and byte counts in the interactive review, then confirm or cancel.

The interactive review uses the shared panel grid:

| Key | Does |
|---|---|
| Arrows / PageUp / PageDown | Scroll |
| `y` | Confirm |
| Enter / Esc / `n` | Cancel |

For piped input, review `--dry-run` first, then use `--force`. Without it, the command exits 4. `--force` skips only confirmation.

The data directory follows this order: `--dir`, `MENDCODE_DIR`, then `~/.mendcode`.

### When removal is refused

- A live writer-lock owner blocks execution, including forced execution.
- An invalid lock or a socket without a verifiable lock also blocks execution.
- The daemon's writer lock is held while executing. A daemon starting during confirmation causes refusal.
- v1/Codex locations and their ancestors are refused, including physical paths behind symlink aliases.

Only known v2 files are moved. Unknown files, symlinks and unverified databases/binaries stay in place and are listed in the report. Project files and shell startup files are not modified.

## Choose what to keep

| Option | Preserved |
|---|---|
| `--keep-config` | SQLite settings, providers/ACP/MCP, terminal settings/keybindings, extensions, packages, agents, skills, commands, tools, themes, recipes and pet sources |
| `--keep-data` | SQLite sessions/events, usage/memory, encrypted session secrets and their key, blobs, snapshots, goals, reviews, side chats and project scratchpads |
| Both | Original database and both file groups |

Settings and history share one SQLite. Keeping only one prepares a retained database with the other group's records removed. The original is moved to Trash before the retained database is written.

**Note:** Cache/builtins and managed binaries are removed regardless of the keep flags.

## Recover removed files

Removed targets live in a private recovery folder:

| Platform | Location |
|---|---|
| macOS | `~/.Trash` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/Trash/files` |
| Windows | `%LOCALAPPDATA%/MendCodeV2/Trash`: a recovery folder, not the Windows Recycle Bin |

`restore.json` maps original paths to the numbered filenames in that folder. Original database/WAL/SHM files must be restored together while no daemon is running.

**Warning:** Trash retains credentials present in the original configuration. The report never prints those contents.

### If a move cannot complete

- A changed target aborts before moving files.
- A failed move restores earlier moves.
- A cross-filesystem Trash rename fails safely rather than deleting the source.

## Check installation ownership

Only verified ownership permits removal:

| Installation | Ownership check |
|---|---|
| Managed binary | When the database is verified, `<data dir>/bin/mendcode[.exe]`, `.prev` and `.new` belong to the upgrade contract. |
| POSIX/PowerShell installer | Installers now write `.mendcode-install` beside `mendcode[.exe]`, containing its exact basename and SHA256. Only a matching receipt permits removing that binary. |
| Development wrapper | `~/.local/bin/mendcode` written by `scripts/install-dev.sh`: removed only when it matches that script's exact marker and shape. `MENDCODE_BIN_DIR` selects its directory. |

Since `--tier`, the install receipt also contains the starting tier as a fourth `tier=` line. Uninstall accepts it but does not need it; see [releases](release.md#starting-tier).

`MENDCODE_INSTALL_DIR` selects a custom installer destination. A standalone executable also inspects its own installed path. Source runs never target the Bun executable.

These remain blocked pending destination/ownership policy:

- Older unmarked installations.
- Manually created links.
- Package-manager ownership.
- Windows user PATH cleanup.

Ownership is never inferred from the name `mendcode`, which v1 also uses. No package-manager command runs. Safe owned targets can still be removed; skipped targets return exit 1 with a partial result.

## Read the result

| Exit code | Meaning |
|---|---|
| 0 | Complete/dry-run |
| 1 | Failure or partial |
| 2 | Cancelled |
| 4 | Needs confirmation |
| 64 | Usage |

`--json`/`--format json` emits the existing `mendcode.cli` envelope with `plan`, then `result` or `error`. No credential values are included.

## How review works

A copied SQLite is checked for the v2 schema. Review never opens the original SQLite or creates WAL sidecars.

Evidence: `bun scripts/render-frames.ts .agents-frames/B76 --b76 100x30 180x50`. This uses the production local review factory and temporary v2 stores, not a daemon-backed session screen.

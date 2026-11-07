Move your own MendCode setup between data directories, such as from a laptop to a server, in one configuration bundle you can check. The bundle says what it carries, what it leaves out and why.

## Personal configuration bundles

A profile is something to share and install; a bundle is your own setup. To move it:

1. Inventory the source data directory. This read-only command shows what it holds in five columns.

   ```sh
   mendcode config-bundle inventory
   ```

2. Export one file with a manifest, the sha256 of every file and a list of exclusions.

   ```sh
   mendcode config-bundle export me.json
   ```

3. Inspect the bundle at the target. This checks every hash and reads nothing else.

   ```sh
   mendcode --dir /tmp/try config-bundle inspect me.json
   ```

4. Preview the import. Nothing changes; the command prints the plan id.

   ```sh
   mendcode --dir /tmp/try config-bundle import me.json
   ```

5. Apply exactly that plan.

   ```sh
   mendcode --dir /tmp/try config-bundle import me.json --apply --plan <id>
   ```

To list earlier imports of this data directory or roll one back:

```sh
mendcode --dir /tmp/try config-bundle imports
mendcode --dir /tmp/try config-bundle rollback <import-id> [--force]
```

## What `profiles create` exports, and why a bundle exists

`profiles create` (docs/profiles.md) snapshots a **project's** `.mendcode/` folder into `.mendcode/package-local/`. It also records settings in `runtime-pack.json`, but never applies that record when the profile is installed.

The record includes model ids and effort, prompt mode, memory switches, default permission and rules, and terminal settings.

It does not read your data directory. Your own skills, commands, extensions, `AGENTS.md`, keybindings, installed profiles and their on/off state are not included.

The installed profile does not restore your settings. A bundle covers that user side.

## The five columns

`inventory` and `export` put every entry of the data directory, every installed profile, every settings key and every
terminal-customize key that needs approval in one of these columns:

| Column | What | On import |
| --- | --- | --- |
| exportable | skills, commands, agents, themes, recipes, contracts, goal prompts, `SYSTEM.md`/`APPEND_SYSTEM.md`/`COMPACTION.md`, `AGENTS.md`, `keybindings.json`, `tui/profile.json`, `tui/models.json`, `activation.json`, installed profiles that run no code, preference settings (theme, view, pet, cache, compaction, memory limits, retention, output style…) | written, merged key by key, or installed with the profile installer |
| omitted | the database and its WAL, sessions, transcripts, tool output, logs, caches, budgets, the Trash, `builtin` (the target has its own), pets with a private reference image, per-session looks | nothing |
| machine-specific | links (never followed: `AGENTS.md -> ~/code/...`), folder-keyed settings (`trustedToolDirs`, `projectConfig`, `areas`, `memoryProjects`…), shells and environment, `prompt-context.json`, `package-sources.json`, helper and cache files under `tui/` | shown, never applied |
| needs authentication or approval | `providers.json`, `environment.enc`, `keys/`, remote and share tokens (never read or exported); code that runs on its own (extensions, tools, hooks, status line, workflows, profiles that ship them, scripts); MCP servers; settings of your authority (models, permissions and rules, tier, features, experimental, budgets, sandbox, providers, agents…); customize keys that start things or touch the clipboard (`processMode`, `fileOpener`, `copyOnSelect`…) | code is quarantined; MCP servers arrive pending; the rest waits in `pending.json` |
| not portable | native executables (Mach-O, ELF, PE) | nothing: rebuild them on the target |

A file with credential-like text is left out. The listing shows the kind and line of each finding, never the text.

After reviewing a false positive, use `export --allow-flagged PATH` to include a file or folder such as `packages/seda`. The bundle's warnings record this choice.

A profile travels whole or not at all.

## Import: preview, conflicts, precedence

The preview changes nothing. It lists:

- What would be written.
- Every conflict and the resolution that decides it.
- What is quarantined, waiting for approval or blocked.
- Names held by both a profile and your own folder.
- Warnings and everything the export left out.

For shared names, your own folder wins; a project's `.mendcode` can override both.

### Resolve conflicts

A conflict is an item that exists here with other content:

| Item | Conflict unit |
| --- | --- |
| Resource | `skills/x`, `commands/y.md`, `AGENTS.md` |
| Profile | `packages/<name>`: other files, or the same files but on here and off in the bundle |
| MCP server | `mcp.json#<server>` |
| Setting | `settings.<key>` |
| Terminal preference | `tui/profile.json#<key>` |

| Option | Resolution |
| --- | --- |
| `--on-conflict keep` (default) | Keep this machine's version |
| `replace` | Take the bundle's version |
| `--resolve ITEM=keep|replace` | Decide one item |

Nothing is ever written through a link. An item whose path crosses one is blocked and named.

### Apply the previewed plan

`--apply` needs `--plan` with the id the preview printed. If the bundle, target or an option changed since, the id no longer matches and nothing is applied.

## Paths, platforms and dependencies

Every exported text file is scanned for machine-specific references. The preview warns about each:

- The source home folder.
- `/Users/…` or `/home/…` paths.
- macOS-only places and commands: `Library/Application Support`, `osascript`, `pbcopy`, Homebrew.

Use `--rewrite-home` to replace the source home folder with this machine's in those files and in preference settings. The plan records which files were rewritten.

A different operating system is a warning. Quarantined scripts list the modules they import that must exist on the target.

## What an import never does

### Run code or start servers

Extensions, tools, hooks, status-line and other scripts, and profiles that ship them are copied to `<data dir>/config-imports/<id>/quarantine/`. No loader reads that folder.

Review them, then move them into place or install the profile yourself with `mendcode profile install <folder>`.

Each MCP server is added disabled with a pending approval (24 h) you answer in `/mcp`. This is the same path as `/import setup` and the REST API. Env and header values must be secret references.

### Change your authority

Models, permissions and rules, trust, tier, features, budgets and other approval settings are written to `config-imports/<id>/pending.json`.

Set them in `/settings`, `/permissions` or `/customize`, or ask a session to propose them with `mendcode_settings` and approve each card. Trust grants (`trustedToolDirs`) are never carried.

### Write the database or apply from a session

The import never writes `mendd.db`:

| Resource | Daemon commands |
| --- | --- |
| Settings | `settings.set` |
| Profiles | `profiles.install`, `profiles.enable` and `profiles.resource` |

These are the same daemon commands `/profiles` and `/settings` use. Files are written atomically by the local command, never through a link.

An agent's shell is refused `--apply` and `rollback`; an import cannot run from a session.

## Backups, rollback and the report

Every change is recorded in `config-imports/<id>/journal.json` before it is made. Replaced files move to `backup/`; a replaced profile is copied there first.

If any step fails, the import undoes what it did and says so.

### Roll back an import

`rollback <id>` reverts newest first:

| Resource | Rollback result |
| --- | --- |
| Files, profile and `mcp.json` | Restored byte for byte; pending MCP slots are released |
| New profiles | Moved to the Trash with their on/off and resource switches undone |
| Replaced profile | Reinstalled from its backup |
| Settings | Returned to their previous values |

Anything changed by hand since the import is skipped and listed. `--force` reverts it too. A second rollback resumes where the first stopped.

### Read the report

After applying, the import compares the bundle with what the target holds now, item by item in `report.json`.

Results are match, differs, kept-target, blocked, quarantined, pending-approval or omitted.

The report says "identical" only when every item matches and nothing was left out, quarantined or left for approval.

A real migration always has omissions (credentials, history). The summary therefore says how many items match and what is not identical.

## Limits

| Limit | Bound |
| --- | --- |
| Files | At most 10,000 |
| Bundle size | 64 MB |
| Exported content | Exports stop at about 45 MB |

Bundles cover user scope only. A project's own `.mendcode/` travels with the project or with `profiles create`.

**Warning:** Bundles are not signed. The hashes prove the file is unchanged since export, not who made it.

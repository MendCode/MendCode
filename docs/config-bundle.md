# Personal configuration bundles

A configuration bundle moves your own MendCode setup from one data directory to another (a laptop to a server, say) as
one file you can check. It is separate from packages: a package is something to share and install; a bundle is your
setup, and it says plainly what it carries, what it leaves out and why.

```sh
mendcode config-bundle inventory                         # what this data directory holds, in five columns (read-only)
mendcode config-bundle export me.json                    # one file: manifest, sha256 of every file, exclusions listed
mendcode --dir /tmp/try config-bundle inspect me.json    # checks every hash; reads nothing else
mendcode --dir /tmp/try config-bundle import me.json     # preview: changes nothing, prints the plan id
mendcode --dir /tmp/try config-bundle import me.json --apply --plan <id>   # applies exactly that plan
mendcode --dir /tmp/try config-bundle imports            # earlier imports of this data directory
mendcode --dir /tmp/try config-bundle rollback <import-id> [--force]
```

## What `packages create` exports, and why a bundle exists

`packages create` (docs/packages.md) snapshots a **project's** `.mendcode/` folder into `.mendcode/package-local/`, plus a
settings record in `runtime-pack.json` (model ids and effort, prompt mode, memory switches, default permission and rules,
terminal profile) that is never applied when the package is installed. It does not read your data directory: your own
skills, commands, extensions, `AGENTS.md`, keybindings, installed packages and their on/off state are not in it, and the
installed package does not restore your settings. A bundle covers that user side.

## The five columns

`inventory` and `export` put every entry of the data directory, every installed package, every settings key and every
terminal-profile key that needs approval in one of these columns:

| Column | What | On import |
| --- | --- | --- |
| exportable | skills, commands, agents, themes, recipes, contracts, goal prompts, `SYSTEM.md`/`APPEND_SYSTEM.md`/`COMPACTION.md`, `AGENTS.md`, `keybindings.json`, `tui/profile.json`, `tui/models.json`, `activation.json`, installed packages that run no code, preference settings (theme, view, pet, cache, compaction, memory limits, retention, output style…) | written, merged key by key, or installed with the package installer |
| omitted | the database and its WAL, sessions, transcripts, tool output, logs, caches, budgets, the Trash, `builtin` (the target has its own), pets with a private reference image, per-session looks | nothing |
| machine-specific | links (never followed: `AGENTS.md -> ~/code/...`), folder-keyed settings (`trustedToolDirs`, `projectConfig`, `profiles`, `memoryProjects`…), shells and environment, `prompt-context.json`, `package-sources.json`, helper and cache files under `tui/` | shown, never applied |
| needs authentication or approval | `providers.json`, `environment.enc`, `keys/`, remote and share tokens (never read or exported); code that runs on its own (extensions, tools, hooks, status line, workflows, packages that ship them, scripts); MCP servers; settings of your authority (models, permissions and rules, tier, features, experimental, budgets, sandbox, providers, agents…); profile keys that start things or touch the clipboard (`processMode`, `fileOpener`, `copyOnSelect`…) | code is quarantined; MCP servers arrive pending; the rest waits in `pending.json` |
| not portable | native executables (Mach-O, ELF, PE) | nothing: rebuild them on the target |

A file with credential-like text is left out and listed with the kind and line of each finding, never the text. After
reviewing a false positive, `export --allow-flagged PATH` (a file or a folder such as `packages/seda`) includes it, and
the bundle's warnings say so. A package travels whole or not at all.

## Import: preview, conflicts, precedence

The preview changes nothing. It lists what would be written, every conflict with the resolution that decides it, what is
quarantined, what waits for approval, what is blocked, which names a package and your own folder both hold (your own
folder wins; a project's `.mendcode` can override both), warnings and everything the export left out. A conflict is an item
that exists here with other content: a resource unit (`skills/x`, `commands/y.md`, `AGENTS.md`), `packages/<name>` (other
files, or the same files but on here and off in the bundle), `mcp.json#<server>`, `settings.<key>` or
`tui/profile.json#<key>`. `--on-conflict keep` (the default) keeps this machine's version; `replace` takes the bundle's;
`--resolve ITEM=keep|replace` decides one item. Nothing is ever written through a link: an item whose path crosses one is
blocked and named.

`--apply` needs `--plan` with the id the preview printed. If the bundle, the target or an option changed since, the id no
longer matches and nothing is applied.

## Paths, platforms and dependencies

Every exported text file is scanned for its machine: the source home folder, `/Users/…` or `/home/…` paths, macOS-only
places and commands (`Library/Application Support`, `osascript`, `pbcopy`, Homebrew). The preview warns about each one;
`--rewrite-home` replaces the source home folder with this machine's in those files (and in preference settings), and the
plan records which files were rewritten. A different operating system is a warning. Quarantined scripts list the modules
they import that must exist on the target.

## What an import never does

- Run anything: extensions, tools, hooks, status-line and other scripts, and packages that ship them are copied to
  `<data dir>/config-imports/<id>/quarantine/`, which no loader reads. Review them, then move them into place or install the
  package yourself (`mendcode package install <folder>`).
- Start an MCP server: each one is added disabled with a pending approval (24 h) you answer in `/mcp`, the same path as
  `/import setup` and the REST API. Env and header values must be secret references.
- Change your authority: models, permissions and rules, trust, tier, features, budgets and the other approval settings
  are written to `config-imports/<id>/pending.json`. Set them in `/settings`, `/permissions`, `/customize`, or ask a session
  to propose them with `mendcode_settings` and approve each card. Trust grants (`trustedToolDirs`) are never carried.
- Write `mendd.db`: settings go through `settings.set`, packages through `packages.install`, `packages.enable` and
  `packages.resource`, the same daemon commands `/packages` and `/settings` use. Files are written atomically by the local
  command, never through a link.
- Run from a session: an agent's shell is refused `--apply` and `rollback`.

## Backups, rollback and the report

Every change is recorded in `config-imports/<id>/journal.json` before it is made, with the replaced files moved to
`backup/` (a replaced package is copied there first). If any step fails, the import undoes what it did and says so.
`rollback <id>` reverts newest first: files, profile and `mcp.json` come back byte for byte (and the pending MCP slots are
released), new packages go to the Trash with their on/off and resource switches undone, a replaced package is reinstalled
from its backup, and settings return to their previous values. Anything changed by hand since the import is skipped and
listed; `--force` reverts it too. A second rollback resumes where the first stopped.

After applying, the import compares the bundle with what the target holds now, item by item (`report.json`): match,
differs, kept-target, blocked, quarantined, pending-approval, omitted. It says "identical" only when every item matches and
nothing was left out, quarantined or left for approval; a real migration always has omissions (credentials, history), so
the summary says how many items match and what is not identical.

## Limits

A bundle holds at most 10,000 files and 64 MB (exports stop at about 45 MB of content). User scope only: a project's own
`.mendcode/` travels with the project (or with `packages create`). Bundles are not signed: the hashes prove the file is
unchanged since export, not who made it.

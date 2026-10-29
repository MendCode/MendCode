# Packages

One package can change how MendCode looks and what it offers, and removing it puts everything back. This page starts with
a 10-minute guide to making your own, then says exactly what a package can and cannot change, and then is the reference
for installing, catalogs and trust.

## Manage packages in chat

Self-management guidance is `mendcode docs packages` (and `mendcode docs extensions`), a short reference card embedded in the binary;
the one-line pointer to `mendcode docs` is in the system prompt. The cards are generated from `packages/daemon/cards/*.md` and the repository docs
(`bun scripts/self-knowledge.ts`; add `--check` to verify only). Discover `packages` through `tool_search`:
its schema is deferred even when general tool discovery is off. The `package_tools` feature belongs to balanced/full.

Read-only actions are `list`, `info`, `search` and `check`. `info` includes contents, capabilities and the existing precedence
report (including command providers). Mutations are `install`, `enable`, `disable`, `switch-look`, `remove` and `new`.
Every mutation requires the normal approval card, including full permission mode; the preview includes source, version,
content fingerprint, overlay keys, keybindings, resource collisions and current look. A changed preview invalidates approval.
The fingerprint hashes every byte of every file. The preview's `tree` is a bounded summary of the package folder: file and byte totals,
files and bytes per top-level folder (twelve at most), the five largest files, and every file that can run or configure something
(an executable bit, a script or binary extension, `hooks.json`, `mcp.json`, `statusline.json`, anything under `hooks/`, `bin/`,
`scripts/`, `tools/` or `extensions/`), listed in full with the reason. The static capability scan reads only part of a large package;
the preview then says `capabilityScan: partial` and the `runnable` list is the complete one. A tree over a hard limit is refused with
the limit, the measured value and the shell command to run instead (`mendcode package enable <name>`): 2,000 files and 20 MB (the
installer's own limits), 12 folder levels, or more than 150 runnable files, which the approval could not list one by one. Links stay refused.
Project mutations require trust; remote/peer sessions cannot read or mutate packages. Removal always uses Trash.

Chat installation requires an exact name and configured source ID with a complete local directory preview; remote npm/git
entries remain available for manual `/packages` review, not chat installation. No source is added and no refresh/network is
performed by this tool. Several skill packages can coexist. `switch-look` uses the existing explicit switch rule;
disabling the owner restores the previously enabled look. The tool and `/packages` call the same daemon handlers.
`new` uses the same scaffold as `mendcode package new`, in the project or `<dataDir>/package-drafts`; it does not enable it.

## Make your own MendCode in 10 minutes

Every command below takes `--dir /tmp/mend-data` to use a throwaway data folder while you try things.

**1. New.** `mendcode package new mylook` writes `./mylook/`, a complete and commented package that already loads:
`mendcode-package.json` (with an `activate` section), a theme, two view modules (`message.assistant`, `tool.card`), a slash
command, a skill, a keybindings file, a workflow, `docs/hooks.example.json` (an example, not loaded) and a README.
`--dir PARENT` chooses the folder it goes in. It refuses a name that exists and writes nothing outside the new folder.

**2. Edit.** Change the colors in `themes/mylook.json`, the keys in `keybindings.json`, the profile values under
`activate.tuiProfile` (the same keys and values `/customize` shows). The look of one surface is one small file in
`extensions/`: a view is a pure synchronous function from data to styled rows ([views](views.md)). The finished example,
a full amber-phosphor reskin, is `examples/packages/retro/`: theme, transcript rails, line-printer tool cards, a columns
slash menu, a home screen, a panel card and a key. `examples/packages/tool-renderers/` is the smaller one for tool cards:
shell commands and GitHub MCP calls drawn from their arguments with `renderTool`.

**3. Check.** `mendcode package check ./mylook` reads the folder without running any of it and reports errors (the
manifest does not match the schema, `compatibility` rules out this MendCode, a forbidden `activate` key, a view module that
is missing, a resource file with invalid JSON, a capability the code uses but the manifest does not declare, a package over
2,000 files or 20 MB) and warnings (a declared capability the code never uses, an environment variable it reads, an unknown
top-level entry). It exits 1 on any error.

**4. Enable.** `mendcode package install ./mylook` installs a copy and turns it on. Open `/packages` to see what it
currently overrides: `o` lists every setting, key and view it takes over, `k` there keeps your own value for one of
them, `d` turns the package off, `p` shows the one precedence report. Extension and view code reloads while you edit the
installed copy; the profile part applies at once.

**5. Share.** Put the folder in a git repository. Anyone installs it with `mendcode package install github:you/mylook`
(pin a commit with `#<40-hex>`). `mendcode packages create` builds a package from a project's own `.mendcode/` folder instead
of from scratch: it covers every surface a loader reads there (skills, commands, agents, tools, hooks, MCP, themes, recipes,
workflows, contracts, keybindings, prompt files, extensions, status line) plus a settings record it never applies. It does
not read your data directory; to move your own setup between machines use a configuration bundle ([config-bundle](config-bundle.md)).

### What a package can change

| Surface | How |
| --- | --- |
| Theme | `themes/<name>.json`, chosen with `activate.theme` |
| Bitmap pets | `pets/<id>/pet.json` plus its PNG/WebP atlas; `/pet` lists enabled local packages with `package:<id>` references. Non-executable, no automatic generation or selection; `/pet export user:<uuid>` creates an atlas/manifest package without its private reference PNG |
| Terminal profile | `activate.tuiProfile`: logo, tagline, home layout, prompt chrome and border, user lead, done symbol, density, slash menu layout and pins, panel cards (`sidebarWidgets`) and the rest of `/customize` |
| Tier look | `activate.tier`: the terminal side of a tier (presentation, density, whether the right panel hides). Features, prompt mode and process mode stay yours |
| Right panel | `activate.panelPreset` (`pulse`, `crew`, `ledger`, `focus`, `full`, `galaxy`) |
| Views | `activate.views` maps one of the 22 view slots to a module in `extensions/` (transcript messages, tool cards, the slash menu, headers, footers, welcome and so on) |
| Keybindings | `activate.keybindings`: a file in the format of `keybindings.json` |
| Prompt files | `SYSTEM.md`, `APPEND_SYSTEM.md`, `COMPACTION.md` in the package; `activate.promptFiles` lists the ones it expects |
| Things it adds | skills, commands, agents, tools, hooks, MCP servers, themes, recipes, workflows, contracts, extensions, status line |

### What a package cannot change

- The engine, model providers and the transport to them.
- Permission mode, approval rules, trust, provider credentials, budgets, features, experimental flags, `tools`, `hooks`,
  `mcp`, `sandbox`, `network`, models, safe mode, and which packages are enabled: a manifest that tries any of these in
  `activate` fails the schema (`package check` and the install both say so), and the same names are refused anywhere in
  the profile it ships. Profile keys that start things, spend calls, touch the clipboard or the network, or switch your own
  extensions off (`processMode`, `altScreen`, `copyOnSelect`, `turnNotify`, `fileOpener` and others) are refused too.
- The prompt editor, the dock and the live compaction panel: they are not view slots. A package can only restyle them
  through the profile (prompt chrome, border, lead).
- Page bodies are typed data, not code: `/customize`, `/settings` and the other pages keep their own layout.
- A remote or peer client cannot enable, switch, install, remove or restore a package. A package that ships project code
  (tools, hooks, workflows, agents) does nothing in a project that is not trusted; its claims are listed as "needs project trust".

Extension and view code runs in the terminal process with your permissions: it can read your files and make network
calls. The view budget (4 ms per call, three strikes and the view is off) keeps a slow or throwing view from reaching a
frame, but a view that never returns cannot be interrupted from inside the same process (an infinite synchronous loop stops
that terminal until it is closed; start again with `--safe-mode`, which loads no extensions or packages, and disable the
package). Treat a package like any program you install: read it, pin it, prefer ones whose
`capabilities` are small. Static analysis in `package check` and in the preview shows what the code appears to use, never
a guarantee that it does nothing else.

### How activation works: an overlay, never an edit

The rule, in two lines. The effective value of a profile key is: your explicit choice made after the package was enabled,
then the package's value, then your stored value. Nothing is written to your `profile.json`, `keybindings.json` or
settings, so disabling or removing the package removes the overlay and your stored files are what they were, including
for keys you changed by hand while it was on: those wait with the package (below) and come back when it does.

- Your stored values are never overwritten. The package's values are computed from the enabled manifests each time.
- A change you make by hand to a key a package holds (the customize page, the keymap editor, a panel edit, or `k` in
  `/packages`) is recorded in `<data dir>/activation.json` as "kept" and wins over the package from then on. `k` again
  gives the key back to the package.
- What you keep is saved with the packages that own the look at that moment (`saved` in `activation.json`, one slot per
  owner set, up to 32), not in your `profile.json`. Switching the look to another package shows that package with its own
  kept choices, and switching back finds the first one as you left it; with no package owning the look you see your stored
  profile. `k` on a profile key keeps your stored value under this package. Your own keybindings stay in
  `keybindings.json`. An older `activation.json` (only `kept`) still works: those keys show your stored value.
  A config bundle carries the slots; a slot this machine already has stays its own.
- One package owns the look per scope (user or project). Enabling a second one that brings a look stops and lists what
  would change; run it again with `--switch` to move the look to it. In `/packages` turning it on switches at once, with no question: the notice says which package went off, and turning that one on again switches back. When both packages set `activate.tier` they are two whole setups, so the switch also turns the replaced one off, with its skills and tools; the question says so before you answer. The first package stays
  installed and enabled for its skills and commands; only its look modules and profile values step aside.
- `mendcode package capture <name>` saves your stored terminal profile as a user package whose activation sets those
  keys, and installs it: a look you can switch to later from `/packages`, like a profile. It copies only profile keys a
  package may set (launch settings, clipboard, notifications and similar stay yours and are named when you had changed
  them), no code, keybindings or settings. A name already installed needs `--replace`; when another package owns the
  look the new one stays installed but off, and turning it on in `/packages` switches to it. To move your whole setup to
  another machine use a configuration bundle ([config-bundle](config-bundle.md)).
- Independent keys from different packages merge. A key two packages both set is listed as a conflict, and the package
  that comes later in the layer order wins.
- Project-scope activation needs project trust; user scope does not.

A test in the repository pins this: snapshot profile and keybindings, enable a package, change one thing by hand,
disable, and the files equal the snapshot; enable it again and the change is back. Another switches the look A → B → A
with a change under each and checks each package comes back as it was left. The same suite installs `examples/packages/retro`
into a real daemon, compares frames of every surface before, during and after, edits the installed view to watch it hot
reload, disables it and checks that every frame is byte-equal to the first, then removes it.

### One precedence report

Skills, commands, agents, tools, hooks, MCP servers, themes, view slots, panel widgets, keybindings, workflows, recipes,
contracts, prompt files, extension pages and profile keys can each be provided by more than one layer. Layers, lowest first:
built in, user packages, your own folder, project packages, the project's `.mendcode`; for profile keys your stored
value, the package, an extension asked at run time, and a key you kept. The later one wins, except hooks (every layer's
run) and project code without trust (listed, never in force). `/packages` then `p` shows every name more than one layer
holds, which one is in force and which it overrides; `/doctor` ends with the same list. The daemon answers for what is read
from files (`system.query precedence`, local clients only) and the terminal adds what exists only there; both go through
one function (`resolvePrecedence`), so there is a single answer. The terminal loads extension modules in the same layer
order as the daemon (user packages, then your own folder, then the project's packages, then its own folder). Earlier
versions loaded your own folder first.

### Install, replace, disable and remove

- `compatibility.mendcode` (a version range) and `compatibility.api` are enforced when a package is installed and enabled:
  a package that rules out this MendCode is refused, and the message names the range and the running version.
- Installing over an installed package (`--replace`) stages, audits and swaps it atomically: if any step fails the old copy
  is put back and the folder is as it was.
- `mendcode package remove <name>` moves the package to the Trash (`<data dir>/.Trash`, or `<project>/.mendcode/.Trash`
  for project scope) for 30 days, the same place authoring uses. `mendcode package restore <name>` brings the newest copy
  back, off until you enable it. `--purge` deletes it for good.
- A broken package never stops MendCode from starting. A module that throws on load, an invalid manifest, a missing
  module or a view that throws or is too slow is reported in `/extensions` and `/doctor` and skipped, in the terminal and in
  the daemon; everything else loads. These cases are tested with the app harness and with a real daemon in a temporary folder.

## Catalogs, installs and trust (reference)

Balanced/full local previews show manifest `capabilities` and static observed hints: hooks, tools, commands, network, processes and filesystem. No code is imported or source text exposed. Scanning skips symlinks and is bounded to 64 source/JSON files, 32 KiB each, 512 KiB total and depth 8. Incomplete scans are labelled; absent hints never prove safety. Local previews are refused for remote/peer clients. Disable with `/tier package_capabilities off`. Remote catalogs remain uninspected rather than fetched for scanning.

Manifest `environment` lists up to 32 variable names. Preview reports declarations and literal `process.env` / `Bun.env` access names, never values; computed accesses remain unknown. Names and network hints grant no permission. With package capabilities off, fingerprint comparison and environment scanning do not run.

`/marketplace [source]` searches installed packages and explicitly enabled local sources. Enter previews the selected
package without installing or importing code; `i` opens the install confirmation, `y` confirms, `p` changes user/project
scope. `/` edits the search, `s` opens sources, `[]` scrolls details, and Escape closes the preview or page. Sources use
`a` to add an ID and folder, Enter to inspect its location, `e` to enable/disable, and `d` then `y` to remove. Hints live in the page header. Panels
fill the available grid; terminals below 70 columns use one column.

`/packages` manages installed overlays: Space/`e` toggles activation, `d` then `y` removes a package, `x` then `y`
deselects all packages, `m` opens the marketplace. Deselecting preserves files. `/mend-assets` counts files in enabled
package/user/project layers (skills, commands, agents, prompt templates/files, MCP files, tools, themes, extensions)
and shows the actual project prompt mode. Reports never include prompt bodies or import modules. Templates include
Markdown in `prompt/`, `prompts/` and `goals/`; counts describe files, not permission to execute an extension.

CLI aliases are `package`, `packages`, `marketplace`, `control-plane packages` and `control-plane marketplace`:

```sh
mendcode --dir /tmp/mend-data packages status
mendcode --dir /tmp/mend-data packages add-source team /tmp/team-catalog --enable
mendcode --dir /tmp/mend-data packages sources
mendcode --dir /tmp/mend-data packages search review team
mendcode --dir /tmp/mend-data packages show review-kit team --json
mendcode --dir /tmp/mend-data packages preview review-kit team --project
mendcode --dir /tmp/mend-data packages use review-kit team --project
mendcode --dir /tmp/mend-data packages install-source single-pack
mendcode --dir /tmp/mend-data packages deselect project:review-kit
mendcode --dir /tmp/mend-data packages deselect-all
mendcode --dir /tmp/mend-data packages remove-source team
```

`use` and named `install` install and activate. `use-source` aliases `install-source`; the source must contain exactly
one package, otherwise choose its name. Replacement needs `--replace`. Explicit folders (`./pack`, absolute paths)
and existing pinned Git package specs retain the audited direct installer. `disable-all` aliases `deselect-all`;
without scope it affects both user and current-project packages, `--project` affects just the project. `runtime registry`
(also under `control-plane`) supports `status`, `list`, `add <id> <folder>`, `remove <id>`, `search`, `show`,
`preview <source>` and `apply <source>`. `--type local --url <folder>` is accepted for source registration.

Sources persist in `<data dir>/package-sources.json`. New sources are off unless `--enable` is explicit. The built-in
`local` source reflects installed packages and cannot be removed. Registered sources are local folders (below) or
https catalogs (see Remote catalogs). A local folder is a v2
package itself, or a catalog with one of `.mendcode/marketplace/index.json[c]`, `.mendcode/registry-index.json[c]`,
`marketplace-index.json[c]`. Catalog shape:

```json
{
  "version": 0,
  "packs": [{
    "id": "review-kit", "version": "1.2.0", "title": "Review Kit",
    "description": "Review commands", "tags": ["review"], "source": { "url": "./review-kit" }
  }]
}
```

Each target stays inside the source folder and carries `mendcode-package.json`; catalog name/version must match.
Duplicate IDs and ambiguous cross-source names are rejected. Previews report audit problems; installs recheck staged
metadata and use the existing no-links/no-secrets, 2,000-file/20 MB installer. Indexes are limited to 1 MiB/200 packs,
registrations to 64 sources. JSONC supports comments and trailing commas. Package mutations reload daemon registrations
and notify terminals; project extension trust still applies.

Catalog commands never contact a service on their own; tests use local fakes. Registry selection defaults to local
opt-in catalogs. The protocol additions remain unavailable to remote read-only peers because local
metadata can include project paths.

## npm and pinned git installs

`packages install` also takes an npm spec. Packages are pinned: only an exact version is accepted, never a range or tag.

```sh
mendcode --dir /tmp/mend-data packages install npm:review-kit@1.2.0
mendcode --dir /tmp/mend-data packages install npm:@acme/review-kit@1.2.0#sha512-<base64> --project
mendcode --dir /tmp/mend-data packages install github:acme/review-kit#<40-hex commit>
```

The daemon runs `npm pack name@version --ignore-scripts` (argument array, tarball only: no `npm install`, no lifecycle
scripts, nothing from the package is executed), lists the archive with `tar` first and refuses links, absolute or `..`
entries and anything outside `package/`, then extracts it into the usual staging folder and applies the same audit
(manifest, no links/secrets, 2,000 files/20 MB; tarball at most 30 MB). The package must ship `mendcode-package.json`.
The install record keeps `npm:name@version`, the tarball `sha512-…` digest and `pinned: true`; `#sha512-…` in the spec
requires that digest. A full 40-hex commit after `#` fetches exactly that commit and verifies it; branch and tag refs
still work but are not marked pinned. Upgrades are explicit: install the new exact version with `--replace`. The installed digest/pin shows in the `/packages` detail.

## Remote catalogs (opt-in)

A catalog source may be an `https://` index URL (plain `http` only for a literal loopback address; no credentials or
fragment in the URL). Decision taken: it is registered off, enabling is explicit, and nothing is fetched by search,
preview or startup. Only `refresh` reaches the network, and only for an enabled remote source:

```sh
mendcode --dir /tmp/mend-data packages add-source hub https://hub.example/index.json --type remote --enable
mendcode --dir /tmp/mend-data packages refresh hub
mendcode --dir /tmp/mend-data packages search review hub
mendcode --dir /tmp/mend-data packages use review-kit hub --project
```

In the marketplace sources view, `u` refreshes the selected remote source. The validated index (same shape as the local
catalog, 1 MiB/200 packs, redirects refused) is cached in `<data dir>/package-cache/<id>.json`; search reads the cache.
Remote entries cannot name a folder: `source.url` must be `npm:name@x.y.z` (optional `source.integrity` sha512) or a git
spec with a full commit. Unpinned entries are listed with a problem and install refuses them. Previews do not touch the
network; the install downloads, verifies the digest/commit against the catalog, audits and installs. Local indexes may
use the same npm/git entries. Refresh and install are not read-only peer commands.

## Resource switches (`config`)

Besides turning a whole package on or off, single resources of an installed package can be switched off: skills,
commands, agents, themes, custom tools and extensions. Ids are `<kind>/<name>` (`skills/deploy`, `commands/review`,
`commands/team:ship`, `extensions/audit`). The `/packages` page opens them with `c` (space/`e`/Enter toggles, Esc goes back).

```sh
mendcode --dir /tmp/mend-data packages config
mendcode --dir /tmp/mend-data packages config review-kit --project
mendcode --dir /tmp/mend-data packages config review-kit disable skills/deploy
mendcode --dir /tmp/mend-data packages config project:review-kit enable commands/review
```

Switches live in `Settings.disabledPackageResources` (`user:pkg/skills/deploy`); a file left behind after a reinstall
keeps its switch. Every loader that reads the package layer skips switched-off resources and the daemon reloads at once.
Prompts, hooks, MCP files and recipes are not switchable per file; use the package switch for those.

## Local authoring (B75)

`packages create` and `packages update` snapshot shareable project files into `.mendcode/package-local/` with a native
`mendcode-package.json` and `runtime-pack.json`. Both create or replace the local snapshot; updates preserve unspecified
metadata, and replacements retain the previous package in `.mendcode/package-backups/`. They never install, activate,
import modules, grant project trust or contact a registry. The local marketplace shows the authored revision for preview
and explicit installation; replacing an installed copy still requires `--replace`.

```sh
mendcode --dir /tmp/mend-data control-plane packages create --id review-kit --title "Review Kit" --version 1.0.0 --include commands,skills
mendcode --dir /tmp/mend-data packages update --version 1.1.0
mendcode --dir /tmp/mend-data packages preview review-kit local
mendcode --dir /tmp/mend-data packages use review-kit local --project --replace
mendcode --dir /tmp/mend-data packages delete-local
```

Metadata flags: `--id`, `--title` (`--name` alias), `--description`, `--version`, `--kind`, `--channel`, `--source-type`,
`--source-url`, `--compat-mendcode`, `--compat-runtime-pack`. Source metadata never triggers a download.
Repeat `--include`/`--exclude` with comma-separated targets: commands, agents, modes, skills, plugins, tools, prompts,
MCP (`mcp`), context, pages, widgets, extensions, themes, models, focus, budget, memory, permissions, tuiProfile,
worktreePolicy, or `all`. Exclusions win. With no filters, current project assets are included; an explicit selection
persists the chosen files until another filter reselects them. Prompt files include `SYSTEM.md`, `APPEND_SYSTEM.md`,
`COMPACTION.md`, and `prompt/`, `prompts/`, `goals/`. Native modules remain in `extensions/`.

The settings snapshot records available model IDs/effort/variant, prompt choice, memory controls, default permission,
and TUI profile; it does not apply these settings when installed. Model parameters, provider credentials, trust grants,
databases, history and installed packages are excluded. Selected files pass the existing link/secret/file-size audit;
detected credential text and literal MCP env/header credentials are rejected before replacement. Use secret references.

`delete-local` moves only the generated package into `.mendcode/.Trash/`, resets its file selection and preserves metadata,
original artifacts, backups and installed copies. It is safe to repeat. Packages are unsigned by default;
`signatureRequired: false` records that local trust policy, rather than treating a checksum as an identity signature.
Publishing and cryptographic signer/trust policies remain off and need a separately chosen service/key (npm digests
and git commits pin content, they do not prove who published it).
## Small official kit and trust preview

The repository's `examples/official-packages` is an explicit local catalog, not an automatic startup source. Add that folder as a source and enable it to preview/install one unit: `mendcode-review` (balanced), `mendcode-autoresearch` (full, on demand), or `mendcode-web-routing` (balanced, on demand). These packages contain commands/skills only: no hooks, tools, SDKs, MCP servers or processes. No bulk installer or configuration of another harness is included.

Installed official resources follow their tier live: `official_packages` gates all three, while `autoresearch` and
`web_routing` also gate their respective package. A disabled tier removes their commands/skills from runtime discovery
and reports the package disabled without altering saved user preferences. With no tier, explicit installations retain
their existing behavior; nothing is installed or executed automatically. Other packages keep their own existing controls.

Preview displays the stable manifest `name` independently of its title and user/project scope. Titles can change without changing `scope:name` preferences. Replacement still requires explicit confirmation. Unsigned is explicit, and declared/static capabilities never grant permission. Bounded byte comparisons warn about duplicate resource content under another identity/scope; they do not disable it. Incomplete/remote scans remain unknown. Preview never imports package code or fetches a source.

Compatibility matrix: these three data packages target MendCode/runtime pack 1, native daemon commands/skills, at their listed tiers. External harness native/manual installation is not performed. Contract tests cover preview, stable identity, resource disabling, replacement and duplicates; no real external host is certified.

| Unit | Host / version | Tier | Invoked text bytes |
| --- | --- | --- | ---: |
| Focused review | MendCode / runtime pack 1 | balanced | 358 |
| Metric experiments | MendCode / runtime pack 1 | full | 1,042 |
| Explicit web routes | MendCode / runtime pack 1 | balanced | 702 |

These are measured UTF-8 file sizes, not model token counts or a bill estimate.

`/packages` estimates data-only command/skill packages with `ceil(chars / 4)`: **idle** is the package's skill index (zero when disabled or entirely explicit), and **on-demand** is the total trimmed resource text, including frontmatter, before invocation. The latter is a package-wide estimate, not a per-call bill; resource switches, overrides and truncation can reduce it. Code/config packages and incomplete, oversized or symlinked scans show `unknown`. Estimation runs only on an explicit local package listing; peer clients cannot request `packages.list`.

The official skills declare `on-demand: true` in frontmatter, omitting even names/descriptions from the automatic skill index while retaining `/skills` and explicit `skills.load`/`skill` selection. Ordinary skills keep their existing discovery behavior. Tiers remain `official_packages`/`web_routing` (balanced) and `autoresearch` (full).

Run `bun test packages/daemon/test/package-context.test.ts` for the W10 context budget. It measures the native engine's base context report (system text and tool schemas, empty history, no provider calls) before/after installing each official package and the whole kit in both scopes, across all three tiers and focus/full prompt modes. It prints estimated baseline/installed tokens and fails on any added tokens or changed sections. A positive control proves ordinary skill metadata increases the measured context. These are deterministic local estimates, not model-specific tokenizer or provider billing measurements.

Public `@mendcode/testkit.createPackageTestHost` supplies a virtual clock, explicit typed events and scripted model answers. Exhausting the answers fails instead of calling a provider. The kit has zero extensions, listeners and processes at startup; only the selected command/skill text is loaded when invoked. Runtime token/cost usage remains measured by the existing session/loop ledger, not estimated from package popularity.

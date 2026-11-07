Use a profile to change how MendCode looks and what it offers; removing it puts everything back. Follow the 10-minute guide to make your own, then check what profiles can change and how installs, catalogs and trust work.

## Manage profiles in chat

Read `mendcode docs profiles` and `mendcode docs extensions` for the short self-management reference cards embedded in the binary. The system prompt includes a one-line pointer to `mendcode docs`.

Discover `profiles` through `tool_search`. Its schema is deferred even when general tool discovery is off. The `profile_tools` feature belongs to balanced/full.

### Read or change profiles

| Action type | Actions |
| --- | --- |
| Read-only | `list`, `info`, `search`, `check` |
| Mutation | `install`, `enable`, `disable`, `switch-look`, `remove`, `new` |

`info` includes contents, capabilities and the existing precedence report, including command providers.

Every mutation requires the normal approval card, including full permission mode. The preview includes source, version, content fingerprint, overlay keys, keybindings, resource collisions and current look. A changed preview invalidates approval.

The fingerprint hashes every byte of every file. The preview's `tree` gives a bounded summary:

- File and byte totals.
- Files and bytes per top-level folder, twelve at most.
- The five largest files.
- Every file that can run or configure something, listed in full with the reason.

That last group includes an executable bit, a script or binary extension, `hooks.json`, `mcp.json`, `statusline.json`, and anything under `hooks/`, `bin/`, `scripts/`, `tools/` or `extensions/`.

The static capability scan reads only part of a large profile. In that case, the preview says `capabilityScan: partial`; the `runnable` list is the complete one.

| Tree limit | Maximum |
| --- | --- |
| Files | 2,000 files |
| Size | 20 MB |
| Folder depth | 12 folder levels |
| Runnable files | 150 runnable files, so approval can list them one by one |

The file and size limits are the installer's own limits. A tree over a hard limit is refused with the limit, measured value and shell command to run instead (`mendcode profile enable <name>`). Links stay refused.

Project mutations require trust. Remote/peer sessions cannot read or mutate profiles. Removal always uses Trash.

Chat installation requires an exact name and configured source ID with a complete local directory preview. Remote npm/git entries remain available for manual `/profiles` review, not chat installation.

This tool adds no source and performs no refresh/network. The tool and `/profiles` call the same daemon handlers.

Several skill profiles can coexist. `switch-look` uses the existing explicit switch rule; disabling the owner restores the previously enabled look.

`new` uses the same scaffold as `mendcode profile new`, in the project or `<dataDir>/package-drafts`. It does not enable it.

## Make your own MendCode in 10 minutes

Every command below takes `--dir /tmp/mend-data` to use a throwaway data folder while you try things.

1. Create a complete, commented profile that already loads:

   ```sh
   mendcode profile new mylook
   ```

   This writes `./mylook/`. `--dir PARENT` chooses its parent folder. An existing name is refused, and nothing is written outside the new folder.

2. Edit the colors in `themes/mylook.json`, keys in `keybindings.json` and values under `activate.tuiProfile`. These are the same keys and values `/customize` shows.
3. Check the folder without running any of it:

   ```sh
   mendcode profile check ./mylook
   ```

   The check reports errors and warnings described below; it exits 1 on any error.

4. Install a copy and turn it on:

   ```sh
   mendcode profile install ./mylook
   ```

   Open `/profiles` and press `o` to inspect its overrides. Extension and view code reloads while you edit the installed copy; the profile part applies at once.

5. Put the folder in a git repository. Anyone can install it with `mendcode profile install github:you/mylook`; pin a commit with `#<40-hex>`.

### What the scaffold contains

| Resource | Contents |
| --- | --- |
| Manifest | `mendcode-profile.json` with an `activate` section |
| Look | A theme and two view modules, `message.assistant` and `tool.card` |
| Resources | A slash command, a skill, a keybindings file and a workflow |
| Documentation | `docs/hooks.example.json` (an example, not loaded) and a README |

One surface's look is one small file in `extensions/`. A view is a pure synchronous function from data to styled rows; see [views](views.md).

| Example | Shows |
| --- | --- |
| `examples/profiles/retro/` | A full amber-phosphor reskin: theme, transcript rails, line-printer tool cards, a columns slash menu, a home screen, a panel card and a key |
| `examples/profiles/tool-renderers/` | A smaller tool-card example: shell commands and GitHub MCP calls drawn from their arguments with `renderTool` |

### Check errors and warnings

| Result | Causes |
| --- | --- |
| Error | Manifest does not match the schema; `compatibility` rules out this MendCode; forbidden `activate` key; missing view module; invalid JSON in a resource file; code uses an undeclared capability; profile exceeds 2,000 files or 20 MB |
| Warning | Declared capability never used by code; environment variable read by code; unknown top-level entry |

### Inspect overrides

The `o` list groups overrides under Look, Home, Prompt, Sidebar & commands, Keys and Views. Each row names the setting, key or view, its previous value, and the profile's value.

When nothing was set, previous values read `default`, `unbound` or `built-in`. The detail beside or below the list shows the selected override in full with its setting id.

| Key | Does |
| --- | --- |
| `k` | Keep your own value; the row says `yours` |
| `d` | Turn the profile off |
| `p` | Show the one precedence report |
| `?` on the list | Show every key |

### Start from project files instead

`mendcode profiles create` builds from a project's own `.mendcode/` folder instead of from scratch. It covers every surface a loader reads there:

- Skills, commands, agents, tools, hooks and MCP.
- Themes, recipes, workflows and contracts.
- Keybindings, prompt files, extensions and status line.
- A settings record it never applies.

It does not read your data directory. To move your own setup between machines, use a configuration bundle ([config-bundle](config-bundle.md)).

### What a profile can change

| Surface | How |
| --- | --- |
| Theme | `themes/<name>.json`, chosen with `activate.theme` |
| Tool card design | `tool-designs/<name>.json` (header, glyphs, diff, output, rule and colours as data; [format](customize.md#scrolling)), chosen with `activate.tuiProfile.toolDesign`. Data only; `profiles create` exports it with the themes |
| Footer pack | `footer-packs/<name>.json` (data, no code), chosen with `activate.tuiProfile.footerPack`; it never covers a footer the user made ([customize](customize.md#footer-packs)) |
| Bitmap pets | `pets/<id>/pet.json` plus its PNG/WebP atlas; `/pet` lists enabled local packages with `profile:<id>` references. Non-executable, no automatic generation or selection; `/pet export user:<uuid>` creates an atlas/manifest profile without its private reference PNG |
| Terminal settings | `activate.tuiProfile`: logo, tagline, home layout, prompt chrome and border, user lead, done symbol, density, slash menu layout and pins, panel cards (`sidebarWidgets`) and the rest of `/customize` |
| Tier look | `activate.tier`: the terminal side of a tier (presentation, density, whether the right panel hides). Features, prompt mode and process mode stay yours |
| Right panel | `activate.panelPreset` (`pulse`, `crew`, `ledger`, `focus`, `full`, `galaxy`) |
| Views | `activate.views` maps one of the 22 view slots to a module in `extensions/` (transcript messages, tool cards, the slash menu, headers, footers, welcome and so on) |
| Keybindings | `activate.keybindings`: a file in the format of `keybindings.json` |
| Prompt files | `SYSTEM.md`, `APPEND_SYSTEM.md`, `COMPACTION.md` in the profile; `activate.promptFiles` lists the ones it expects |
| Things it adds | skills, commands, agents, tools, hooks, MCP servers, themes, recipes, workflows, contracts, extensions, status line |

### What a profile cannot change

- The engine, model providers and the transport to them.
- Permission mode, approval rules, trust, provider credentials, budgets, features, experimental flags, `tools`, `hooks`,
  `mcp`, `sandbox`, `network`, models, safe mode, and which profiles are enabled: a manifest that tries any of these in
  `activate` fails the schema (`profile check` and the install both say so), and the same names are refused anywhere in
  the profile it ships. Customize keys that start things, spend calls, touch the clipboard or the network, or switch your own
  extensions off (`processMode`, `altScreen`, `copyOnSelect`, `turnNotify`, `fileOpener` and others) are refused too.
- The prompt editor, the dock and the live compaction panel: they are not view slots. A profile can only restyle them
  through the profile (prompt chrome, border, lead).
- Page bodies are typed data, not code: `/customize`, `/settings` and the other pages keep their own layout.
- A remote or peer client cannot enable, switch, install, remove or restore a profile. A profile that ships project code
  (tools, hooks, workflows, agents) does nothing in a project that is not trusted; its claims are listed as "needs project trust".

**Warning:** Extension and view code runs in the terminal process with your permissions. It can read your files and make network calls.

The view budget is 4 ms per call; three strikes turn the view off. This keeps a slow or throwing view from reaching a frame, but cannot interrupt a view that never returns inside the same process.

An infinite synchronous loop stops that terminal until it is closed. Start again with `--safe-mode`, which loads no extensions or profiles, and disable the profile.

Treat a profile like any program you install: read it, pin it and prefer small `capabilities`. Static analysis in `profile check` and the preview shows what code appears to use, never a guarantee it does nothing else.

### How activation works: an overlay, never an edit

A customize key uses the first available value in this order:

1. Your explicit choice made after the profile was enabled.
2. The profile's value.
3. Your stored value.

Nothing is written to your `profile.json`, `keybindings.json` or settings. Disabling or removing the profile removes the overlay and leaves your stored files as they were.

Keys changed by hand while the profile was on wait with that profile, as described below, and come back when it does.

- Your stored values are never overwritten. The profile's values are computed from the enabled manifests each time.
- A change you make by hand to a key a profile holds (the customize page, the keymap editor, a panel edit, or `k` in
  `/profiles`) is recorded in `<data dir>/activation.json` as "kept" and wins over the profile from then on. `k` again
  gives the key back to the profile.
- What you keep is saved with the profiles that own the look at that moment (`saved` in `activation.json`, one slot per
  owner set, up to 32), not in your `profile.json`. Switching the look to another profile shows that profile with its own
  kept choices, and switching back finds the first one as you left it; with no profile owning the look you see your stored
  profile. `k` on a customize key keeps your stored value under this profile. Your own keybindings stay in
  `keybindings.json`. An older `activation.json` (only `kept`) still works: those keys show your stored value.
  A config bundle carries the slots; a slot this machine already has stays its own.
- One profile owns the look per scope (user or project). Enabling a second one that brings a look stops and lists what
  would change; run it again with `--switch` to move the look to it. In `/profiles` turning it on switches at once, with no question: the notice says which profile went off, and turning that one on again switches back. When both profiles set `activate.tier` they are two whole setups, so the switch also turns the replaced one off, with its skills and tools; the question says so before you answer. The first profile stays
  installed and enabled for its skills and commands; only its look modules and profile values step aside.
- `mendcode profile capture <name>` saves your stored terminal settings as a user profile whose activation sets those
  keys, and installs it: a look you can switch to later from `/profiles`, like a profile. It copies only customize keys a
  profile may set (launch settings, clipboard, notifications and similar stay yours and are named when you had changed
  them), no code, keybindings or settings. A name already installed needs `--replace`; when another profile owns the
  look the new one stays installed but off, and turning it on in `/profiles` switches to it. To move your whole setup to
  another machine use a configuration bundle ([config-bundle](config-bundle.md)).
- Independent keys from different profiles merge. A key two profiles both set is listed as a conflict, and the profile
  that comes later in the layer order wins.
- Project-scope activation needs project trust; user scope does not.

A test in the repository pins this: snapshot profile and keybindings, enable a profile, change one thing by hand,
disable, and the files equal the snapshot; enable it again and the change is back. Another switches the look A → B → A
with a change under each and checks each profile comes back as it was left. The same suite installs `examples/profiles/retro`
into a real daemon, compares frames of every surface before, during and after, edits the installed view to watch it hot
reload, disables it and checks that every frame is byte-equal to the first, then removes it.

### One precedence report

Open `/profiles` and press `p` to see every name held by more than one layer, which provider is in force and which it overrides. `/doctor` ends with the same list.

This covers skills, commands, agents, tools, hooks, MCP servers, themes, view slots, panel widgets, keybindings, workflows, recipes, contracts, prompt files, extension pages and customize keys.

| Resource | Layers, lowest first |
| --- | --- |
| Files and resources | Built in, user profiles, your own folder, project profiles, the project's `.mendcode` |
| Customize keys | Your stored value, the profile, an extension asked at run time, a key you kept |

The later layer wins, with two exceptions:

- Every layer's hooks run.
- Project code without trust is listed but never in force.

The daemon answers for files through `system.query precedence` (local clients only); the terminal adds what exists only there. Both use `resolvePrecedence`, so there is a single answer.

The terminal loads extension modules in the daemon's layer order: user profiles, your own folder, the project's packages, then its own folder. Earlier versions loaded your own folder first.

### Install, replace, disable and remove

- `compatibility.mendcode` (a version range) and `compatibility.api` are enforced when a profile is installed and enabled:
  a profile that rules out this MendCode is refused, and the message names the range and the running version.
- Installing over an installed profile (`--replace`) stages, audits and swaps it atomically: if any step fails the old copy
  is put back and the folder is as it was.
- `mendcode profile remove <name>` moves the profile to the Trash (`<data dir>/.Trash`, or `<project>/.mendcode/.Trash`
  for project scope) for 30 days, the same place authoring uses. `mendcode profile restore <name>` brings the newest copy
  back, off until you enable it. `--purge` deletes it for good.
- A broken profile never stops MendCode from starting. A module that throws on load, an invalid manifest, a missing
  module or a view that throws or is too slow is reported in `/extensions` and `/doctor` and skipped, in the terminal and in
  the daemon; everything else loads. These cases are tested with the app harness and with a real daemon in a temporary folder.

## Catalogs, installs and trust (reference)

### Read a capability preview

Balanced/full local previews show manifest `capabilities` and static observed hints: hooks, tools, commands, network, processes and filesystem. No code is imported or source text exposed.

| Scan limit | Bound |
| --- | --- |
| Source/JSON files | 64 |
| Each file | 32 KiB |
| Total | 512 KiB |
| Depth | 8 |

Scanning skips symlinks. Incomplete scans are labelled; absent hints never prove safety. Local previews are refused for remote/peer clients. Remote catalogs remain uninspected rather than fetched for scanning.

Disable with `/tier profile_capabilities off`. With profile capabilities off, fingerprint comparison and environment scanning do not run.

Manifest `environment` lists up to 32 variable names. Preview reports declarations and literal `process.env` / `Bun.env` access names, never values; computed accesses remain unknown. Names and network hints grant no permission.

### Browse the marketplace

`/marketplace [source]` lists the catalog: the built-in `local` source (your installed profiles, and this project's
authored one) and the sources you added and turned on. Nothing else is listed and nothing is fetched to fill it.

`/profiles` and `/marketplace` share three tabs, in this order: **1 What it takes over** (the overrides of a profile that is
on), **2 Installed** (the `/profiles` list) and **3 Marketplace**. Press `1`, `2` or `3` on either page.

The page has:

- A search row at the top, always shown. `/` puts the cursor in it; every word must match the name, title, description,
  tags, source or author.
- Kind filters under it, for the kinds the catalog has: themes, extensions, tools, skills, commands, agents, MCP, and
  remote (an entry whose contents are known only after install). `Tab` and `Shift+Tab` step through them.
- One row per profile: its name, kind, author (or source), a short description and a badge. `on` and `off` mark an
  installed copy, `update` means the catalog has a newer version than the installed one, and `problem` means it cannot install.
- The detail of the selected profile: where it stands, what it adds, **what it takes over** and its source and trust.
  For a profile that is on, the takeover lists the same before → after rows as `/profiles`. Before an install, Enter
  reads them from the profile's manifest without installing anything or running its code. A remote entry says it is
  known after install, since it is fetched only then.

| Key | Does |
| --- | --- |
| Enter | Preview (audit, capabilities, trust, takeover), then ask: Enter or `y` installs, updates or installs again; any other key says no |
| `d`, then `d` or `y` | Remove the installed copy (it goes to the Trash for 30 days) |
| `/` | Search |
| `Tab`, `Shift+Tab` | Next or previous kind |
| `p` | Install for you (user) or in this project |
| `s` | Open sources |
| `↑↓`, PgUp/PgDn, Home/End | Select |
| `[]` | Scroll the detail |
| `r` | Read the catalog again |
| `1` `2` `3` | What it takes over, Installed, Marketplace |
| `?` | Show every key |
| Escape | Close the preview, clear the search, then leave |

Every install, update, remove and source change ends with one short notice. A refused install keeps the preview open,
and the notice gives the daemon's reason (for example another profile owns the look). If the catalog cannot be read,
the page says why and `r` tries again. If the daemon is offline, the page says so and fills in once the terminal reconnects.

In Sources:

| Key | Does |
| --- | --- |
| `a` | Add an ID, then a folder or https catalog (added off) |
| Enter | Show its location and state |
| `e` | Turn on or off |
| `u` | Fetch a remote catalog's index (the only key that reaches the network) |
| `d`, then `d` or `y` | Remove |
| Escape | Back to the catalog |

The built-in `local` source is always on and cannot be removed. Hints live in the page header. Wide terminals show the
detail beside the list, narrower ones under it, and below 70 columns one panel at a time.

### Manage installed overlays

| Key in `/profiles` | Does |
| --- | --- |
| Space/`e` | Toggle activation |
| `d`, then `y` | Remove a profile |
| `x`, then `y` | Deselect all profiles; files are preserved |
| `1` or `o` | What the selected profile takes over |
| `2` | Back to the list |
| `3` or `m` | Open the marketplace |

`/mend-assets` counts files in enabled package/user/project layers and shows the actual project prompt mode.

Counts cover skills, commands, agents, prompt templates/files, MCP files, tools, themes and extensions. Templates include Markdown in `prompt/`, `prompts/` and `goals/`.

Reports never include prompt bodies or import modules. Counts describe files, not permission to execute an extension.

### CLI and sources

CLI aliases are `profile`, `profiles`, `marketplace`, `control-plane profiles` and `control-plane marketplace`:

```sh
mendcode --dir /tmp/mend-data profiles status
mendcode --dir /tmp/mend-data profiles add-source team /tmp/team-catalog --enable
mendcode --dir /tmp/mend-data profiles sources
mendcode --dir /tmp/mend-data profiles search review team
mendcode --dir /tmp/mend-data profiles show review-kit team --json
mendcode --dir /tmp/mend-data profiles preview review-kit team --project
mendcode --dir /tmp/mend-data profiles use review-kit team --project
mendcode --dir /tmp/mend-data profiles install-source single-pack
mendcode --dir /tmp/mend-data profiles deselect project:review-kit
mendcode --dir /tmp/mend-data profiles deselect-all
mendcode --dir /tmp/mend-data profiles remove-source team
```

`use` and named `install` install and activate. `use-source` aliases `install-source`; the source must contain exactly
one profile, otherwise choose its name. Replacement needs `--replace`. Explicit folders (`./pack`, absolute paths)
and existing pinned Git package specs retain the audited direct installer. `disable-all` aliases `deselect-all`;
without scope it affects both user and current-project profiles, `--project` affects just the project. `runtime registry`
(also under `control-plane`) supports `status`, `list`, `add <id> <folder>`, `remove <id>`, `search`, `show`,
`preview <source>` and `apply <source>`. `--type local --url <folder>` is accepted for source registration.

Sources persist in `<data dir>/package-sources.json`. New sources are off unless `--enable` is explicit. The built-in
`local` source reflects installed profiles and cannot be removed. Registered sources are local folders (below) or
https catalogs (see Remote catalogs). A local folder is a v2
profile itself, or a catalog with one of `.mendcode/marketplace/index.json[c]`, `.mendcode/registry-index.json[c]`,
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

Each target stays inside the source folder and carries `mendcode-profile.json`; catalog name/version must match. Duplicate IDs and ambiguous cross-source names are rejected.

Previews report audit problems. Installs recheck staged metadata and use the existing no-links/no-secrets, 2,000-file/20 MB installer.

| Catalog limit | Bound |
| --- | --- |
| Index | 1 MiB/200 packs |
| Registrations | 64 sources |

JSONC supports comments and trailing commas. Profile mutations reload daemon registrations and notify terminals; project extension trust still applies.

Catalog commands never contact a service on their own; tests use local fakes. Registry selection defaults to local
opt-in catalogs. The protocol additions remain unavailable to remote read-only peers because local
metadata can include project paths.

## npm and pinned git installs

`profiles install` also takes an npm spec. Profiles are pinned: only an exact version is accepted, never a range or tag.

```sh
mendcode --dir /tmp/mend-data profiles install npm:review-kit@1.2.0
mendcode --dir /tmp/mend-data profiles install npm:@acme/review-kit@1.2.0#sha512-<base64> --project
mendcode --dir /tmp/mend-data profiles install github:acme/review-kit#<40-hex commit>
```

### What the installer checks

1. The daemon runs `npm pack name@version --ignore-scripts` as an argument array, for the tarball only. There is no `npm install`, no lifecycle script and no execution of profile code.
2. It lists the archive with `tar` first, refusing links, absolute or `..` entries and anything outside `package/`.
3. It extracts into the usual staging folder and applies the same audit: manifest, no links/secrets, 2,000 files/20 MB, and a tarball at most 30 MB.

The profile must ship `mendcode-profile.json`.

### Pins and upgrades

The install record keeps `npm:name@version`, the tarball `sha512-…` digest and `pinned: true`. `#sha512-…` in the spec requires that digest.

A full 40-hex commit after `#` fetches exactly that commit and verifies it. Branch and tag refs still work but are not marked pinned.

To upgrade, explicitly install the new exact version with `--replace`. The installed digest/pin shows in the `/profiles` detail.

## Remote catalogs (opt-in)

A catalog source may be an `https://` index URL (plain `http` only for a literal loopback address; no credentials or
fragment in the URL). Decision taken: it is registered off, enabling is explicit, and nothing is fetched by search,
preview or startup. Only `refresh` reaches the network, and only for an enabled remote source:

```sh
mendcode --dir /tmp/mend-data profiles add-source hub https://hub.example/index.json --type remote --enable
mendcode --dir /tmp/mend-data profiles refresh hub
mendcode --dir /tmp/mend-data profiles search review hub
mendcode --dir /tmp/mend-data profiles use review-kit hub --project
```

In the marketplace sources view, press `u` to refresh the selected remote source. Search reads the validated index cached in `<data dir>/package-cache/<id>.json`.

The index has the local catalog's shape and 1 MiB/200 packs limit. Redirects are refused.

| Remote entry | Allowed source |
| --- | --- |
| npm | `source.url` is `npm:name@x.y.z`, with optional `source.integrity` sha512 |
| Git | A git spec with a full commit |
| Folder | Not allowed |

Unpinned entries are listed with a problem and refused at install. Previews do not touch the network; installation downloads, verifies the digest/commit against the catalog, audits and installs.

Local indexes may use the same npm/git entries. Refresh and install are not read-only peer commands.

## Resource switches (`config`)

Switch off individual skills, commands, agents, themes, custom tools or extensions without turning off the whole installed profile.

1. Open `/profiles` and press `c` to open resources.
2. Toggle a resource with space/`e`/Enter.
3. Press Esc to go back.

Ids use `<kind>/<name>`, such as `skills/deploy`, `commands/review`, `commands/team:ship` and `extensions/audit`.

```sh
mendcode --dir /tmp/mend-data profiles config
mendcode --dir /tmp/mend-data profiles config review-kit --project
mendcode --dir /tmp/mend-data profiles config review-kit disable skills/deploy
mendcode --dir /tmp/mend-data profiles config project:review-kit enable commands/review
```

Switches live in `Settings.disabledProfileResources` (`user:pkg/skills/deploy`); a file left behind after a reinstall
keeps its switch. Every loader that reads the profile layer skips switched-off resources and the daemon reloads at once.
Prompts, hooks, MCP files and recipes are not switchable per file; use the profile switch for those.

## Local authoring (B75)

`profiles create` and `profiles update` snapshot shareable project files into `.mendcode/package-local/` with a native
`mendcode-profile.json` and `runtime-pack.json`. Both create or replace the local snapshot; updates preserve unspecified
metadata, and replacements retain the previous profile in `.mendcode/package-backups/`. They never install, activate,
import modules, grant project trust or contact a registry. The local marketplace shows the authored revision for preview
and explicit installation; replacing an installed copy still requires `--replace`.

```sh
mendcode --dir /tmp/mend-data control-plane profiles create --id review-kit --title "Review Kit" --version 1.0.0 --include commands,skills
mendcode --dir /tmp/mend-data profiles update --version 1.1.0
mendcode --dir /tmp/mend-data profiles preview review-kit local
mendcode --dir /tmp/mend-data profiles use review-kit local --project --replace
mendcode --dir /tmp/mend-data profiles delete-local
```

### Choose metadata and files

| Metadata flag | Purpose |
| --- | --- |
| `--id` | Id |
| `--title` (`--name` alias) | Title |
| `--description` | Description |
| `--version` | Version |
| `--kind` | Kind |
| `--channel` | Channel |
| `--source-type`, `--source-url` | Source metadata; never triggers a download |
| `--compat-mendcode`, `--compat-runtime-pack` | Compatibility |

Repeat `--include`/`--exclude` with comma-separated targets:

- commands, agents, modes, skills, plugins, tools, prompts.
- MCP (`mcp`), context, pages, widgets, extensions, themes.
- models, focus, budget, memory, permissions, tuiProfile, worktreePolicy.
- `all`.

Exclusions win. With no filters, current project assets are included. An explicit selection persists the chosen files until another filter reselects them.

Prompt files include `SYSTEM.md`, `APPEND_SYSTEM.md`, `COMPACTION.md`, and `prompt/`, `prompts/`, `goals/`. Native modules remain in `extensions/`.

### Snapshot safety

The settings snapshot records available model IDs/effort/variant, prompt choice, memory controls, default permission and terminal settings. It does not apply these settings when installed.

Model parameters, provider credentials, trust grants, databases, history and installed profiles are excluded.

Selected files pass the existing link/secret/file-size audit. Detected credential text and literal MCP env/header credentials are rejected before replacement. Use secret references.

### Delete a local snapshot

`delete-local` moves only the generated profile into `.mendcode/.Trash/` and resets its file selection. It preserves metadata, original artifacts, backups and installed copies. It is safe to repeat.

### Signatures and publishing

Profiles are unsigned by default. `signatureRequired: false` records that local trust policy, rather than treating a checksum as an identity signature.

Publishing and cryptographic signer/trust policies remain off and need a separately chosen service/key. npm digests and git commits pin content; they do not prove who published it.

## Small official kit and trust preview

Add the repository's `examples/official-profiles` folder as a source and enable it to preview/install a unit. This is an explicit local catalog, not an automatic startup source.

| Profile | Tier |
| --- | --- |
| `mendcode-review` | balanced |
| `mendcode-autoresearch` | full, on demand |
| `mendcode-web-routing` | balanced, on demand |

These profiles contain commands/skills only: no hooks, tools, SDKs, MCP servers or processes. No bulk installer or configuration of another harness is included.

### Tier and preview behavior

Installed official resources follow their tier live: `official_profiles` gates all three, while `autoresearch` and
`web_routing` also gate their respective profile. A disabled tier removes their commands/skills from runtime discovery
and reports the profile disabled without altering saved user preferences. With no tier, explicit installations retain
their existing behavior; nothing is installed or executed automatically. Other profiles keep their own existing controls.

Preview displays the stable manifest `name` independently of title and user/project scope. Titles can change without changing `scope:name` preferences. Replacement still requires explicit confirmation.

Unsigned is explicit; declared/static capabilities never grant permission. Bounded byte comparisons warn about duplicate resource content under another identity/scope without disabling it.

Incomplete/remote scans remain unknown. Preview never imports profile code or fetches a source.

### Compatibility and context cost

Compatibility matrix: these three data profiles target MendCode/runtime pack 1, native daemon commands/skills, at their listed tiers. External harness native/manual installation is not performed. Contract tests cover preview, stable identity, resource disabling, replacement and duplicates; no real external host is certified.

| Unit | Host / version | Tier | Invoked text bytes |
| --- | --- | --- | ---: |
| Focused review | MendCode / runtime pack 1 | balanced | 358 |
| Metric experiments | MendCode / runtime pack 1 | full | 1,042 |
| Explicit web routes | MendCode / runtime pack 1 | balanced | 702 |

These are measured UTF-8 file sizes, not model token counts or a bill estimate.

`/profiles` estimates data-only command/skill profiles with `ceil(chars / 4)`:

| Estimate | Measures |
| --- | --- |
| **idle** | Profile's skill index; zero when disabled or entirely explicit |
| **on-demand** | Total trimmed resource text, including frontmatter, before invocation |

On-demand is a package-wide estimate, not a per-call bill. Resource switches, overrides and truncation can reduce it.

Code/config profiles and incomplete, oversized or symlinked scans show `unknown`. Estimation runs only on an explicit local package listing; peer clients cannot request `profiles.list`.

The official skills declare `on-demand: true` in frontmatter, omitting even names/descriptions from the automatic skill index while retaining `/skills` and explicit `skills.load`/`skill` selection. Ordinary skills keep their existing discovery behavior. Tiers remain `official_profiles`/`web_routing` (balanced) and `autoresearch` (full).

### Implementation and verification

The self-management cards are generated from `packages/daemon/cards/*.md` and repository docs with `bun scripts/self-knowledge.ts`; add `--check` to verify only.

Run `bun test packages/daemon/test/package-context.test.ts` for the W10 context budget. It measures the native engine's base context report: system text and tool schemas, empty history, no provider calls.

The test compares before/after installing each official profile and the whole kit in both scopes, across all three tiers and focus/full prompt modes.

It prints estimated baseline/installed tokens and fails on added tokens or changed sections. A positive control proves ordinary skill metadata increases measured context. These are deterministic local estimates, not model-specific tokenizer or provider billing measurements.

Public `@mendcode/testkit.createPackageTestHost` supplies a virtual clock, explicit typed events and scripted model answers. Exhausting answers fails instead of calling a provider.

The kit has zero extensions, listeners and processes at startup; only the selected command/skill text loads when invoked. Runtime token/cost usage remains measured by the existing session/loop ledger, not estimated from profile popularity.

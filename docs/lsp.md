# Language servers

Use language servers to navigate code and get diagnostics in your chat's tool results. Configure your project's servers in `.mendcode/lsp.json`; results stay in the transcript and `/history`, where `ctrl+o` expands tool output.

## Navigate code

The daemon registers `lsp` alongside `diagnostics`. No separate LSP page or slash command is needed.

| Operation | Purpose |
|---|---|
| `goToDefinition` | Go to a definition. |
| `findReferences` | Find references, including declarations. |
| `hover` | Read hover information. |
| `documentSymbol` | Read document symbols. |
| `workspaceSymbol` | Search connected servers in the current project; keep the first ten relevant symbols per server, as v1 does. |
| `goToImplementation` | Go to an implementation. |
| `prepareCallHierarchy` | Prepare a call hierarchy. |
| `incomingCalls`, `outgoingCalls` | Prepare the first hierarchy item on the same server, then find calls. |

| Argument | Meaning |
|---|---|
| `operation` | The operation to request. |
| `filePath` | The file to synchronize before the request. |
| `line`, `character` | Editor position, 1-based. Returned LSP ranges are 0-based UTF-16. |
| `query` | Optional workspace-symbol query. |

Locations, location links, nested document symbols, Markdown hover and opaque call-hierarchy data are preserved.

Requests time out after 4 seconds. Tool cancellation sends `$/cancelRequest`.

## Configuration

Edit `.mendcode/lsp.json` to configure the project:

| Value or override | Effect |
|---|---|
| `false` or `{ "disabled": true }` | Disable all servers. |
| `true` | Enable defaults. |
| Server overrides | Retain builtin extensions/root markers. |
| `gopls`/`pyright` | Accepted aliases for v2's `go`/`python` ids. |
| Custom servers | Require command and extensions. |

```json
{
  "disableDownload": true,
  "servers": {
    "python": {
      "env": { "VIRTUAL_ENV": "/project/.venv" },
      "initialization": { "python": { "analysis": { "typeCheckingMode": "strict" } } }
    },
    "typescript": { "bootstrap": true },
    "rust": { "disabled": true },
    "custom": {
      "command": ["local-server", "--stdio"],
      "extensions": [".custom"],
      "rootMarkers": ["project.json"],
      "disableDownload": true
    }
  }
}
```

`env` is scoped to the child process. `initialization` goes to `initialize.initializationOptions`, dotted `workspace/configuration` requests and `workspace/didChangeConfiguration`.

| Language | Project discovery |
|---|---|
| TypeScript | Project `typescript/lib/tsserver.js`. |
| Python | `VIRTUAL_ENV`, `.venv` and `venv`, unless initialization overrides the result. |
| Go | Prefers a `go.work` workspace. |
| Rust | Selects the enclosing Cargo workspace. |

Restart the daemon after changing configuration: it is loaded lazily once per project.

## Offline bootstrap

Resolution checks these locations in order:

1. PATH.
2. Project `node_modules/.bin`.
3. `<data dir>/lsp/bin`.
4. `<data dir>/lsp/node_modules/.bin`.
5. Per-server caches.

| Missing server | Offline provisioning |
|---|---|
| TypeScript/Pyright | pnpm 11+ in `<data dir>/lsp/<id>`, strictly offline, scripts disabled and minimum release age 1440 minutes. |
| Go | Local toolchain/module cache with `GOPROXY=off`, `GOSUMDB=off` and `GOTOOLCHAIN=local`. |

Simultaneous bootstrap calls share one installer per server. Installers have a 15-second limit; tool cancellation kills the process group.

### Retry a failed provisioning

A failed provisioning is remembered per server and project root for 10 minutes, with its reason:

- `pnpm is not on PATH`
- `pnpm 11 or newer is required`
- `pnpm add --offline … exited with code 1`
- `go install gopls from the local module cache …`

Until then, `lsp` and `diagnostics` answer at once with the same message and run no installer. For example:

``typescript-language-server is not installed (not found on PATH); offline provisioning failed (pnpm add --offline typescript-language-server typescript exited with code 1), next attempt in 10 min; run `mendcode lsp install typescript` to get diagnostics for .ts files``

A server MendCode does not install says `install it` instead.

Every call still checks PATH, project `node_modules/.bin` and data-dir caches. A server installed in the meantime is used by the next call without waiting for the interval.

Cancelled provisioning is not remembered. The memory lives in the daemon process: restarting the daemon is the explicit retry; the tools have no restart action.

### Control provisioning

| Setting | Effect |
|---|---|
| `bootstrap: false` | Skip the data-dir cache and provisioning. |
| `disableDownload` | Prevent provisioning; supported per server and globally. |
| `MENDCODE_DISABLE_LSP_DOWNLOAD=1` | Also set the global downloads-disabled default. |

Missing binaries produce an explicit unavailable result, including a downloads-disabled reason when applicable.

### Install a server on request

No network download runs automatically. Run `mendcode lsp install typescript|python|go` to download one into the same cache the lookups read: `<data dir>/lsp/<id>`, or `<data dir>/lsp/bin` for gopls.

| Installer | Behavior |
|---|---|
| pnpm 11+ | Without `--offline`, still with `--ignore-scripts` and no release younger than a day. |
| Go | `go install gopls@latest` through your Go proxy with the local toolchain. |

Installation takes up to 3 minutes. The daemon runs it only for a local client. A server already found on PATH, in the project or in the cache is reported and left alone.

v1 downloaded these on first use; MendCode asks you to run it once. Rust matches v1's installed `rust-analyzer` requirement.

Local fake-server tests establish the protocol/tool/offline-bootstrap path, not compatibility with every real language server.

## Web and scripting presets (B11)

| Preset | Installed command | Files |
| --- | --- | --- |
| `deno` | `deno lsp` | TS/TSX, JS/JSX, MJS |
| `vue` | `vue-language-server --stdio` | Vue |
| `eslint` | `vscode-eslint-language-server --stdio` | TS/JS families, Vue |
| `oxlint` | `oxlint --lsp`, then `oxc_language_server` | TS/JS families, Vue, Astro, Svelte |
| `biome` | `biome lsp-proxy --stdio` | TS/JS families, JSON/JSONC, Vue/Astro/Svelte, CSS, GraphQL/GQL, HTML |
| `svelte` | `svelteserver --stdio` | Svelte |
| `astro` | `astro-ls --stdio` | Astro |
| `yaml-ls` | `yaml-language-server --stdio` | YAML/YML |
| `lua-ls` | `lua-language-server` | Lua |
| `bash` | `bash-language-server start` | SH/BASH/ZSH/KSH |

These presets use installed executables only, with `disableDownload: true` by default. No B11 installer or network download is implemented.

Override commands, extensions, env and initialization in `.mendcode/lsp.json`. Missing executables and required project dependencies are reported, not silently installed. Real-server validation requires separately installed binaries.

### Project roots and dependencies

| Preset | Root routing |
|---|---|
| Deno | Requires the nearest `deno.json`/`deno.jsonc`; TypeScript is excluded beneath either marker. |
| Vue/ESLint/Svelte/Astro/YAML | Nearest package lock: `package-lock.json`, `bun.lockb`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`. |
| Oxlint | Also recognizes `.oxlintrc.json` and `package.json`. |
| Biome | Also recognizes `biome.json`/`biome.jsonc`. |
| Lua | Recognizes `.luarc.json`/`.luarc.jsonc`, `.luacheckrc`, `.stylua.toml`/`stylua.toml`, `selene.toml`/`selene.yml`. |
| Bash | Uses the requested project directory. |

`rootRequired` and `rootExcludes` may override those routing gates.

Biome and Oxlint prefer the nearest project `node_modules/.bin`, then ancestors up to the project directory, before PATH.

Oxlint uses `--lsp` only after a bounded, cancellable `--help` probe advertises it. Otherwise, the standalone OXC server is tried.

Astro requires project TypeScript and sends `typescript.tsdk`; ESLint requires the project `eslint` dependency. Explicit custom commands bypass these builtin dependency checks.

Every matching, available server participates in semantic requests and diagnostics. Linters complement the language server rather than being hidden behind it.

Diagnostics retain available results and name unavailable servers. Clean partial results do not claim that every server passed.

Existing `lsp.query`, `client.lsp`, `lsp`/`diagnostics` tools and chat/history surfaces carry the results without new protocol commands or pages.

## Other language presets (B12)

| Preset | Installed command |
| --- | --- |
| `ruby-lsp` | `rubocop --lsp` |
| `ty` | `ty server` |
| `elixir-ls` | `elixir-ls` |
| `zls` | `zls` |
| `csharp`, `razor` | `roslyn-language-server --stdio --autoLoadProjects` |
| `fsharp` | `fsautocomplete` |
| `sourcekit-lsp` | `sourcekit-lsp`, then Xcode's `xcrun --find sourcekit-lsp` |
| `clangd` | `clangd --background-index --clang-tidy` |
| `jdtls` | `jdtls` or Java with an installed JDTLS distribution |
| `kotlin-ls` | `kotlin-lsp --stdio`, then `kotlin-lsp.sh` / `kotlin-lsp.cmd` |
| `php intelephense` | `intelephense --stdio` |
| `prisma` | `prisma language-server` |
| `dart` | `dart language-server --lsp` |
| `ocaml-lsp` | `ocamllsp` |
| `terraform` | `terraform-ls serve` |
| `texlab` | `texlab` |
| `dockerfile` | `docker-langserver --stdio` |
| `gleam` | `gleam lsp` |
| `clojure-lsp` | `clojure-lsp listen` |
| `nixd` | `nixd` |
| `tinymist` | `tinymist` |
| `haskell-language-server` | `haskell-language-server-wrapper --lsp` |
| `julials` | `julia --startup-file=no --history-file=no -e 'using LanguageServer; runserver()'` |

All B12 presets use installed executables with downloads disabled.

| Preset | Behavior or requirement |
|---|---|
| Ty | Opt-in: set `MENDCODE_EXPERIMENTAL_LSP_TY=1` or `servers.ty.disabled: false`. Discovers the same virtualenvs as Python, including the `ty` executable, and sends `pythonPath`. |
| Intelephense | Disables telemetry. |
| Terraform | Enables required-field prefilling and validation on save. |
| Julia | Requires the installed `LanguageServer` package. |

### Root detection

Root detection uses v1 markers, including wildcard project names: `*.slnx`, `*.sln`, `*.csproj`, `*.fsproj`, `*.xcodeproj`, `*.xcworkspace`, `*.tf`, `*.cabal`, `*.jl`.

| Preset | Root rules |
|---|---|
| Java/Kotlin | Prefer Gradle settings, then wrapper, then module/Maven markers. An explicit `rootMarkers` override replaces this priority. |
| Nix | Prefer a flake, then the enclosing Git root, then the project directory. |
| Prisma | Preserve v1's `package.json` exclusion. |
| Dockerfile | Match `.dockerfile` and the exact `Dockerfile` basename; `filenames` may override basename matching in server configuration. |

Document language ids preserve language aliases such as Ruby, F#, C++, Kotlin, LaTeX and Terraform variables.

### Installed toolchains and caches

Roslyn/F# also discover existing `.dotnet/tools` under `DOTNET_CLI_HOME` or the home directory.

Razor requires all three assets in an installed VS Code C# `.razorExtension`. `VSCODE_EXTENSIONS` selects an explicit extensions directory; otherwise standard VS Code locations are searched.

The newest complete extension supplies source-generator, design-time targets and extension arguments. Custom commands bypass these builtin launch checks.

Existing data-dir caches may contain:

- `<id>/bin/<command>`
- `elixir-ls-master/release/language_server.sh`
- `kotlin-ls/kotlin-lsp.sh`
- `clangd_*/bin/clangd`
- `jdtls/plugins/org.eclipse.equinox.launcher_*.jar` with `config_mac`, `config_linux` or `config_win`

`bootstrap: false` skips those caches. JDTLS requires Java 21+ on PATH or via `JAVA_HOME` and keeps workspace data in `<data dir>/lsp/jdtls/workspaces/<root hash>`.

Toolchain probes are bounded to two seconds and cancellable.

### Limits of preset support

Automatic gem, dotnet, npm and release downloads from v1 remain pending. B12 does not provision packages even if `disableDownload` is overridden.

Real-server compatibility is pending a selected stack and its installed binary/toolchain. Local fake-server tests cover every preset through the manager, daemon/client and CLI chat/history at all terminal breakpoints.

## Diagnostics after a write

A successful `write`, `edit` or `apply_patch` reports errors, not warnings, under a `Diagnostics:` heading appended to the tool result. It covers at most 5 files and 20 lines.

Formatting runs first when the project configured it. See [formatters.md](formatters.md) for presets, configuration and process limits.

A write itself never starts, resolves or provisions a language server. Only servers already running for the written file take part.

A server starts when the model calls `lsp` or `diagnostics`, a client sends `lsp.query`, or in the background after a write as described below. It stops after five idle minutes.

| Server state | What the write reports |
|---|---|
| No server running for that file type | Nothing added and no wait: under 10 ms, no process, no PATH lookup. |
| Server running | Wait up to 300 ms; errors published by then appear in the write's own result. |
| Server answers later | Give it up to 4 seconds in the background. Append errors not already shown once to the session's next tool result, whichever tool it is, under `Diagnostics:`. A next write merges them into its own section. |

If errors shown at 300 ms are gone when the server finishes, the next result says so: `<file>: no errors (the language server finished after the earlier report)`.

- A later write of the same file replaces what an earlier write was still waiting for.
- Late errors of a cancelled turn are dropped.
- If a turn ends before the server answers, errors arrive on the first tool result of the session's next turn.

### Background warm-up

After a write returns, servers for written files (at most 5) that no running server covers start in the background. The next writes of that file type can then get diagnostics.

The write does not wait for warm-up and never reports its outcome. The first write of a file type therefore still carries no diagnostics.

| Rule | Behavior |
|---|---|
| Local servers only | Check PATH, the project's `node_modules/.bin`, data-dir caches and the presets' installed-toolchain checks. |
| No provisioning | No `pnpm add`, no `go install`, no download. A missing server stays missing until `lsp`/`diagnostics` is called or it is installed. |
| Concurrent attempts | One per project root and server; leave a running or starting server alone. |
| Started server | Open the written file, count as used and stop after the same five idle minutes. |
| Server count | No limit: every installed server claiming the file starts, as with `diagnostics`. |
| Missing server, missing project dependency or failed start | Remember for 10 minutes per project root and server; writes do not look again during that time. This memory belongs only to warm-ups: `lsp` and `diagnostics` still try. |
| Daemon stop | Cancel warm-ups that have not started and kill servers they started, including process groups. |

### Turn warm-up off

Language servers have no feature id of their own. Warm-up runs unless settings, with the tier and safe mode applied, deny both `lsp` and `diagnostics` (`tools` or `permission`). The check happens after the write.

- `.mendcode/lsp.json` set to `false`, or a disabled server, leaves nothing to start.
- `MENDCODE_LSP_WARMUP=0` turns warm-up alone off.
- The minimalist tier never warms up: it promises the least memory, so a language server runs only when `lsp` or `diagnostics` is called.

With the warm-up off, call `diagnostics` on one file of the project once to get diagnostics after every write: the server then stays up while it is used.

## Protocol and client API

`lsp.query` takes the same arguments as `lsp`, plus `directory`. `client.lsp(input)` returns `{ ok, report }`.

It is excluded from read-only peer commands because starting a configured server runs local code.

# Language servers

The daemon registers `lsp` alongside `diagnostics`. `lsp` supports `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls` and `outgoingCalls`.

Arguments: `operation`, `filePath`, `line`, `character`, and optional `query` for workspace symbols. Editor line/character are 1-based; returned LSP ranges are 0-based UTF-16. The file is synchronized before the request. Locations, location links, nested document symbols, Markdown hover and opaque call-hierarchy data are preserved. References include declarations; incoming/outgoing calls prepare the first hierarchy item on the same server. Workspace symbols search connected servers in the current project and keep the first ten relevant symbols per server, as v1 does.

`lsp.query` takes the same arguments plus `directory`; `client.lsp(input)` returns `{ ok, report }`. It is excluded from read-only peer commands because starting a configured server runs local code. Requests time out after 4 seconds; tool cancellation sends `$/cancelRequest`. Results stay in the transcript and `/history`; `ctrl+o` expands tool output. No separate LSP page or slash command is needed.

## Configuration

Project configuration is `.mendcode/lsp.json`. `false` or `{ "disabled": true }` disables all servers; `true` enables defaults. Overrides retain builtin extensions/root markers. `gopls`/`pyright` are accepted aliases for v2's `go`/`python` ids. Custom servers require command and extensions.

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

`env` is scoped to the child process. `initialization` goes to `initialize.initializationOptions`, dotted `workspace/configuration` requests and `workspace/didChangeConfiguration`. TypeScript discovers project `typescript/lib/tsserver.js`; Python discovers `VIRTUAL_ENV`, `.venv` and `venv`, unless initialization overrides the result. Go prefers a `go.work` workspace; Rust selects the enclosing Cargo workspace. Configuration is loaded lazily once per project, so restart the daemon after changing it.

## Offline bootstrap

Resolution checks PATH, project `node_modules/.bin`, then `<data dir>/lsp/bin`, `<data dir>/lsp/node_modules/.bin` and per-server caches. Missing TypeScript/Pyright binaries are provisioned with pnpm 11+ in `<data dir>/lsp/<id>`, strictly offline, scripts disabled and minimum release age 1440 minutes. Go uses its local toolchain/module cache with `GOPROXY=off`, `GOSUMDB=off` and `GOTOOLCHAIN=local`. Simultaneous bootstrap calls share one installer per server. Installers have a 15-second limit and tool cancellation kills the process group.

A provisioning that fails is remembered per server and project root for 10 minutes, with its reason (`pnpm is not on PATH`, `pnpm 11 or newer is required`, `pnpm add --offline … exited with code 1`, `go install gopls from the local module cache …`). Until then `lsp` and `diagnostics` answer at once with the same message, for example ``typescript-language-server is not installed (not found on PATH); offline provisioning failed (pnpm add --offline typescript-language-server typescript exited with code 1), next attempt in 10 min; run `mendcode lsp install typescript` to get diagnostics for .ts files`` (a server MendCode does not install says `install it` instead), and run no installer. Every call still does the local lookup (PATH, project `node_modules/.bin`, data-dir caches), so a server installed in the meantime is used by the next call without waiting for the interval. A cancelled provisioning is not remembered. The memory lives in the daemon process: restarting the daemon is the explicit retry (the tools have no restart action).

`bootstrap: false` skips the data-dir cache and provisioning. `disableDownload` is supported per server and globally (`MENDCODE_DISABLE_LSP_DOWNLOAD=1` also sets the global default) and prevents provisioning. Missing binaries produce an explicit unavailable result, including a downloads-disabled reason when applicable.

No network download runs automatically. `mendcode lsp install typescript|python|go` downloads one on request into the
same cache the lookups read (`<data dir>/lsp/<id>`, gopls in `<data dir>/lsp/bin`): pnpm 11+ without `--offline`, still
with `--ignore-scripts` and no release younger than a day, or `go install gopls@latest` through your Go proxy with the
local toolchain; up to 3 minutes. A server already found (PATH, the project, the cache) is reported and left alone. The
daemon runs it, only for a local client. v1 downloaded these on first use; MendCode asks you to run it once. Rust matches v1's installed `rust-analyzer` requirement. Local fake-server tests establish the protocol/tool/offline-bootstrap path, not compatibility with every real language server.

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

These presets use installed executables only, with `disableDownload: true` by default; no B11 installer or network download is implemented. Commands, extensions, env and initialization remain overridable in `.mendcode/lsp.json`. Missing executables and required project dependencies are reported, not silently installed. Real-server validation requires separately installed binaries.

Deno requires the nearest `deno.json`/`deno.jsonc`; TypeScript is excluded beneath either marker. Vue/ESLint/Svelte/Astro/YAML use the nearest package lock (`package-lock.json`, `bun.lockb`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`). Oxlint also recognizes `.oxlintrc.json` and `package.json`; Biome also recognizes `biome.json`/`biome.jsonc`. Lua recognizes `.luarc.json`/`.luarc.jsonc`, `.luacheckrc`, `.stylua.toml`/`stylua.toml`, `selene.toml`/`selene.yml`. Bash uses the requested project directory. `rootRequired` and `rootExcludes` may override those routing gates.

Biome and Oxlint prefer the nearest project `node_modules/.bin`, then ancestors up to the project directory, before PATH. Oxlint uses `--lsp` only after a bounded, cancellable `--help` probe advertises it; otherwise the standalone OXC server is tried. Astro requires project TypeScript and sends `typescript.tsdk`; ESLint requires the project `eslint` dependency. Explicit custom commands bypass these builtin dependency checks.

Every matching, available server participates in semantic requests and diagnostics, so linters complement the language server rather than being hidden behind it. Diagnostics retain available results and name unavailable servers; clean partial results do not claim that every server passed. Existing `lsp.query`, `client.lsp`, `lsp`/`diagnostics` tools and chat/history surfaces carry the results without new protocol commands or pages.

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

All B12 presets use installed executables with downloads disabled. Ty is opt-in: set `MENDCODE_EXPERIMENTAL_LSP_TY=1` or `servers.ty.disabled: false`. It discovers the same virtualenvs as Python, including the `ty` executable, and sends `pythonPath`. Intelephense disables telemetry; Terraform enables required-field prefilling and validation on save. Julia requires the installed `LanguageServer` package.

Root detection uses v1 markers, including wildcard project names (`*.slnx`, `*.sln`, `*.csproj`, `*.fsproj`, `*.xcodeproj`, `*.xcworkspace`, `*.tf`, `*.cabal`, `*.jl`). Java/Kotlin prefer Gradle settings, then wrapper, then module/Maven markers. An explicit `rootMarkers` override replaces this priority. Nix prefers a flake, then the enclosing Git root, then the project directory. Prisma preserves v1's `package.json` exclusion. Dockerfile matches both `.dockerfile` and the exact `Dockerfile` basename; `filenames` may override basename matching in server configuration. Document language ids preserve language aliases such as Ruby, F#, C++, Kotlin, LaTeX and Terraform variables.

Roslyn/F# also discover existing `.dotnet/tools` under `DOTNET_CLI_HOME` (or the home directory). Razor requires all three assets in an installed VS Code C# `.razorExtension`; `VSCODE_EXTENSIONS` selects an explicit extensions directory, otherwise standard VS Code locations are searched. The newest complete extension supplies source-generator, design-time targets and extension arguments. Custom commands bypass these builtin launch checks.

Existing data-dir caches may contain `<id>/bin/<command>`, `elixir-ls-master/release/language_server.sh`, `kotlin-ls/kotlin-lsp.sh`, `clangd_*/bin/clangd`, or `jdtls/plugins/org.eclipse.equinox.launcher_*.jar` with `config_mac`, `config_linux` or `config_win`. `bootstrap: false` skips those caches. JDTLS requires Java 21+ (PATH or `JAVA_HOME`) and keeps workspace data in `<data dir>/lsp/jdtls/workspaces/<root hash>`. Toolchain probes are bounded to two seconds and cancellable.

Automatic gem, dotnet, npm and release downloads from v1 remain pending; B12 does not provision packages even if `disableDownload` is overridden. Real-server compatibility is pending a selected stack and its installed binary/toolchain. Local fake-server tests cover every preset through the manager, daemon/client and CLI chat/history at all terminal breakpoints.

## Diagnostics after a write

A successful `write`, `edit` or `apply_patch` reports the errors (not warnings) of the files it wrote, at most 5 files and 20 lines, under a `Diagnostics:` heading appended to the tool result. Formatting runs first when the project configured it; see [formatters.md](formatters.md) for presets, configuration and process limits.

A write itself never starts, resolves or provisions a language server. Only servers that already run for the written file take part; one starts when the model calls `lsp` or `diagnostics` (or a client sends `lsp.query`), or in the background after a write (below), and stops after five idle minutes. So:

- No server running for that file type: the write adds nothing and waits for nothing (under 10 ms, no process, no PATH lookup).
- A server is running: the write waits up to 300 ms. Errors published by then are in the write's own result.
- The server answers later: it is given up to 4 seconds in the background. Errors that were not already shown are appended once, under the same `Diagnostics:` heading, to the session's next tool result, whichever tool that is; a next write merges them into its own section. If the errors shown at 300 ms are gone when the server finishes, the next result says so (`<file>: no errors (the language server finished after the earlier report)`).
- A later write of the same file replaces what an earlier write was still waiting for. Late errors of a cancelled turn are dropped. A turn that ends before the server answers delivers them on the first tool result of the session's next turn.

### Background warm-up

After the result of a write is returned, the servers of the written files (at most 5) that no running server covers are started in the background, so the next writes of that file type get diagnostics. The write does not wait for it and never reports its outcome; the first write of a file type therefore still carries no diagnostics.

- Only a server that is installed locally starts: PATH, the project's `node_modules/.bin`, the data-dir caches and the installed-toolchain checks of the presets. A warm-up never provisions: no `pnpm add`, no `go install`, no download. A missing server stays missing until `lsp`/`diagnostics` is called or it is installed.
- One attempt at a time per project root and server; a server that is already running or starting is left alone. The started server opens the written file, counts as used and stops after the same five idle minutes. There is no limit on the number of servers: every installed server that claims the file starts, as with `diagnostics`.
- A server that is missing, lacks its project dependency or fails to start is remembered for 10 minutes per project root and server; writes in that time do not look again. This memory belongs to warm-ups only: `lsp` and `diagnostics` still try.
- Language servers have no feature id of their own. The warm-up runs unless the settings, with the tier and safe mode applied, deny both the `lsp` and the `diagnostics` tool (`tools` or `permission`); the check happens after the write. `.mendcode/lsp.json` set to `false`, or a disabled server, leaves nothing to start. `MENDCODE_LSP_WARMUP=0` turns the warm-up alone off.
- The minimalist tier never warms up: it promises the least memory, so a language server there runs only when `lsp` or `diagnostics` is called.
- Stopping the daemon cancels warm-ups that have not started and kills the servers they started, process groups included.

With the warm-up off, call `diagnostics` on one file of the project once to get diagnostics after every write: the server then stays up while it is used.

# Formatters

Successful native `write`, `edit` and `apply_patch` calls format every written file before LSP diagnostics and the next model call. Moved files use their destination; deleted files are skipped. Clean formatting adds no transcript copy. Failures append a bounded `Formatting:` section to the existing tool result in chat and History; the original edit remains successful. Cancellation stops the formatter process group and subsequent commands.

A project without `.mendcode/formatter.json` pays one failed file read per written file and starts no process. A configured formatter always finishes, or is killed at its limit and reported under `Formatting:`, before the tool result is returned: the file never changes after the model was told the write succeeded.

Project configuration is `.mendcode/formatter.json`. Omit it or use `false` to disable formatting, `true` to enable builtins, or an object to enable builtins with overrides. Configuration is read on each invocation; changes apply without restarting.

```json
{
  "prettier": { "environment": { "PRETTIER_LOG_LEVEL": "warn" } },
  "oxfmt": { "disabled": true },
  "biome": { "disabled": true },
  "custom": {
    "command": ["project-fmt", "--write", "$FILE"],
    "extensions": [".custom"],
    "environment": { "FORMAT_MODE": "strict" }
  }
}
```

`command` is an argv array, never implicitly a shell. `$FILE` is replaced with the absolute filename in every argument. `environment` (or the v2 alias `env`) extends only the child environment. Builtin overrides retain extensions and `BUN_BE_BUN=1` unless replaced. Custom entries require command and extensions; `disabled` removes an entry. An explicit builtin command bypasses its project/experimental gate. Invalid entries are reported and never executed.

| Preset | Gate | Command |
| --- | --- | --- |
| `prettier` | Project `dependencies` / `devDependencies` includes Prettier | `prettier --write $FILE` |
| `oxfmt` | Project dependency plus `MENDCODE_EXPERIMENTAL_OXFMT=1` | `oxfmt $FILE` |
| `biome` | Project `biome.json` / `biome.jsonc` | `biome format --write $FILE` |

Prettier/Biome match JS/TS families, HTML, CSS/SCSS/Sass/Less, Vue/Svelte, JSON/JSONC, YAML, TOML, XML, Markdown/MDX and GraphQL. Oxfmt matches JS/TS families. Actual syntax support depends on the installed version/plugins, as in v1.

Resolution prefers the nearest project `node_modules/.bin`, then ancestors through the enclosing Git worktree, then PATH. Commands run in the session project directory, sequentially in registry order; all matching enabled formatters run. UTF-8 BOMs are preserved. A file has a four-second formatter budget; at the limit the formatter's process group is killed and the result says `timed out`. Diagnostics after the write have their own, much shorter wait ([lsp.md](lsp.md#diagnostics-after-a-write)). Same-file invocations are serialized. Formatter stdout/stderr and environment values are never included in replies.

Protocol: `formatter.status { directory }` and `formatter.file { directory, path }`; typed helpers: `client.formatterStatus(directory)` and `client.formatFile(directory, path)`. Status returns name/extensions/enabled/reason and config issues. File returns structured formatter outcomes. Neither command is permitted to read-only peers. No new TUI page or slash command is needed.

## Other stacks (B14)

| Preset | Extensions | Command / gate |
| --- | --- | --- |
| `gofmt` | `.go` | `gofmt -w $FILE` |
| `mix` | `.ex .exs .eex .heex .leex .neex .sface` | `mix format $FILE` |
| `zig` | `.zig .zon` | `zig fmt $FILE` |
| `clang-format` | `.c .cc .cpp .cxx .c++ .h .hh .hpp .hxx .h++ .ino .C .H` | `clang-format -i $FILE`; project `.clang-format` |
| `ktlint` | `.kt .kts` | `ktlint -F $FILE` |
| `ruff` | `.py .pyi` | `ruff format $FILE`; `ruff.toml`, `.ruff.toml`, or Ruff in `pyproject.toml`, `requirements.txt`, `Pipfile` |
| `air` | `.R` | `air format $FILE`; first help line must identify an R language formatter |
| `uv` | `.py .pyi` | `uv format -- $FILE`; `uv format --help` must succeed; skipped when project Ruff is available |
| `rubocop` | `.rb .rake .gemspec .ru` | `rubocop --autocorrect $FILE` |
| `standardrb` | `.rb .rake .gemspec .ru` | `standardrb --fix $FILE` |
| `htmlbeautifier` | `.erb .html.erb` | `htmlbeautifier $FILE` |
| `dart` | `.dart` | `dart format $FILE` |
| `ocamlformat` | `.ml .mli` | `ocamlformat -i $FILE`; project `.ocamlformat` |
| `terraform` | `.tf .tfvars` | `terraform fmt $FILE` |
| `latexindent` | `.tex` | `latexindent -w -s $FILE` |
| `gleam` | `.gleam` | `gleam format $FILE` |
| `shfmt` | `.sh .bash` | `shfmt -w $FILE` |
| `nixfmt` | `.nix` | `nixfmt $FILE` |
| `rustfmt` | `.rs` | `rustfmt $FILE` |
| `pint` | `.php` | `./vendor/bin/pint $FILE`; Composer `require` / `require-dev` includes `laravel/pint` |
| `ormolu` | `.hs` | `ormolu -i $FILE` |
| `cljfmt` | `.clj .cljs .cljc .edn` | `cljfmt fix --quiet $FILE` |
| `dfmt` | `.d` | `dfmt -i $FILE` |

Every preset needs an installed executable. Project gates search up to the enclosing worktree; Pint's executable remains relative to the session directory, as in v1. Disabling `ruff` or `uv` disables both backends. An explicit command bypasses builtin gates and help probes; extensions and child environment are configurable. Probes share the file's formatter budget and cancellation, and status probes stop with the manager. Only safe failure reasons reach chat/History or clients.

No formatter is installed or downloaded automatically. Real-tool validation requires installed binaries; local fake executables prove configuration, process lifecycle and daemon/client/engine integration only.

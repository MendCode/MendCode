# Formatters

MendCode formats files after successful native `write`, `edit` and `apply_patch` calls, before LSP diagnostics and the next model call. Configure your project's formatters in `.mendcode/formatter.json`.

## Configure formatting

Choose what `.mendcode/formatter.json` contains:

| Configuration | Effect |
|---|---|
| File omitted, or `false` | Disables formatting. |
| `true` | Enables builtins. |
| An object | Enables builtins with overrides. |

Configuration is read on each invocation; changes apply without restarting. A project without `.mendcode/formatter.json` pays one failed file read per written file and starts no process.

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

### Entry options

| Option | Does |
|---|---|
| `command` | An argv array, never implicitly a shell. `$FILE` is replaced with the absolute filename in every argument. |
| `environment` (v2 alias `env`) | Extends only the child environment. |
| `disabled` | Removes an entry. |

Custom entries require command and extensions. Builtin overrides retain extensions and `BUN_BE_BUN=1` unless replaced.

An explicit builtin command bypasses its project/experimental gate. Invalid entries are reported and never executed.

## Builtin formatters

| Preset | Gate | Command |
| --- | --- | --- |
| `prettier` | Project `dependencies` / `devDependencies` includes Prettier | `prettier --write $FILE` |
| `oxfmt` | Project dependency plus `MENDCODE_EXPERIMENTAL_OXFMT=1` | `oxfmt $FILE` |
| `biome` | Project `biome.json` / `biome.jsonc` | `biome format --write $FILE` |

Prettier/Biome match JS/TS families, HTML, CSS/SCSS/Sass/Less, Vue/Svelte, JSON/JSONC, YAML, TOML, XML, Markdown/MDX and GraphQL. Oxfmt matches JS/TS families. Actual syntax support depends on the installed version/plugins, as in v1.

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

Every preset needs an installed executable. No formatter is installed or downloaded automatically.

- Project gates search up to the enclosing worktree; Pint's executable remains relative to the session directory, as in v1.
- Disabling `ruff` or `uv` disables both backends.
- An explicit command bypasses builtin gates and help probes; extensions and child environment are configurable.

## What happens after a write

Every written file is formatted. Moved files use their destination; deleted files are skipped. UTF-8 BOMs are preserved.

Clean formatting adds no transcript copy. Failures append a bounded `Formatting:` section to the existing tool result in chat and History; the original edit remains successful.

A configured formatter always finishes, or is killed at its limit and reported under `Formatting:`, before the tool result is returned. The file never changes after the model was told the write succeeded.

### Execution order and limits

Resolution prefers the nearest project `node_modules/.bin`, then ancestors through the enclosing Git worktree, then PATH.

Commands run in the session project directory, sequentially in registry order; all matching enabled formatters run. Same-file invocations are serialized.

- A file has a four-second formatter budget. At the limit the formatter's process group is killed and the result says `timed out`.
- Cancellation stops the formatter process group and subsequent commands.
- Probes share the file's formatter budget and cancellation, and status probes stop with the manager.
- Diagnostics after the write have their own, much shorter wait ([lsp.md](lsp.md#diagnostics-after-a-write)).

Only safe failure reasons reach chat/History or clients. Formatter stdout/stderr and environment values are never included in replies.

## Protocol and validation

| Protocol | Typed helper | Returns |
|---|---|---|
| `formatter.status { directory }` | `client.formatterStatus(directory)` | Name/extensions/enabled/reason and config issues. |
| `formatter.file { directory, path }` | `client.formatFile(directory, path)` | Structured formatter outcomes. |

Neither command is permitted to read-only peers. No new TUI page or slash command is needed.

Real-tool validation requires installed binaries; local fake executables prove configuration, process lifecycle and daemon/client/engine integration only.

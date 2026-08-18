# MendCode themes

Themes are JSON documents with a top-level `theme` object using the same color keys as the built-in themes. An agent can create one from a visual reference, then validate and activate it without an AI call:

```sh
mendcode theme validate ./my-theme.json
mendcode theme install ./my-theme.json --name studio --scope project
mendcode theme select studio --scope project
```

Project themes live in `.mendcode/themes/` and the project selection is stored in `.mendcode/tui.json`. Use `--scope global` for the XDG MendCode config directory. Validation requires all supported UI color keys, accepts hex/ANSI/reference/variant values, rejects missing or circular references, and checks a minimum 3:1 text/background contrast when those values resolve to hex colors. The command is local-only and never calls a model or provider.

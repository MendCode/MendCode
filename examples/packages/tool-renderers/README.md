# Tool renderers

Two tool cards drawn from what the model actually asked for, as one package. It is the reference for `api.renderTool`
in `docs/extensions-tui.md`: each module is short and uses one part of that API.

```sh
mendcode package check examples/packages/tool-renderers
mendcode package install examples/packages/tool-renderers
```

| File | What it draws |
|---|---|
| `extensions/shell-command.ts` | `renderTool("shell")`: `$ command` with its `workdir` and `background` arguments and a status mark, then the last 3 lines of output (12 when the card is opened). While the call runs only the title is known, so the card is one line. |
| `extensions/github-mcp.ts` | `renderTool("mcp__github__*")`: every tool of a GitHub MCP server as one line, the action, `owner/repo`, the `#number` of an issue or pull request and its title. |

What it shows about the API:

- `args` is every argument of the call, parsed, bounded and frozen; `final` is true once the call has finished and they
  are all there.
- A name ending in `*` matches every tool with that prefix. An exact name wins over a pattern, the longest prefix over a
  shorter one.
- Returning `undefined` passes the call on: a shell call without a `command` argument, or a GitHub call without `owner`
  and `repo`, gets the next renderer or the built-in card.

Both modules are code that runs in the terminal with your permissions; read them before you enable the package.

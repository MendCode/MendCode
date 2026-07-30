# Custom Tool Calls

Custom tool calls let a project or shared package add assistant-facing actions without changing MendCode's built-in tools. A tool exposes a description and argument schema to the model, then runs local TypeScript or JavaScript when the model calls it.

Custom tools are different from MCP tools:

- **Custom tools** are local project/package code loaded from `.mendcode/tools`.
- **MCP tools** come from an MCP server configured for the project.

## Add a Project Tool

Create a `.ts` or `.js` file under `.mendcode/tools`. MendCode also accepts the singular `.mendcode/tool` directory for compatibility.

```tsx
// .mendcode/tools/lookup-package.ts
import { tool } from "@mendcode/plugin";

export default tool({
  description: "Look up a package note from the current repository.",
  args: {
    packageName: tool.schema
      .string()
      .min(1)
      .describe("The package name to inspect"),
  },
  async execute(args, context) {
    context.metadata({
      title: `Looking up ${args.packageName}`,
      metadata: { packageName: args.packageName },
    });

    return {
      output: `No local note found for ${args.packageName} in ${context.worktree}.`,
      metadata: { packageName: args.packageName },
    };
  },
});
```

The `tool.schema` helper exposes Zod schemas, so the argument definition is used both for validation and for the JSON schema sent to the model. A file's default export uses the filename as its tool ID (`lookup-package` in this example). Named exports use a `<filename>_<export>` ID.

## Tool Context

`execute(args, context)` receives:

- `sessionID` and `messageID` for the current conversation.
- `agent` for the active agent.
- `directory` for the current project directory.
- `worktree` for the project worktree root.
- `abort` to stop long-running work when the session is cancelled.
- `metadata()` to update the visible tool-call title and metadata.
- `ask()` to request a permission through MendCode's permission flow.

Return either a string or `{ output, metadata }`. Keep output concise; large results are truncated using the active agent's output policy.

## Share Tools With a Package

Add the tool directory to the package manifest:

```json
{
  "artifacts": {
    "tools": [".mendcode/tools"]
  }
}
```

The same directory can be enabled in a project-local `.mendcode/package.json` or distributed through a marketplace package. Do not include provider credentials, `.env` files, auth state, or machine-specific data in a shared tool.

## Safety Notes

Custom tools are trusted local code. Review them before enabling a package, use `context.ask()` for operations that need explicit permission, honor `context.abort` for long-running work, and avoid silently writing outside the current project/worktree.

For the broader plugin surface, see [TUI Plugins and Widgets](tui-plugins-and-widgets.md) and [Packages and Team Sharing](packages-and-team-sharing.md).

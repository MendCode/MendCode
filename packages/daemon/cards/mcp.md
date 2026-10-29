---
summary: connect an MCP server (mcp.json, mcp add, OAuth)
docs: mcp-oauth, tiers
aliases: mcp-servers, servers
---
Add a server with the CLI (the user runs it: mcp add, auth and logout are refused from your shell; writes one entry, keeps the others; --dry-run writes nothing; --replace for an existing name):
  {{program}} mcp add <name> [--scope user|project] -- <command> [args...]      a local (stdio) server
  {{program}} mcp add <name> [--scope user|project] --url <https://...> [--no-oauth] [--client-id ID --client-secret-env VAR]
Or write the file: <data dir>/mcp.json (user) or <project>/.mendcode/mcp.json (project). A running server that was replaced needs a restart.
  { "servers": { "docs": { "command": "bun", "args": ["${PACKAGE_DIR}/server.ts"], "env": { "TOKEN": "${DOCS_TOKEN}" } },
                 "remote": { "url": "https://mcp.example/mcp", "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" } } } }
${VAR} expands from the environment: never write a secret into the file. In a package, ${PACKAGE_DIR} is the package folder. Other keys: cwd, enabled, timeoutMs, transport, oauth (false, or {clientId, clientSecret, scope, callbackPort, redirectUri}).
The user's page is /mcps (alias /mcp): state, auth, and a to authorize a server that needs it.
Inspect: {{program}} mcp list; {{program}} mcp debug <name> (probes a remote server, never prints tokens); {{program}} control-plane mcp status|preview reads config without starting servers. OAuth login: {{program}} mcp auth [name] (the user completes it in a browser; tokens sit in <data dir>/mcp-auth.json, mode 0600: never read or print it); logout: mcp logout [name].
A project's servers (its mcp.json or its packages') are held until the user trusts the project in /tools; they never start before that. Tools and prompts of a server appear only while it is connected (mcp__<server>__<tool>); MCP belongs to the full tier ({{program}} docs tiers).

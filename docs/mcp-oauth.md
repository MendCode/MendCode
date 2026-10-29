# Remote MCP servers and OAuth

## Integration requests and local approval (full tier)

`POST /mcp` with a full REST token stores a pending server and returns **202** with
`{ "<name>": { "status": "pending", "expiresAt": <epoch milliseconds> } }`.
Peer `mcp.add` and MCP edits through `PATCH /config` or `/global/config` use the same
gate. They never start a process, contact the requested URL, discover tools/prompts/resources,
or authorize OAuth while pending. Replacing an approved entry suspends its running client;
all integration writes conservatively require approval again, including enable-only edits.

In the local terminal, open `/mcp`, select **pending approval**, review the quoted command,
argument array, environment **names** and working directory, or the URL, then press **a** to
approve or **x** to reject. **PgUp/PgDn** scroll long details. Secret argument values and URL
credentials/token parameters are masked; environment/header values never appear in this review.
Approval binds to the displayed revision: changed or expired requests require a fresh review.
Only local clients can send `mcp.decide`; full and read-only peers cannot approve or reject.
The server starts lazily after approval, under the normal MCP tier and tool permissions.

Pending requests persist in mode-0600 `mcp.json` across daemon restarts, expire after **24 hours**,
and share a daemon-wide limit of **10**, tracked in `mcp-pending-budget.json`. REST `GET /mcp`
lists pending state/expiry without execution details. Pending entries are omitted from config
responses. Rejection discards the submitted execution details. Rejection/expiry leave disabled
entries so a lower config layer cannot silently reactivate the same name. A fresh request or
an explicit local replacement is needed; no external service or account is enabled automatically.

An MCP server entry with a `url` instead of a `command` is a remote server. It is reached over streamable HTTP (one POST per message, answered as JSON or as an event stream). A server that has no such endpoint (HTTP 400, 404 or 405 on the first call) is tried again over the older HTTP+SSE transport, where `url` is the event stream.

```json
{
  "servers": {
    "docs": { "url": "https://mcp.example.com/mcp" },
    "keyed": { "url": "https://api.example.com/mcp", "headers": { "x-api-key": "${EXAMPLE_KEY}" }, "oauth": false },
    "manual": { "url": "https://mcp.other.com/sse", "transport": "sse", "oauth": { "clientId": "abc", "scope": "read" } }
  }
}
```

| field | meaning |
|---|---|
| `url` | http(s) URL. Set exactly one of `url` or `command`. |
| `transport` | `"http"` or `"sse"` to skip the automatic choice. |
| `headers` | Sent on every request; `${VAR}` (or `{env:VAR}`, the v1/opencode spelling) is expanded from the environment like everywhere in `mcp.json`. `{file:path}` is a file's text without its final newline (relative to the `mcp.json`, or `~/…`; at most 64 KB), for a token kept in its own file. It is read only in your own `mcp.json` and a trusted project's own, never in a package's (a package could send your files to its server); a missing file becomes empty and is reported in `/mcp`. |
| `oauth` | `false` turns OAuth off (a 401 then just means the headers are wrong). An object sets `clientId`, `clientSecret` (for a client registered by hand), `scope`, `callbackPort` and `redirectUri`. |
| `timeoutMs` | As for local servers. |
| `elicitation` | `false` stops the client announcing elicitation to this server (local or remote); its questions are then declined. On by default. |

## The flow

When a remote server answers 401 and no stored token fixes it, the server is `failed` with the error `needs authorization`, and its status shows `auth: "needs_auth"`. Authorization then works like this (`McpManager.startAuth`):

1. Discovery. The `WWW-Authenticate` challenge points at the protected resource metadata (RFC 9728), or the well-known URLs are tried. That names the authorization server, whose metadata (RFC 8414, with the OpenID configuration as fallback) gives the authorization, token and registration endpoints. A server without resource metadata is treated as its own authorization server. Endpoints must be https, except on 127.0.0.1 and localhost. PKCE `S256` is required when the server lists its methods.
2. Client. A configured `oauth.clientId` is used as is. Otherwise the client registers itself (RFC 7591) with the selected redirect and `token_endpoint_auth_method: none`. Without a registration endpoint and without a `clientId` the call fails and says to set one.
3. A one-shot HTTP listener opens on `127.0.0.1` and a random port by default (v2 compatibility). `oauth.callbackPort` selects a fixed port and the v1 path `/mcp/oauth/callback`; `oauth.redirectUri` takes precedence and selects the advertised URI, listener port and callback path (HTTP defaults to 80, HTTPS to 443). Redirects accept HTTP(S), including a query, but no credentials or fragment. The listener remains loopback-only (`::1` for an IPv6 loopback URI); external/TLS redirects require a user-managed proxy forwarding the path and query to this HTTP listener. No proxy or service is deployed. A busy port fails instead of silently changing the registered redirect. `startAuth` returns the authorization URL (PKCE challenge, `state`, the `resource` indicator of RFC 8707, `scope` from the config, the challenge or the resource metadata). The caller opens it in a browser.
4. The redirect (default `http://127.0.0.1:<port>/callback`) is checked against `state`; a wrong state is refused and the listener keeps waiting. The same URI is used in registration, authorization and token exchange. The code is exchanged at the token endpoint with the PKCE verifier (client secret as basic auth or in the body, as the server supports). The listener closes after the first valid redirect, after 5 minutes, or on cancel.
5. Tokens are stored and the server is restarted; `completion` resolves with its status (`running`, tools counted, `auth: "authorized"`).

One flow per server: starting another cancels the first. `cancelAuth` stops a waiting flow; `forgetAuth` disconnects the server and deletes its client and tokens.

## Tokens

`<dataDir>/mcp-auth.json`, mode 0600, written atomically, keyed by the server URL. It holds the client registration, the token endpoint, the access token with its expiry and the refresh token. Nothing else is stored and nothing is logged.

- A token that expires within 60 seconds is refreshed before the request. Concurrent requests share one refresh. A rotated refresh token replaces the old one.
- A 401 with a stored token triggers one refresh and one retry.
- A refresh token the server rejects (`invalid_grant`) is deleted, the client registration stays, and the server goes back to `needs_auth`. A network error during refresh keeps the tokens.
- A corrupt file counts as empty.

## Status

`mcp.status` shows remote servers like local ones: `command` holds the URL without query or credentials followed by `[oauth: authorized]`, `[oauth: needs authorization]` or `[oauth: waiting for the browser]`. The manager's status also carries `transport: "remote"` and `auth: "none" | "needs_auth" | "pending" | "authorized"` (see the protocol note below).

## Terminal and protocol

On `/mcps`, select a server with `auth: needs_auth` and press `a` (`a auth`), or run `/mcp auth <server>`. The terminal shows the authorization URL and copies it through OSC 52 (`auth URL copied`); `c` copies it again. Open that URL yourself. `mcp.changed` events refresh the page when authorization starts or settles, including denial/cancellation. The daemon never opens a browser.

The additive protocol command and optional status fields are:

```ts
// commands.ts
export const McpAuth = z.strictObject({
  ...base,
  type: z.literal("mcp.auth"),
  directory: z.string().min(1).max(4096),
  server: z.string().min(1).max(200),
  /** start (default): returns the URL to open; cancel; forget: drop stored client and tokens. */
  action: z.enum(["start", "cancel", "forget"]).optional(),
})
// Ack of "start": { url: string } at once; when the browser redirect completes, a global event or a follow-up
// mcp.status shows the new state via mcp.changed. Ack of "forget": { server: McpServerStatus }.

// queries.ts, McpServerStatus
transport: z.literal("remote").optional(),
auth: z.enum(["none", "needs_auth", "pending", "authorized"]).optional(),
```

`McpControl` (daemon.ts) exposes optional `startAuth`, `cancelAuth` and `forgetAuth` methods with the manager signatures (older controls can omit them). Start returns `{ url }` immediately; cancel acknowledges without a result; forget returns `{ server }`. Unknown/local/OAuth-disabled targets return `target_mismatch`; an unavailable OAuth control returns `invalid_command`. The daemon observes `completion` and emits `mcp.changed { directory, server }` on either outcome. No polling is needed.

## Limits

- External/TLS redirects need a user-managed forwarder; without one, the browser must reach the daemon's loopback listener.
- A client is registered anew for each authorization (the default redirect port changes), so the authorization server may list several MendCode clients.
- No `offline_access` scope is requested unless the server or config names it.
- Server-initiated requests other than `ping` and `elicitation/create` (see below) are answered "method not supported", and the standalone GET stream of streamable HTTP is not used. Elicitation therefore works for requests a server sends while a tool call is running (on stdio, SSE and inside the call's own event stream).

## Resource tools for the model

While some enabled server offers resources or URI templates, the model gets two read tools (they vanish when none does, so they cost no prompt space otherwise):

- `mcp_resource_list` (`server` optional): one line per resource (`server`, `uri`, name, MIME type, description) and per template, at most 200 lines, plus per-server discovery issues. A server name with no resources answers with the servers that have some.
- `mcp_resource_read` (`server`, `uri`): the text of the resource, in the same 1 MiB and output limits as `@server:resource`. Binary content is labelled with its type and size, never inlined. Unknown servers, disabled servers and read failures come back as tool errors.

Both are `read` tools, so they run without approval in the usual modes (permission rules can still deny them by name). They use the servers the user configured and the same catalog cache as `/mcps`. Nothing is added to `READ_ONLY_COMMANDS` and the tools are not reachable from remote clients: only the model's own turn calls them.

## Elicitation

A server may ask the user for input while a tool call is running (`elicitation/create`, form mode of the 2025-06-18 specification). The client announces `capabilities.elicitation` at the handshake unless the server entry sets `"elicitation": false`. The question shows up like any other question: titled `<server> asks for input`, the server's message as the prompt, one tab per field (strings and numbers are typed, booleans are Yes/No, enums and `oneOf` lists are options, `array` of enum is multi-select, more than nine choices become typed text). A form with no fields is a plain accept/decline.

- The answer is typed against the requested schema (required fields, `minLength`/`maxLength`, `minimum`/`maximum`, integers, enum membership, item counts). An answer that does not fit is sent as `cancel`, with no content.
- Declining the question sends `decline`; abandoning it sends `cancel`. Without a person to ask (no question channel in that run), for `url` mode, for a field type that cannot be asked, or when a field name or title looks like a credential (password, token, secret, API key, ...), the client answers `decline` without showing anything.
- Elicitations arrive only during a model tool call and use that call's question channel, so they are only ever shown to the person running the session; a server cannot ask outside a call. The answer goes to the server that asked and is not logged by the client.
- The call's timeout (`timeoutMs`) stands still while the question is open, and the clock restarts afterwards.

## Standalone MCP CLI

`mcp auth list` shows OAuth-capable remote servers, including expired credentials. `mcp auth [name]` selects a server when omitted, returns the authorization URL and waits for a running authorized server through `mcp.changed`. Interrupt, denial and the five-minute deadline have distinct nonzero exits; interruption and timeout cancel the flow. `mcp logout [name]` also finds expired stored credentials and forgets both the client registration and tokens.

`mcp debug <name>` sends an unauthenticated initialize probe (at most 20 seconds) and discovers OAuth metadata after HTTP 401. It reports sanitized endpoints, HTTP status, credential presence and expiry; it never prints tokens, registers a client or refreshes credentials. Local and OAuth-disabled servers are rejected. This operation can contact a remote server, so it is not in the remote read-only command allowlist.

`mcp add` supports a bordered local/remote terminal wizard or explicit arguments. Additive `mcp.add` writes one unexpanded entry atomically to `<dataDir>/mcp.json` (`user`) or `<project>/.mendcode/mcp.json` (`project`), preserving other servers and fields. Client secrets entered as `--client-secret-env VAR` remain `${VAR}` references. `--dry-run` writes nothing; malformed existing files and duplicate names without `--replace` are refused. Read-only `mcp.status` adds optional `authStored` and `authExpiresAt` fields without exposing credentials. A replaced running server needs restart to adopt the new config.

`mcp add docs --url https://mcp.example/mcp --callback-port 19876 --redirect-uri http://127.0.0.1:19876/mcp/oauth/callback` stores the callback settings without starting authorization. They conflict with `--no-oauth` and are not accepted for local servers.

## Project servers and trust

A server that comes from a project (`<project>/.mendcode/mcp.json` or a project package's `mcp.json`) can run a command or reach a URL of the repository's choosing, so it follows the same `/tools` trust as project hooks, extensions and custom tools. While the directory is not trusted, such a server is listed in `/mcp` and `mcp.status` with `needsTrust` and nothing else happens: no process is spawned, no URL is contacted, no tools, prompts or resources are discovered, and no OAuth starts; calling one of its names answers as if the server did not exist. User-scope servers (`<dataDir>/mcp.json`, user packages) are unaffected.

A trusted project's stdio server starts with the shell-hook environment policy: names that look like credentials (`CREDENTIAL_ENV`: provider and cloud keys, tokens, passwords) are not inherited unless the server's own `env` lists them (a literal value or a `${VAR}` reference written in its config).

The server set is rebuilt, not just read once, whenever it can change: package install, enable, disable and remove, and trusting or untrusting a directory. Servers that are no longer configured stop (an idle one at once, one in use after its call), new ones are available lazily, and an entry whose command, URL or env changed restarts on next use. A reload never discards a running client whose configuration did not change.

## Resources and prompts

Discovery isolates failures per server and per category: a failed prompt list does not hide available resources. Diagnostics stay visible in the catalog.

`/mcps` → `x` opens the bordered catalog. `tab` cycles resources, prompts and URI templates; arrows select, `r` reads a resource, `l` reloads, and `esc` returns to servers. `enter` inserts `@server:resource` or `/server:prompt` into the editor; it never submits. `PgUp/PgDn` scroll details. Below 70 columns the panels stack. URI templates are discoverable but require a concrete URI for `mcp.resource.read`.

Resource aliases appear beside files in the `@` picker. Names replace punctuation/spaces with `_`, preserving v1's `server:name` aliases. Submission reads each selected resource once and appends text to the engine prompt; binary content gets a MIME label rather than base64. Missing/ambiguous resources fail without starting a turn. A prompt allows at most 16 distinct resource mentions and 128,000 resource-text characters.

MCP prompts join custom slash commands, without replacing project/user/extension commands. Arguments support quoted strings and follow the server's declaration order; the final argument collects remaining words. Missing required arguments retain the draft and show the error. `prompts/get` text messages form the submitted prompt; non-text media are omitted. Extra text for a prompt without declared arguments is appended.

Additive commands: `mcp.catalog`, `mcp.resources.list` (the functional equivalent of experimental resource.list), `mcp.resource.read`, `mcp.prompts.list`, `mcp.prompt.get`. All take `directory`; read/get also take `server` and `uri`/`name` (get accepts an `args` object). Typed client helpers are `mcpCatalog`, `readMcpResource`, `getMcpPrompt`. These operations may start servers/contact services and expose content, so none is remotely read-only. Read-only peers' `commands.list/expand` also skip MCP discovery. The HTTP bridge remains B83's responsibility.

Discovery respects advertised capabilities, follows at most 100 pages/10,000 entries per category and rejects repeated cursors. Catalog caches invalidate on resource/prompt list-change notifications and reconnect. Reads/get use existing transport cancellation/timeouts; resource responses are bounded to 1 MiB and prompt responses to 256 KiB. Tests use local stdio/HTTP/SSE fakes; real external-service integration is not verified.

# Catalog REST compatibility (B83)

Use the opt-in HTTP adapter to access v1 catalog/control routes through native daemon services and additive `catalog.rest` commands. This page lists the routes, approval flow and credential import limits.

## Access the routes

Use a **full token** for every route below, including catalogs. The listener remains off by default and loopback-only with existing token auth.

Catalogs require a full token because:

- Extensions can load code.
- MCP discovery can contact services.
- Tool/command catalogs contain user content.

None is in `READ_ONLY_COMMANDS`. Directory/workspace routing, size limits, CORS and revocation use the existing HTTP adapter.

### Routes

| Method and path | Result |
| --- | --- |
| GET `/config/providers` | `{providers, default}` for configured native/plugin providers |
| PUT/DELETE `/auth/:providerID` | `true`; import/remove one private credential without removing models/settings |
| GET `/experimental/tool?provider=ID&model=ID` | `{id, description, parameters}[]`, real native/project schemas, permissions applied |
| GET `/experimental/tool/ids` | eligible native/project tool IDs |
| GET `/command` | project/user/extension/MCP command entries with `template` |
| GET `/agent`, `/skill` | native agents; skills include `location` pointing to `SKILL.md` |
| GET `/lsp`, `/formatter` | active language-server roots/state; enabled formatter registry |
| GET `/mcp` | name-keyed `{status: connected/disabled/needs_auth/failed/pending}`; pending includes `expiresAt` |
| POST `/mcp` | stage native project config for local `/mcp` approval; HTTP 202 pending status map, no connection |
| POST `/mcp/:name/auth` | `{authorizationUrl, oauthState}`; PKCE flow, caller opens URL |
| POST `/mcp/:name/auth/callback` | `{code}` completes pending flow, restarts server and returns status |
| POST `/mcp/:name/auth/authenticate` | waits for an existing flow; otherwise HTTP 202 plus authorization URL |
| DELETE `/mcp/:name/auth` | forget registration/tokens and disconnect; `{success: true}` |
| POST `/mcp/:name/connect`, `/disconnect` | `true`; disconnect suppresses lazy discovery until explicit reconnect |
| GET `/provider` | `{all, default, connected}` with native/preset/plugin model metadata |
| GET `/provider/auth` | provider-keyed indexed `{type, label, prompts?}[]` |
| POST `/provider/:providerID/oauth/authorize` | `{method, inputs?}` → `{url, method, instructions}` |
| POST `/provider/:providerID/oauth/callback` | `{method, code?}` → `true`, only for this project's pending method |
| GET `/experimental/resource` | name-keyed MCP resources with `client` server name (B47 bridge) |

The existing POST `/command` framed-command bridge is unchanged.

### Errors and private data

HTTP errors are sanitized; credentials never appear in catalogs/replies. Stores retain private atomic writes.

| Condition | HTTP status |
| --- | --- |
| Unknown MCP name | 404 |
| Unavailable adapter | 501 |

## Review MCP requests locally

Integration MCP requests persist across restart, expire in 24 hours and share a daemon-wide cap of 10.

1. In local `/mcp`, review command/args/environment names or URL.
2. Press `a` to approve or `x` to reject.

Peers cannot send `mcp.decide`. REST edits suspend the existing client and require a new review; MCP config PATCH requests follow the same conservative gate. See [pending approval](mcp-oauth.md#integration-requests-and-local-approval-full-tier).

### MCP configuration and disconnect

MCP additions persist in project `.mendcode/mcp.json` rather than donor process-only config. Disconnect is process-local and never changes the config's `enabled` flag.

## Authorize with OAuth

OAuth is explicit and opens no browser. It uses existing loopback callbacks, PKCE/state validation and one-use code exchange.

- Authenticate returns 202 when human authorization is needed.
- Pending waits are cancellable and bounded to 55 seconds.
- Indexed methods map to native browser/device ChatGPT, Copilot and registered plugin flows, rather than inventing provider adapters.

## Import or remove credentials

Credential import supports:

- API keys for configured/preset providers and registered plugins.
- ChatGPT OAuth.
- Registered plugin OAuth.

R9 adds the following through the existing provider stores. No network call is made by an import.

### API metadata

API `metadata` is accepted for providers that have a native equivalent:

| Provider | Accepted metadata |
| --- | --- |
| Azure | `resourceName` |
| Cloudflare Workers AI | `accountId` |
| Cloudflare AI Gateway | `accountId`/`gatewayId` |

Any other key or provider is a 400 and nothing is saved.

### Well-known credentials

`wellknown` credentials are stored privately in `provider-metadata-auth.json` (0600). They are resolved by a provider's `apiKeyEnv`, which is set on a configured provider of that id and never exported to the process environment.

### Manual Copilot OAuth

Manual `github-copilot` OAuth (also `github-copilot-enterprise`) goes into the Copilot credential store.

- `enterpriseUrl` maps to `https://copilot-api.<domain>`: an HTTPS domain, or a loopback origin for local fakes. Credentials, paths and queries are refused.
- The refresh token is dropped for enterprise since it cannot refresh against another issuer.

### Import limits and deletion

Enterprise OAuth for ChatGPT/OpenAI and plugin credentials with metadata still return 501 without mutation.

DELETE also drops a stored well-known credential. Environment credentials survive DELETE because this endpoint owns only v2's private stores.

## Read MCP state in the terminal

The existing bordered `/mcps` grid displays native state events, including temporary disconnect and OAuth. It no longer claims every disabled server was disabled in config or adds `no output` filler.

Headers and compact stacking stay intact. Copy confirmation lives in the header, without overlaying a panel, and settled authorization clears obsolete URLs.

## Implementation and verification

Compatibility decisions retain v1 paths/envelopes with native metadata, without inventing model cost/context limits.

`client.restCatalog(directory, input)` exposes native catalog control without importing runtime schemas into CLI startup. OpenAPI includes both bridges and strict credential, OAuth and local/remote MCP body schemas.

External-engine tool schemas are owned by that engine and return 501. Real provider/MCP service acceptance remains unverified; tests inject only local fakes.

Frames: `bun scripts/render-frames.ts .agents-frames/B83 --b83 100x30 180x50`.

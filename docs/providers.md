# API-key providers

Google Vertex AI uses daemon-owned ADC rather than an API key; see [Vertex](#google-vertex-ai--gcp-adc-b1004).

The native engine runs on the ChatGPT subscription by default. It can also use models from API-key providers, chosen per session with `/model` exactly like the subscription's models. Nothing changes for ids without a namespace: every existing session and setting keeps using the subscription.

A subscription request that stops answering is abandoned and sent again, with the reason in the retry line. Three waits, each with its own limit: no response headers for 10 s (`chatgpt did not answer the request in 10s, stream stalled`), headers but not one event for 20 s (`chatgpt sent no event in 20s after answering, stream stalled`), and a stream that already started and goes quiet for 120 s (`chatgpt no data for 120s, stream stalled`). The first retry after either of the two short limits starts at once; later ones wait as any other retry does (0.5 s doubling up to 30 s). Each time a conversation's request runs out of the 10 s limit, that conversation's next requests get twice as long (20 s, 40 s, up to the 120 s limit), so a request the backend answers slowly (a body with several images, a loaded connection) ends instead of being repeated forever. These retries are not shown as `Offline`: that line is for a connection that failed, not for a backend that is slow. Any event counts for the 20 s limit, not only text, so a model that thinks for minutes is not cut. API-key providers keep a single limit for all three waits (their `chunkTimeout`, or the default).

## Model ids

A provider's models appear in the catalog as `<providerId>:<model>`, split at the **first** colon:

| Id | Goes to |
|---|---|
| `gpt-6-luna` | the ChatGPT subscription (no namespace) |
| `anthropic:claude-sonnet-5-5` | Anthropic Messages API |
| `openrouter:google/gemini-3-pro` | OpenRouter |
| `ollama:llama3:8b` | the local Ollama (model `llama3:8b`) |

A namespace nobody registered is an error (`no provider "x" for model x:y`), never a call to the subscription with a foreign id. Claude Code models (`claude-opus`, ...) are unaffected: they keep their own engine.

## Providers

| Type | Wire format | Presets |
|---|---|---|
| `openai` | Responses API, `Authorization: Bearer` | `openai` (`https://api.openai.com/v1`) |
| `anthropic` | Messages API, `x-api-key` + `anthropic-version: 2023-06-01` | `anthropic` (`https://api.anthropic.com/v1`) |
| `openai-compatible` | Chat Completions (`/chat/completions`, `stream: true`, `stream_options.include_usage`) | `openrouter`, `vercel`, `groq`, `deepseek`, `ollama`, `lmstudio`, or any endpoint you define |
| `cohere` | Native Cohere Chat v2 (`/chat`, SSE, Bearer token) | `cohere` (`https://api.cohere.com/v2`, Bearer key) |

Feature matrix:

| | openai | anthropic | openai-compatible |
|---|---|---|---|
| Text streaming | yes | yes | yes |
| Tool calls | yes | yes (one at a time) | yes |
| Reasoning deltas shown | summaries | thinking | `reasoning_content` / `reasoning` |
| Reasoning effort | `reasoning.effort` | thinking budget: low 2k, medium 8k, high 24k (xhigh 32k, max 48k), none = off | `reasoning_effort` (OpenRouter: `reasoning: { effort }`; DeepSeek: plus `thinking`) |
| Signed reasoning replay in tool loops | not needed | yes (kept for the turn, dropped at the next user message) | not needed |
| Prompt caching | `prompt_cache_key` | `cache_control` on the system prompt and the last turn | provider's own (usage shows cache reads) |
| Usage | input, output, reasoning, cache read | input, output, cache read/write | input, output, reasoning, cache read, cost (OpenRouter) |
| Images | yes | yes | yes (per model `images: false` drops them with a note) |
| Hosted tools | `web_search` only | no | no |
| 429 / 5xx / network | retried (honours `retry-after`, `retry-after-ms`, HTTP dates) | same | same |
| 401 / 403 | clear `[AUTH]` error naming the provider, final | same | same |
| Abort | `request.signal` ends the stream | same | same |

Retries use the engine's existing wait (`RetryableProviderError`): rate limits and overload are waited out with backoff, a spent quota (`insufficient_quota`) is final.

## Outbound endpoint policy and provider defaults

Every provider endpoint MendCode **calls** follows one rule (`outboundEndpoint` in `packages/engine-native/src/endpoint-policy.ts`):
`https://` to any host, plain `http://` only to a literal loopback host (`127.0.0.1`, `[::1]`, `localhost`), nothing else, and never
credentials, a query or a fragment in the URL. Redirects are refused (`redirect: "error"`) on every provider request. The rule governs
outbound requests only. Anything MendCode **listens** on (REST/HTTP, PTY, OAuth callbacks) keeps its own opt-in, loopback-bind,
token-required behavior. Custom endpoints you define yourself (`providerType` + `baseUrl`) keep their existing http(s) check.

Providers stay opt-in: none of the providers below is enabled by an environment key alone. Connect it (`/connect <provider>`,
`providers login`, `providers.set`) with a credential; enabling without one is refused. Credentials live in the private mode-0600
provider store or an environment reference, never in settings files, and are scrubbed from errors, logs and events by value.

| Provider | Default endpoint | Auth |
|---|---|---|
| `google` | `https://generativelanguage.googleapis.com/v1beta` | API key (`x-goog-api-key`) |
| `github-copilot` | `https://api.githubcopilot.com` | device login or token |
| `azure` | your resource: `https://<resource>.openai.azure.com/openai` (required) | API key or Entra |
| `amazon-bedrock` | `https://bedrock-runtime.<region>.amazonaws.com` (region defaults to `us-east-1`) | AWS chain or bearer token |
| `google-vertex` / `google-vertex-anthropic` | `https://<location>-aiplatform.googleapis.com/v1` (project required) | Google ADC |
| `xai` | `https://api.x.ai/v1` | Bearer key |
| `mistral` | `https://api.mistral.ai/v1` | Bearer key |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | Bearer key |
| `cerebras` | `https://api.cerebras.ai/v1` | Bearer key |
| `cohere` | `https://api.cohere.com/v2` | Bearer key |
| `togetherai` | `https://api.together.ai/v1` | Bearer key |
| `perplexity` | `https://api.perplexity.ai` | Bearer key |
| `alibaba` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | Bearer key |
| `opencode` (Zen) | `https://opencode.ai/zen/v1` | Bearer key |
| `llmgateway` | `https://api.llmgateway.io/v1` | Bearer key |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | Bearer key |
| `zenmux` | `https://zenmux.ai/api/v1` | Bearer key |
| `kilo` | `https://api.kilo.ai/api/gateway` | Bearer key |
| `sap-ai-core` | from your service key (`serviceurls.AI_API_URL` + `/v2`) | JSON service key, OAuth client credentials |
| `gitlab` | your instance URL (required, no default) | access token |
| `cloudflare-workers-ai` | `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/v1` (account id required) | Bearer token |
| `cloudflare-ai-gateway` | `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>/compat` (both ids required) | gateway token |

Override a default with `baseUrl` (a proxy or gateway of your own); it must satisfy the rule above. Defaults were not called from
tests: every test uses local fake servers and temporary stores, so none of these services has been exercised for real by this change.
`perplexity`: the repo's earlier research recorded the public Sonar Chat Completions endpoint as retired on 2026-09-27 in favor of the
non-OpenAI-compatible Agent API (`/v1/agent`); the migration page says synchronous and streaming Sonar requests keep working, but
that is unverified here and an Agent API adapter does not exist yet.

## `<dataDir>/providers.json`

A user extension can add the same kind of entry in code, `api.registerProvider({ id, type, baseUrl, apiKeyEnv, models })`, live
on save and gone when the extension is: see [extensions](extensions.md#providers). An entry here with the same id wins.

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openrouter": { "apiKeyEnv": "MY_OPENROUTER_KEY", "models": [{ "id": "google/gemini-3-pro", "name": "Gemini 3 Pro", "context": 1000000, "effort": true, "images": true }] },
    "ollama": { "models": [{ "id": "llama3:8b" }] },
    "corp": { "type": "openai-compatible", "baseUrl": "https://llm.corp.example/v1", "apiKey": "...", "headers": { "x-team": "dev" } }
  }
}
```

| Field | Meaning |
|---|---|
| `type` | `openai`, `anthropic` or `openai-compatible`. Presets fill it; required for your own ids. |
| `baseUrl` | Endpoint root; presets fill it, override it for a proxy. |
| `apiKey` / `apiKeyEnv` | The key, or the name of an environment variable read on every request. `apiKey` wins, then `apiKeyEnv`, then the preset's variable. |
| `headers` | Extra request headers (a gateway's own). |
| `models` | `{ id, name?, context?, inputLimit?, outputLimit?, effort?, reasoning_options?, images?, variants?, compaction? }`. `effort: true` shows low/medium/high in `/model`; `reasoning_options` (models.dev's shape) names the levels instead ([below](#reasoning-levels-from-the-catalog)). Replaces the built-in list. |
| `models[].compoundPricing` | Optional `{inputUsdPer1M, outputUsdPer1M, cacheReadUsdPer1M, cacheWriteUsdPer1M, source}` for compound USD reservations. Record the price source; missing/all-zero prices stay unknown. See [Compound](compound.md). |
| `enabled` | `false` hides the provider's models and refuses its calls. |
| `compaction` | `{ token_limit?, threshold? }` applies to the provider; a model's `compaction` overrides it. `providers.set` accepts `null` to clear the provider override. |
| `npm` | An already installed SDK package, absolute module path or local `file://` URL. Adding/changing it disables the provider until `enabled: true` is explicitly set. No automatic installation. |

The file is written with mode 0600 (atomic rename); a file with wider permissions is tightened when read. Unknown fields survive a rewrite.

Environment keys enable their preset automatically when `providers.json` has no entry for it: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` (Vercel), `GROQ_API_KEY`, `DEEPSEEK_API_KEY`. Local servers (`ollama`, `lmstudio`) need no key but an explicit entry.

### Model lists

The catalog shows a provider's models only while it is enabled and has a key (or needs none). The list is, in order: `models` from the file, then the preset's starting list. The starting lists are in one place, `packages/engine-native/src/provider-presets.ts`, and **will age**: replace them with `models` or run `providers.refresh`, which does `GET /models` (10 s limit) and stores the provider's own list in `providers.json` (at most 400 models, sorted by id).

To change only one model's context window (any provider, the ChatGPT subscription included), do not rewrite `models`: in a
session on that model type `/context-window 500k --always`, which saves the daemon setting `modelContext` for it
(`{ "chatgpt/gpt-6-astra": { window: 500000 } }`). A window above the model's known maximum (`maxContextWindow` in
`mendcode models --verbose`; `gpt-6-astra`: 872,000) is lowered to it. See [compaction](compaction.md#per-model-window-modelcontext).

## Commands

The command envelope owns `id` and `type`, so the provider is `provider` and the wire format is `providerType`.

| Command | Reply |
|---|---|
| `providers.list` | `{ providers: ProviderInfo[] }` |
| `providers.set { provider, providerType?, baseUrl?, apiKey?, apiKeyEnv?, headers?, enabled?, models? }` | `{ provider: ProviderInfo }` |
| `providers.remove { provider }` | `{ providers: ProviderInfo[] }` |
| `providers.test { provider, model? }` | `{ ok, latencyMs, model?, error? }` |
| `providers.refresh { provider }` | `{ provider: ProviderInfo }` |

`ProviderInfo` is `{ id, type, baseUrl, enabled, hasKey, keyTail?, source: "config" | "env", models, error? }`. The key never appears: `hasKey` and a masked tail (`…3f2a`, only for keys of 16+ characters). `providers.set` leaves fields you omit unchanged; `apiKey: ""` and `models: []` clear theirs. A provider that is not a preset needs `providerType` and `baseUrl`; a preset's type cannot change; `chatgpt` is reserved.

`providers.test` sends one tiny streaming request (8 output tokens; the Responses API's minimum is 16, so `openai` sends 16). It costs a few tokens and runs only when a client sends it.

## Model variants

`/variants` or Shift+F3 opens this session's variant picker. F3 cycles named variants and Default; models without named
variants retain their effort cycle. Configure a provider model with, for example,
`"variants": { "precise": { "effort": "high", "parameters": { "temperature": 0, "text": { "verbosity": "low" } } } }`.
There are at most 32 names; `default` is reserved. Parameters are provider-native JSON generation options (32 fields,
8,000 serialized characters), merged after adapter defaults and before request hooks. They cannot replace the model,
conversation, tools, transport or credentials. Native Responses, Chat Completions and Anthropic adapters forward them;
Claude Code models reject provider variants. Session choices persist across restarts through an additive store column.

## Reasoning effort from the command line

`--variant` names a provider variant, never an effort: `mendcode run --model chatgpt/gpt-6-luna --variant medium` fails with
`unknown variant medium` because that model has no variant called `medium`. To choose the effort, use `--effort LEVEL`
(`minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `none`; `-c effort=LEVEL` is the same). It sets the same model choice as F3 and
`/model ID LEVEL`, and must be one of the levels the model lists (`efforts` in the catalog, shown by `/model`). Without it
the model's default effort applies.

```sh
mendcode run --model chatgpt/gpt-6-luna --effort high "review this diff"
mendcode session create --model chatgpt/gpt-6-luna --effort low
mendcode session send ID "next step" --effort xhigh    # this turn only
```

`--effort` is accepted wherever `--variant` is: `mendcode [PROJECT]`, `run`, `session create`, `session send` and
`github run` (`EFFORT` in the Actions environment). A level the model does not list fails before anything starts and
names the valid ones (`unknown effort xhigh for gpt-6-luna; use low, medium, high`); a model that lists no efforts
refuses the option. A `--variant` that carries its own effort conflicts with a different `--effort`. For a Claude Code
model `--effort LEVEL` is the documented spelling; a `--variant` naming that effort keeps working.

## Reasoning levels from the catalog

A model's levels are its catalog's when the catalog names them; otherwise they stay as before (low/medium/high for a
model marked `effort` or `reasoning`). The catalog is the model's `reasoning_options`, in models.dev's shape, from an
offline `models.dev.json` in the data directory, the provider's own listing, `providers.json`, or the daemon's copy of
models.dev (`models-dev-cache.json`, fetched in the background about 5 s after start when missing or a week old, and only
when a provider or ACP agent is configured). That copy keeps only `reasoning`, `reasoning_options` and `cost`, and only
adds them to models a provider already lists: it never adds a model, and a field set in `providers.json` wins.

| `reasoning_options` | Levels in `/model`, F3 and `--effort` |
|---|---|
| `[{ "type": "effort", "values": ["low", "high", "max"] }]` | exactly those, in that order (`default`, a host choice, and names this version does not know are left out) |
| `[{ "type": "effort" }]` (no values) | the protocol's: low/high/max on DeepSeek's own API, else low/medium/high |
| `[{ "type": "toggle" }]` | `none` on DeepSeek's own API (thinking off), else nothing |
| `[]` | none: the model reasons with no control |
| absent | the previous behaviour |

`max` and `none` are real levels everywhere a level goes (`REASONING_EFFORTS` is `minimal, low, medium, high, xhigh, max,
none`; stored settings keep their meaning). A ChatGPT subscription model now offers `max` when the Codex catalog lists it
(gpt-6-luna and the gpt-6 family do). On a Chat Completions host a level the catalog lists is sent as named
(`reasoning_effort: "max"`, `"none"`, `"xhigh"`); an `xhigh` the catalog does not list is still sent as `high`. DeepSeek's
own API (`deepseek`, which OpenCode drives through its DeepSeek protocol) gets `reasoning_effort` with
`thinking: { type: "enabled" }`, and `none` sends only `thinking: { type: "disabled" }`. On the Messages wire `max` is a
48k thinking budget and `none` is off; on Gemini `max` is 32,768 tokens (Gemini 3: `high`). The default effort applies only
when the model lists it. models.dev's `null` fields (`interleaved`, `status`, `reasoning_options`) read as absent, so an
offline `models.dev.json` copied from models.dev loads as it is. Checked live on 2026-10-17: chatgpt/gpt-6-luna answered a
counting question with 220 reasoning tokens (right) at `max` and none (wrong) at `low`. ACP agents report their own
levels per model ([acp-engine.md](acp-engine.md#effort)).

## Fast mode (`/fast`)

`/fast [on|off|status]` (no argument toggles) applies to this terminal's session only: it is saved with the session's
model choice (`fast` in `session.model.set`; a session without a model of its own takes the current one) and kept when
`/model` changes the model, so other terminals and sessions are unaffected. `settings.serviceTier` (`"fast"`; absent =
standard, set in `/settings`) stays the default of sessions that never chose; with no session `/fast` writes it. While on, the
native engine adds `service_tier: "priority"` to Responses requests for the `openai` API-key provider and the ChatGPT
sign-in models. Priority processing answers faster and is billed at a higher rate, so it is off by default and the
toast says so. Other providers, including custom `openai`-typed endpoints, never receive the field. A model or
variant `parameters.service_tier` still wins. The setting is read per request, so a toggle applies to the next call.

While it is on and the session's model is one of those (the `openai` provider's or a ChatGPT sign-in model), the footer's
`model` segment ends with the lightning of the footer icon mode (`/footer icons`: `⚡` for `glyph`, the Nerd Font bolt for
`nerd`, the word `fast` for `none`, accessible or ASCII chrome).

Fast mode also reaches two engines that run their own sessions:
- **Codex:** `codex app-server` starts with `-c service_tier="fast"` (developers.openai.com/codex/speed). Codex asks for it as `priority`, with the ChatGPT sign-in.
- **Claude Code:** a process on Opus 5.5, Opus 5 or Opus 4.8 starts with its own fast mode (`--settings '{"fastMode": true}'`, docs/claude-code.md).

Both read it when the process starts, so a toggle applies from the next process. The lightning shows for them as well.

The setting does not reach pi, ACP, other Claude models or other providers. With `/fast` on, the mark reads `n/a` (`fast n/a` in muted text), and `/fast` and `/fast status` name the model and say why.

## Model roles

`MODEL_ROLES` is `main`, `plan`, `subagent`, `compaction`, `dream`, `aside`, `small`, `permissionReviewer`, `memoryExtractor`, `memoryAssistant`, `memoryConsolidator`, `title`, `summary`, `workflow`. Stored settings keep their meaning. `memoryConsolidator` has no fallback: unset, Dream consolidation is deterministic and calls no model.

| Role | Consumer |
|---|---|
| `aside` | `/btw` side questions |
| `small` | shared default for cheap auxiliary calls; today `aside` uses it when `aside` is unset |

`aside`, `title`, `summary` and `memoryExtractor` try their own setting, then `small`, then the session/main model.
`memoryAssistant` also tries `memoryExtractor`. Auxiliary roles skip Claude Code models. Titles run after the first
successful user turn, are looked at again on the third (a first title taken from a greeting gets the real topic) and
refresh every 15 turns; manual titles are preserved. Summaries are stored in session listings.
`/model` exposes every role. Advanced provider metadata, flat variants, model filters and deadlines are described in
[advanced configuration](advanced-config.md).

## Secrets

- The key is read from `providers.json` or the environment when a request is made, sent only in the provider's auth header, and never stored in an event, log, `providers.list` reply or `/status`.
- Error bodies a provider sends back are cut to 500 characters and pass through `redactSecrets`; the literal key is also removed.
- `providers.set` carries the key in the command; commands are not persisted (only their replies are cached for retries), and replies never contain it.

## Limits

- Anthropic `max_tokens` defaults to 32,000 (raised above the thinking budget); a model variant can set a lower output cap.
- Compaction uses the model's input/context window, with per-model/provider/global thresholds and absolute triggers; see [compaction](compaction.md).
- Hosted image generation, Anthropic's server tools and provider-side web search outside `openai` are not used.
- Thinking is left off for a request in the middle of a tool loop whose earlier steps have no signed reasoning from the same model (for instance after switching models mid-turn), as the Anthropic API requires.
- OpenRouter-style `providers.refresh` lists can be large; only the first 400 ids by name are kept.

## Catalog CLI and credential removal

`models [provider] --verbose` prints the daemon's available model metadata; `--refresh` updates enabled API-provider lists. `providers list` shows credential presence and environment variable names, without key tails. `providers login --provider OpenRouter --api-key-env TEAM_KEY` skips selection and stores the variable name; omitting `--api-key-env` in a terminal opens a masked API-key prompt. OpenAI offers ChatGPT browser/device OAuth and API key methods; `chatgpt` offers OAuth only. `--method` accepts the method id or its label, case-insensitively.

`providers.logout { provider }` removes only `apiKey`, preserving models, enabled state, environment references and unknown fields. Environment credentials continue to work until unset. `providers.catalog` is read-only and returns registered API adapters plus the subscription's local login status; it never calls providers or returns credential values. `control-plane providers smoke` runs no request by default; `--execute` calls ready API providers through their existing test adapter.

`models.config.get { directory }` returns active-profile roles, effective choices and preset availability. `models.default.set { directory, provider, model, authMode?, dryRun? }` (or `{ directory, preset, dryRun? }`) changes only the main role. An unavailable preset or ambiguous billing route is rejected before writing.

## Own ChatGPT OAuth (B10)

Set the daemon's `MENDCODE_OPENAI_OAUTH_CLIENT_ID` (or `OPENAI_OAUTH_CLIENT_ID`) to a configured public OAuth client id. There is no embedded app id. Login is opt-in: `providers login --provider ChatGPT --method browser` or `--method headless`. Browser login binds only `127.0.0.1:1455`, checks a random state and uses PKCE; device login displays a code and polls with a five-minute deadline. Browser opening is opt-in with `control-plane auth login chatgpt --execute --open`.

Credentials stay in `<dataDir>/chatgpt-auth.json`, mode 0600, atomically replaced. The native subscription prefers them and refreshes expiring access tokens once per concurrent group of calls. Logout clears only v2's credentials; existing read-only Codex fallback remains, without copying or writing Codex data. A corrupt v2 store fails explicitly. `MENDCODE_OPENAI_OAUTH_ISSUER` may override the issuer with HTTPS or loopback HTTP for a local test service.

`providers.auth.methods`, `.status` and `.plan` are read-only, offline reports without tokens, account ids, authorization URLs or codes. `.authorize` and `.action` (`cancel|refresh|logout`) are local-only mutations. Real account authorization requires the external OAuth service; tests inject local fakes.

## Installed SDK adapters

SDK modules may export a `create*` factory returning an AI SDK v3 provider with `languageModel(id).doStream(options)`, or `createProvider({ provider })` returning a v2 `ModelProvider`. The daemon translates conversations, files, tools, reasoning replay and usage into native events; factories receive current credentials on each request. Module loading is lazy and errors do not echo provider content. AI SDK v3 follows the [provider interface](https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v3); no SDK dependency is bundled or downloaded by this feature.

## Local well-known login

`providers login http://127.0.0.1:PORT[/path]` produces an offline plan. `--execute` additionally requires daemon environment `MENDCODE_PROVIDER_METADATA=1` and `MENDCODE_PROVIDER_METADATA_TOKEN`. The daemon requests `/.well-known/opencode` (Bearer auth on loopback), refuses redirects and unlisted public hosts and accepts `{ "auth": { "env": "TEAM_KEY", "command": ["/absolute/local/command", "arg"] } }`. The trusted command runs as argv with bounded output/time; neither command output nor the service token is printed. The returned credential is saved privately in `<dataDir>/provider-metadata-auth.json` and is used only by an explicitly configured `apiKeyEnv` reference. It never changes the process environment or imports remote configuration. Public hosts are opt-in per host: `providers login https://auth.example.com[/path]` needs https and the exact hostname in the daemon's `MENDCODE_PROVIDER_METADATA_HOSTS` (comma separated; no wildcards, IP literals or plain http). The local token is never sent to a public host (loopback only); the host is trusted to name the local command, so list only hosts you operate.

## Google Gemini native (B10.03)

`google` uses the native [GenerateContent SSE API](https://ai.google.dev/api/generate-content), with `x-goog-api-key` authentication. It is off by default, including when `GOOGLE_GENERATIVE_AI_API_KEY` is set. Enable it explicitly through `/connect google`, `/providers`, or `providers.set { provider: "google", enabled: true }`. CLI login: `providers login --provider "Google Gemini" --api-key-env GOOGLE_GENERATIVE_AI_API_KEY`. The existing private credential store and logout rules apply; no OAuth or SDK installation is needed.

Models are namespaced `google:gemini-2.5-flash`. Text, thought summaries, parallel function calls, images and inline PDFs use the native wire format. Signed response parts replay intact to the same model during tool loops; imported or restarted Gemini 3 history uses Google's [documented signature escape hatch](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures). Missing tool results become cancelled errors. Truncated or blocked calls never execute tools. Usage reports uncached input, cached input, output including thought tokens, and thought tokens separately.

Gemini 2.5 retains v1's `high` (16,000 thinking tokens) and `max` (24,576) variants; Gemini 3 defaults to `high` and has `low`/`high` variants, with `medium` for 3.1. Generation parameters may be direct fields or a `generationConfig` object; they cannot replace conversation, tools or credentials. `providers.refresh` follows the [paginated Gemini model catalog](https://ai.google.dev/api/models), filtering embeddings, image/audio-only and live models, and retaining up to 400 chat models. Its ten-second limit covers every page. A failed refresh preserves the saved catalog.

Custom native endpoints use `providerType: "google"`, a base URL ending at the API version, and a key or environment reference; they also require explicit enablement. Tests inject a loopback URL and fake HTTP; no listener, provider request or model choice is created by installing this adapter. Real-account acceptance remains unverified.

## GitHub Copilot native (B10.14)

`github-copilot` is off by default, even with `GITHUB_COPILOT_TOKEN`. Explicit device login or
token login enables it. Configure the daemon's `MENDCODE_GITHUB_COPILOT_CLIENT_ID` with a public
OAuth client that supports [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow);
v2 does not embed another application's client id. Run `/connect github-copilot`, or
`providers login --provider "GitHub Copilot" --method device`. `control-plane auth login github-copilot`
produces an offline plan; add `--execute` for login. Polling honors pending, slow-down and expiry;
cancel/interrupt stops it. The CLI and terminal only receive a temporary verification URL/code.

Own credentials stay in `<dataDir>/github-copilot-auth.json` (atomic, mode 0600). Own v2 OAuth
credentials take precedence over manually configured or environment tokens. Status and catalogs
show presence only, without token tails, codes or account identifiers. Expiring tokens refresh once
per concurrent group of calls; non-expiring tokens need no refresh. Optional
`MENDCODE_GITHUB_COPILOT_CLIENT_SECRET` supplies a refresh secret when the registered app requires one.
Logout removes v2 credentials without changing models or environment references. Environment tokens
must be unset separately. No v1 or GitHub CLI credential is imported.

Device-login completion enables the provider and refreshes `/models`. Manual token setup uses
`providers login --provider github-copilot --api-key-env GITHUB_COPILOT_TOKEN`, then `models github-copilot --refresh`.
Models use `github-copilot:<id>`; picker visibility, disabled policy, context, vision, reasoning variants
and `/v1/messages` metadata come from the catalog. Failed refresh preserves the previous catalog.
GPT 5+ (except GPT-5 mini) uses Responses; other models use Chat Completions unless the catalog selects
Messages. Native adapters retain streaming, tools, signed thinking replay and usage. Requests use
Bearer auth, user/agent initiator and vision headers; GPT output caps are omitted as in v1.

Enterprise uses explicit daemon `MENDCODE_GITHUB_COPILOT_ISSUER=https://company.ghe.com` and
`providers.set { provider: "github-copilot", baseUrl: "https://copilot-api.company.ghe.com" }` before login.
Endpoints allow HTTPS or loopback HTTP for local fakes, refuse credentials in URLs and refuse redirects.
Device flow opens no callback listener. Auth mutations remain local-only through the existing protocol;
the daemon's existing token authentication applies. No SDK, dependency, external account or network is
needed by tests. Real Copilot account/Enterprise acceptance remains unverified.

## Azure OpenAI / Microsoft Entra ID (B10.02)

Azure is opt-in and off by default, including when `AZURE_API_KEY` is set. Explicitly enable it with
`/connect azure`, `providers.set`, or `providers login`. Model ids are **deployment names**, for example
`azure:team-coder`. No starter models are invented; refresh retains the configured deployments without HTTP.

```json
{"providers":{"azure":{"enabled":true,"apiKeyEnv":"AZURE_API_KEY","azure":{"resourceName":"team-models","auth":"api-key","apiVersion":"v1"},"models":[{"id":"team-coder","images":true}]}}}
```

`baseUrl` overrides the resource-derived endpoint. Environment fallbacks are `AZURE_RESOURCE_NAME`,
`AZURE_OPENAI_ENDPOINT`, and `AZURE_API_KEY` (alias `AZURE_OPENAI_API_KEY`). Endpoints require HTTPS,
except HTTP on loopback; credentials, queries, fragments and redirects are refused.

The native adapter defaults to Responses, like v1. `azure.useCompletionUrls: true` selects Chat Completions;
`azure.useDeploymentBasedUrls: true` uses legacy `/openai/deployments/<id>/…` paths. `azure.apiVersion`
defaults to `v1`; set the deployment's required version for legacy paths. Both transports stream text,
reasoning, tool calls and usage/cache counters through v2's existing adapters. API keys use `api-key`,
Entra tokens use `Authorization: Bearer`; request headers cannot override those credentials.

Set `azure.auth: "entra"` to read `AZURE_OPENAI_AUTH_TOKEN` (or the variable named by `azure.tokenEnv`),
or exchange `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` with the fixed Cognitive Services
scope. Client-credential tokens stay in memory and refresh before expiry. `AZURE_AUTHORITY_HOST` can select
an HTTPS identity authority. Reports never fetch or show tokens/secrets. Azure CLI, certificate, workload
and managed-identity discovery are not implicit; supply an access token from those services through the token
variable. No new dependencies, callback listeners, or public endpoints are added.

```sh
mendcode providers login --provider azure --azure-resource team-models --deployments team-coder --api-key-env AZURE_API_KEY
mendcode providers login --provider azure --azure-resource team-models --deployments team-coder --entra-token-env AZURE_OPENAI_AUTH_TOKEN
```

Additional flags: `--api-version`, `--use-completion-urls`, `--use-deployment-based-urls`, `--base-url`.
`control-plane providers smoke --provider azure --execute` tests only an enabled provider with credentials.
The typed client offers `configureAzure`; it preserves the disabled default until `enabled: true` is supplied.

Contract references: [Azure provider](https://ai-sdk.dev/providers/ai-sdk-providers/azure),
[Entra client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).
Tests use injected HTTP fakes and temporary data directories. Real Azure deployment/RBAC and Entra tenant
validation require an account and endpoint and remain unverified.

## Amazon Bedrock / AWS (B10.01)

`amazon-bedrock` uses native [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html): binary event-stream framing with CRC checks, text, parallel tool calls/results, images/PDFs, signed reasoning replay and input/output/cache usage. It stays off even when AWS credentials are present. Enable explicitly through `/connect bedrock`, `configureBedrock`, or `providers.set { provider: "amazon-bedrock", enabled: true }`. Disabled test/refresh makes no request. No SDK dependency or anonymous fallback.

The daemon reads `AWS_BEARER_TOKEN_BEDROCK` first, then the configured bearer (`apiKey`/`apiKeyEnv`), before the AWS chain. It never changes process environment. Without a bearer it signs with [SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html), including session credentials. `bedrock.region` overrides `AWS_REGION`, then `us-east-1`; `bedrock.profile` overrides `AWS_PROFILE`. An explicit profile takes precedence over environment keys. The chain supports environment keys, shared config/credentials, source-profile/credential-source roles, STS web identity and existing SSO sessions. Temporary credentials refresh in memory; AWS files are read-only. Reports expose candidate presence, not proof of IAM/model access, and never resolve remote roles or run processes.

`bedrock.allowCredentialProcess` and `bedrock.allowMetadata` are off by default. Opt in separately to bounded argv-only `credential_process` execution or container/IMDSv2 role requests. Container HTTP is limited to loopback and AWS metadata hosts; redirects are refused. Initial SSO login and interactive MFA require external AWS login. Existing SSO token refresh stays in memory. Login/logout stores or removes only a v2 bearer (0600); environment keys, profiles and AWS files remain owned by AWS tooling.

Public `bedrock` options are `region`, `profile`, `auth: chain|bearer`, `endpoint`, `allowCredentialProcess`, `allowMetadata`. Null region/profile restores environment/default lookup; null endpoint restores regional routing. HTTPS and loopback HTTP overrides are accepted without URL credentials/query/fragment. Legacy `options.region/profile/endpoint/baseURL` and `npm: "@ai-sdk/amazon-bedrock"` resolve to the native adapter. Legacy endpoint wins over baseURL. v1 cross-region model prefixes are retained; explicit inference-profile prefixes and ARNs stay exact. Model ids longer than the catalog limit use a short alias with `models[].options.bedrockModelId` holding the ARN. Refresh lists streaming text foundation models, keeps configured metadata and ARN aliases, and preserves the previous catalog on failure.

For example: `mendcode --dir /tmp/mendcode-bedrock-demo providers login --provider amazon-bedrock --method aws-chain --aws-region us-east-1 --aws-profile team --models amazon.nova-lite-v1:0 --json`. Bearer login uses `--method api-key --api-key-env TEAM_BEDROCK_TOKEN`, or the masked terminal prompt. `--aws-metadata` and `--aws-credential-process` are explicit opt-ins. Tests use temporary files and injected local responses; real AWS account, region availability and IAM/model entitlement are not verified.

## Google Vertex AI / GCP ADC (B10.04)

`google-vertex` is a native Gemini adapter using Vertex's [streamGenerateContent](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/projects.locations.publishers.models/streamGenerateContent). It supports text/thought streaming, function calls/results, signed reasoning replay, images/PDFs, usage/cache counters and model pricing. Models are namespaced, for example `google-vertex:gemini-2.5-flash`. The preset stays off even with a project and credentials present. Explicit login/enablement is required; no SDK dependency or anonymous fallback.

`vertex.project` overrides `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, then `GCLOUD_PROJECT`. `vertex.location` overrides `GOOGLE_VERTEX_LOCATION`, `GOOGLE_CLOUD_LOCATION`, then `VERTEX_LOCATION`, falling back to `us-central1`. Regional routing uses `<location>-aiplatform.googleapis.com`; `global` uses `aiplatform.googleapis.com`. Legacy `options.project/location` and `npm: "@ai-sdk/google-vertex"` resolve natively. Public options also include `tokenEnv`, `quotaProject`, `endpoint` and `allowMetadata`. Null project/location restores environment/default lookup; null endpoint restores regional routing. Endpoint overrides require HTTPS or loopback HTTP without credentials, query or fragment; credential-bearing requests refuse redirects.

The daemon first reads `vertex.tokenEnv` (default `GOOGLE_OAUTH_ACCESS_TOKEN`), then [Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials): `GOOGLE_APPLICATION_CREDENTIALS`, or `application_default_credentials.json` under `CLOUDSDK_CONFIG`/the gcloud default directory. It supports authorized-user refresh, RS256 service accounts, local-file workload federation and service-account impersonation. Tokens refresh in memory with bounded requests; credential files remain unchanged. Explicit missing/corrupt files fail closed. Google metadata credentials require `vertex.allowMetadata: true` (CLI `--google-metadata`) and use the fixed Google metadata address. No gcloud subprocess or interactive login is launched. Federation URL, executable and AWS sources are disabled; these broader GoogleAuth modes remain a parity gap. Interactive gcloud login and live GCP IAM/model access require external setup.

`vertex.quotaProject`, `GOOGLE_CLOUD_QUOTA_PROJECT`, or ADC's `quota_project_id` supply `x-goog-user-project`. Reports only expose routing/presence and never tokens, key tails or credential contents. Offline auth plans/catalog refresh do not acquire credentials or contact GCP. Refresh retains configured or offline publisher model ids; it does not use Gemini's public `/models` endpoint. Logout cannot delete external Google credentials.

```json
{ "providers": { "google-vertex": {
  "enabled": false,
  "vertex": { "project": "team-project", "location": "global", "allowMetadata": false },
  "models": [{ "id": "gemini-2.5-flash", "images": true, "effort": true }]
} } }
```

CLI: `mendcode --dir /tmp/mendcode-vertex-demo providers login --provider google-vertex --method adc --gcp-project team-project --vertex-location global --google-token-env TEAM_TOKEN --models gemini-2.5-flash --json`. This stores public settings and explicitly enables; it never prompts for or stores a token. Optional `--vertex-quota-project` sets billing/quota routing. `control-plane providers smoke --provider google-vertex` is a plan; `--execute` makes the test request. The typed client exposes `configureVertex`. Tests use only temporary files and injected responses; real GCP has not been exercised.

## Vertex Anthropic (B10.05)

`google-vertex-anthropic` speaks Claude [Messages SSE through Vertex streamRawPredict](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude), using `anthropic_version: vertex-2023-10-16` in the body and a publisher model in the URL. It supports text/thinking, tools/results, signed thinking replay, images/PDFs, cache counters and configured pricing, through the existing Anthropic adapter. Model ids retain their version suffix, e.g. `google-vertex-anthropic:claude-haiku-4-5@20251001`; configure publisher ids for the account's enabled models. Refresh retains the configured/offline catalog without network or credential resolution.

It stays disabled until explicitly enabled, even with credentials/project present. Public `vertex` options and [ADC authentication](#google-vertex-ai--gcp-adc-b1004) are shared with Vertex Gemini. Project precedence is config, `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `GCLOUD_PROJECT`. Claude location follows v1: config, `GOOGLE_CLOUD_LOCATION`, `VERTEX_LOCATION`, then `global` (Gemini's `GOOGLE_VERTEX_LOCATION` alias does not apply). Regional endpoints and explicit HTTPS/loopback overrides work; null endpoint restores regional routing. Legacy `npm: "@ai-sdk/google-vertex/anthropic"` and `options.project/location` resolve natively, without loading an SDK.

Bearer tokens remain daemon-owned, are read/refreshed on each request, never reported, and cannot be overridden by request headers. Metadata is opt-in/off by default; external credential files are read-only. No callback listener, gcloud subprocess, dependency or anonymous fallback is added. URL/executable/AWS federation sources remain disabled by the shared conservative ADC policy; supply an externally acquired access token via `vertex.tokenEnv` for those cases. Real-account IAM, Model Garden entitlement and region/model availability require external verification.

CLI: `mendcode --dir /tmp/mendcode-vertex-claude-demo providers login --provider google-vertex-anthropic --method adc --gcp-project team-project --vertex-location global --google-token-env TEAM_TOKEN --models claude-haiku-4-5@20251001 --json`. Reuses `--vertex-quota-project`, `--google-metadata` and explicit `smoke --execute`. The typed client offers `configureVertexAnthropic`, including custom provider namespaces, and preserves disabled state unless `enabled: true` is supplied. Tests use temporary directories and injected local HTTP responses only.

## xAI Responses (B10.06)

`xai` uses the native [xAI Responses API](https://docs.x.ai/developers/model-capabilities/text/generate-text) at `https://api.x.ai/v1`, matching v1's Responses routing. It stays **off by default**, even with `XAI_API_KEY` present. Enable explicitly with `/connect xai`, `/providers`, or `providers login --provider xAI --api-key-env XAI_API_KEY`. Login stores the key reference and enables; `/connect` also runs a small paid test only after submission. `providers.test` and `providers.refresh` refuse disabled xAI providers without HTTP.

Text/reasoning streams, local function calls and results, images on capable models, encrypted reasoning replay within the same provider/model, and input/output/reasoning/cache usage use the shared Responses transport. Conversations remain stateless (`store: false`); OpenAI routing/cache-key and reasoning-summary fields are omitted. Grok 3 Mini exposes only v1's `low`/`high` efforts and named variants. Other Grok models retain their own reasoning defaults. Native generation fields and v1 aliases `reasoningEffort`, `topLogprobs`, `previousResponseId`, `include` are supported through provider/model options or variant parameters. Hosted xAI search, media generation and remote MCP are not enabled by this chat adapter.

`providers.refresh` lists up to 400 chat model ids from `/models`, keeps configured metadata/options/variants, and preserves the saved catalog on failure. Starting model ids are replaceable through `models`; they do not imply current account entitlement. Custom namespaces use `providerType: "xai"`, HTTPS or loopback HTTP, no URL credentials/query/fragment, and an API key or environment reference. Calls reject redirects. Legacy `npm: "@ai-sdk/xai"` resolves to this adapter without loading/installing an SDK and still requires explicit enablement.

The typed client offers `configureXai`, preserving disabled state unless `enabled: true` is supplied. Auth methods/status/plan use the existing daemon API-key flow; credentials stay in the private store and logout clears only the stored key. No listener or auth bypass is added. Tests use temp directories and injected HTTP responses; frames use the app harness. Real xAI credentials, entitlement and endpoint acceptance remain unverified.

## Mistral (B10.07)

`mistral` uses native Chat Completions at `https://api.mistral.ai/v1`, with `MISTRAL_API_KEY` or a configured key/environment reference. It stays **off by default**, even with a key. `/connect Mistral` explicitly enables and runs the existing small, potentially paid test; CLI `providers login --provider Mistral --api-key-env MISTRAL_API_KEY` enables without testing. Disabled test/refresh calls make no HTTP request. Custom namespaces use `providerType: "mistral"`, mandatory Bearer auth and HTTPS or loopback HTTP without URL credentials/query/fragment. Redirects are rejected.

Text/thinking SSE, parallel local tools/results, stable nine-character call ids, tool/user alternation, assistant prefix continuation, images and inline PDF document parts match v1's chat adapter. Usage, cancellation, retry/stream guards, limits and configured pricing use shared v2 infrastructure. Provider/model/variant parameters support `safePrompt`, `documentImageLimit`, `documentPageLimit`, `parallelToolCalls`, `reasoningEffort` (`high | none`), `seed`, `structuredOutputs`, `strictJsonSchema` and `responseFormat: { type: "json", schema?, name?, description? }`; native generation fields also work. Only v1's four supported reasoning families expose `high` variants: `mistral-small-2603`, `mistral-small-latest`, `mistral-medium-3.5`, `mistral-medium-2604`.

Refresh uses Mistral capabilities/context, excludes OCR/embeddings, keeps configured overrides and retains the saved catalog on failure. Starter aliases do not establish account entitlement. Legacy `npm: "@ai-sdk/mistral"` and SDK options resolve natively without loading/installing an SDK. The typed client offers `configureMistral`; existing private API-key auth/status/plan/logout is reused. No listener, dependency, Files upload service or OCR API is added: PDFs are inline, as in v1's SDK. Tests use temporary stores and injected responses. Real credentials, entitlement and live endpoint acceptance remain external/unverified.
## DeepInfra (B10.08)

`deepinfra` uses [DeepInfra's OpenAI-compatible format](https://docs.deepinfra.com/chat/overview) through
its public endpoint (`https://api.deepinfra.com/v1/openai`), authenticated with a Bearer token from `DEEPINFRA_API_KEY`
or the existing private provider store. It is off by default, even when the environment key exists.
Enable explicitly through `/connect DeepInfra`, `/providers`, `providers.set`, or
`providers login --provider DeepInfra --api-key-env DEEPINFRA_API_KEY` (add `--base-url` only for a proxy of your own).
Disabled test/refresh calls make no HTTP request, including legacy SDK namespaces.

Models use `deepinfra:<model>` (including model version/deployment colons). Configured and offline
metadata take precedence over the starter list; `providers.refresh` explicitly requests `/models`,
preserves configured capabilities/options/variants, and leaves the saved list intact on failure.
Reasoning variants follow v1's model-family rules, plus max for DeepSeek V4; configured variants
extend defaults and can disable individual entries. Text, reasoning,
fragmented parallel tools, tool-result replay, images and token/cache usage use the existing native
transport. `usage.estimated_cost` is recorded in USD micro-units, including explicit zero cost.

Existing `npm: "@ai-sdk/deepinfra"` settings resolve natively without installing/importing the SDK.
SDK `options.baseURL` gains `/openai`; v2 `baseUrl` is already the wire root. SDK `options.apiKey`
stays private and can be cleared by logout; generation options never carry it. SDK camel-case
reasoning/min-p/top-k/repetition/parallel/format options translate to native fields.
Endpoints follow the [outbound policy](#outbound-endpoint-policy-and-provider-defaults); redirects are refused.
Configured/per-call headers cannot override the token; headers and tokens are scrubbed from errors.
Model output limits cap generation options and auxiliary requests; streaming usage stays enabled.
No listener or network call starts from adding the preset. Daemon auth boundaries remain unchanged.
`client.configureDeepInfra` uses the existing additive `providers.set` protocol.
Tests use temporary directories and injected HTTP fakes; a real account, entitlement and
live streaming/tool/usage acceptance remain external and unverified.
## Perplexity Sonar compatibility (B10.12)

`perplexity` supplies v1's Sonar model ids through native Chat Completions, without an SDK dependency.
It is off by default, even with `PERPLEXITY_API_KEY` or a saved `@ai-sdk/perplexity` configuration.
Enable it explicitly with `providers login --provider Perplexity --api-key-env PERPLEXITY_API_KEY` (default
`https://api.perplexity.ai`; add `--base-url` for a proxy). `/connect perplexity` accepts an optional endpoint and a masked key;
Enter saves and tests it. Credentials, logout, model selection and refresh use the existing daemon protocol.
No listener or provider request starts automatically. Redirects, URL credentials and plain-HTTP public hosts are refused.

Text and reasoning deltas stream normally. Cumulative `citations` (or `search_results` when absent) become
numbered URL references in the answer, persisted and replayed through ordinary transcript events.
Usage includes input/output, reasoning, cached input and the provider's reported USD cost; prices are not guessed.
Sonar has built-in search but no client function tools: tool schemas are omitted, imported tool history becomes
text, and unexpected returned function calls are rejected. Model metadata advertises no tools or image input.
Proxy model refresh is explicit and failed refresh preserves the previous catalog.

[Perplexity retired public Sonar Chat Completions on September 27, 2026](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
The preset keeps v1's public endpoint; whether the service still answers Sonar Chat Completions there is unverified.
Migration to the new Agent API, different model ids and real-account acceptance remain open; Sonar ids are not
silently remapped. All B10.12 tests use injected local responses and temporary data.

## Alibaba Model Studio (B10.13)

`alibaba` uses native [OpenAI-compatible Chat Completions](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions),
without installing `@ai-sdk/alibaba`. The preset is off by default, even with `DASHSCOPE_API_KEY` or a saved
Alibaba SDK entry. Explicitly connect it:
`providers login --provider Alibaba --api-key-env DASHSCOPE_API_KEY` (default the international DashScope endpoint; use `--base-url`
for the mainland or a US region, or a proxy). The variable holds the Bearer key. Plain-HTTP public hosts, URL credentials, query strings,
fragments and redirects are refused for generation, connection tests and catalog refresh. No listener or request starts automatically.

Starter models are `alibaba:qwen-plus` and `alibaba:qwen3-coder-plus`; replace them with your proxy's catalog via
`providers.refresh` or an explicit model list. v1's Qwen sampling defaults are temperature 0.55 and top-p 1.
Text and reasoning deltas, streamed parallel function calls and tool-result replay use the existing native transport.
Usage includes uncached input, cached input, output and reasoning tokens. Streaming always requests usage.
Generation options accept `enable_thinking` / `thinking_budget`, plus v1 SDK aliases `enableThinking` / `thinkingBudget`;
native field names win. OpenAI reasoning-effort levels are omitted. Model limits and prices are never guessed.

Authentication reports, token rotation, credential removal, model selection and live disablement use the existing
daemon protocol and typed client. Credentials stay in the private atomic mode-0600 store; reports never contain tokens.
The default is the international (Singapore) compatible API origin; other regions need a `baseUrl`.
Real-service acceptance remains an external prerequisite. Tests use temporary
data and injected HTTP responses, with no provider, network or dependency installation.

## OpenCode Zen (B10.15)

`opencode` is opt-in and off by default, including environment-only keys and saved v1 SDK configurations.
Connect it with
`providers login --provider "OpenCode Zen" --api-key-env OPENCODE_API_KEY` (default `https://opencode.ai/zen/v1`).
The variable holds your Zen API key, not an implicit console credential. API-key methods, offline login plans,
status, credential removal and model selection reuse the daemon protocol and typed client. Stored keys use the
private atomic mode-0600 provider store. No listener, browser login, public request or anonymous `public` fallback
starts automatically. The preset is v1's public endpoint.
URL credentials, query strings, fragments and redirects are refused.

There is no guessed starter catalog. Refresh `/models` or set models explicitly; offline `models.dev.json` is also
supported. Per-model `provider.npm` selects native Responses (`@ai-sdk/openai`), Messages (`@ai-sdk/anthropic`),
Gemini (`@ai-sdk/google`) or Chat Completions (`@ai-sdk/openai-compatible`). Without this metadata, Claude, Gemini
and GPT/o-series names select their native format; other names use Chat Completions. Unknown SDK formats fail
explicitly without installing dependencies. Requests stay at the configured endpoint, even when model metadata names
another API URL. Model headers cannot override the current token: Responses/Chat use Bearer, Messages uses
`x-api-key`, Gemini uses `x-goog-api-key`; catalog refresh uses Bearer.

Text, reasoning, function calls and tool-result replay use the existing native adapters. Usage preserves uncached
input, cache reads/writes, output and reasoning; model prices and output limits apply when supplied. Refresh retains
explicit per-model formats and budgets when a proxy returns only IDs. Failed refreshes leave the catalog unchanged.
Real Zen console signup/key issuance and upstream account acceptance remain external prerequisites, not a new OAuth
flow. B10.15 tests use injected local responses and temporary data only; no network or real account is exercised.

**Free models.** Zen's free models (`big-pickle`, `*-free`, or a zero price in the catalog) are not offered here, with or
without a key, on purpose (re-checked 2026-10-18 with a real Zen key: still `FreeTierError`). OpenCode
itself sends the key `public` when it has none, but the service serves the free tier only to OpenCode's own client:
checked live on 2026-10-17, a chat request from anything else, to `zen/v1` or to `inference/openai/v1`, with
`Bearer public` or with no key at all, gets 403 `FreeTierError` (`/models` still lists them, so a listing proves nothing).
MendCode does not present itself as OpenCode to get around that. When a native request meets that refusal, the error
says so (and how to run them) instead of reporting a rejected key. To use the free models, run OpenCode itself as the
ACP agent `opencode` ([connect.md](connect.md#opencode-free)); its effort levels (DeepSeek's `max` included) are
selectable there.

## LLMGateway (B10.16)

`llmgateway` uses native [OpenAI-compatible Chat Completions](https://docs.llmgateway.io/quick-start), with v1's
`HTTP-Referer: https://mendcode.ai/`, `X-Title: opencode` and `X-Source: opencode` attribution defaults.
It stays off by default, including environment-only keys and saved SDK configurations. Connect it explicitly:
`providers login --provider LLMGateway --api-key-env LLMGATEWAY_API_KEY` (default `https://api.llmgateway.io/v1`).
The variable holds the Bearer key. Generation, connection tests and refresh refuse plain-HTTP public hosts, URL credentials,
query strings, fragments and redirects.
Model/header hooks cannot replace the current token. No listener, browser, request or dependency installation starts
automatically. Credentials, offline auth plans, logout and model selection reuse the existing daemon protocol/client.

No starter models or prices are guessed. Load the authenticated [`/models` catalog](https://docs.llmgateway.io/v1_models)
or set models explicitly; offline `models.dev.json` metadata remains supported. Refresh preserves names, context,
vision, reasoning, tools and output caps supplied by the gateway. Failed or empty refreshes preserve the saved catalog.
Text/reasoning streaming, parallel function calls and tool-result replay use the shared native transport.
Usage includes uncached input, output, reasoning, cache reads/writes and the reported USD cost, including zero-cost
responses ([gateway usage fields](https://docs.llmgateway.io/features/cost-breakdown)). Streaming always requests usage.
Own keys use the atomic mode-0600 provider store; reports and errors never expose them. Real account/key issuance and
upstream service acceptance remain external prerequisites. B10.16 tests use temporary data and injected responses.

## NVIDIA (B10.17)

`nvidia` uses native [NIM Chat Completions](https://docs.nvidia.com/nim/large-language-models/latest/reference/api-reference.html),
with v1's `HTTP-Referer: https://mendcode.ai/` and `X-Title: opencode` defaults. It is opt-in and off by default,
including environment keys and saved SDK entries. Connect it explicitly:
`providers login --provider NVIDIA --api-key-env NVIDIA_API_KEY` (default `https://integrate.api.nvidia.com/v1`).
The variable holds the Bearer key. Plain-HTTP public hosts, URL credentials, query strings, fragments and redirects
are refused for streaming, tests and refresh. Header hooks cannot replace the current token; no SDK or dependency
is loaded. No listener or provider request starts automatically. The preset endpoint is NVIDIA's hosted API.

Load `/models` or set models explicitly; no starter models, limits or prices are guessed. Offline `models.dev.json`
remains supported. Refresh keeps supplied names, context, vision, tools, reasoning and output caps; a minimal refresh
retains saved capabilities, and a failed/empty refresh preserves the catalog. Text/reasoning deltas, parallel function
calls, tool-result replay and input/output/reasoning/cache usage reuse the shared native transport. Streaming always
requests usage, and configured limits/prices apply. API-key methods, offline login plans, status, logout, catalog and
model selection use existing protocol commands and typed client helpers. Stored keys use the private atomic mode-0600
provider store and stay out of reports/errors. Real NVIDIA account/key issuance and upstream service
acceptance remain external prerequisites. B10.17 tests use temporary data and injected local responses only.

## SAP AI Core (B10.18)

`sap-ai-core` is opt-in and off by default. `AICORE_SERVICE_KEY` holds SAP's JSON service key
(`clientid`, `clientsecret`, `url`, `serviceurls.AI_API_URL`); a masked `/connect` form can store it instead,
atomically with mode 0600. The key never enters a Bearer header, report or process environment.
OAuth client credentials are exchanged at `<url>/oauth/token`; access tokens stay in memory until expiry,
service-key rotation or rejection. OAuth and API URLs from the service key must be HTTPS (or loopback HTTP for fakes); credentials in URLs, query strings,
fragments and redirects are refused. No SDK, dependency, listener or account request starts automatically.

`providers.set` adds optional `sapAi: { deploymentId?, resourceGroup? }`. These override
`AICORE_DEPLOYMENT_ID` and `AICORE_RESOURCE_GROUP`; the resource group defaults to `default`.
Without a deployment id, generation selects the latest running orchestration deployment returned locally.
`baseUrl` is an optional API root including `/v2`; without it the root is the service key's API URL plus `/v2` (no invented default).
The native adapter uses [SAP Orchestration](https://sap.github.io/ai-sdk/docs/js/orchestration/chat-completion)
with text/reasoning streaming, parallel tool calls, tool-result replay and token/cache usage. Existing model
limits/prices apply. Header hooks cannot replace OAuth authentication or the resource group.

Refresh uses [SAP's tenant model discovery](https://help.sap.com/docs/sap-ai-core/generative-ai/supported-models),
keeps orchestration chat models and preserves saved capabilities. Empty/failed refreshes leave the catalog intact.
Offline auth methods/plans/status, logout and model choice use existing daemon commands and typed client inputs.
Real service-key issuance and upstream account acceptance remain external prerequisites; HTTPS service URLs are accepted.
B10.18 tests use temp dirs and injected fakes.

## Zenmux (B10.19)

`zenmux` uses native [OpenAI-compatible Chat Completions](https://zenmux.ai/docs/api/openai/create-chat-completion.html),
without loading an SDK. It is off by default, including with `ZENMUX_API_KEY` or a saved compatible SDK entry.
Connect it explicitly:
`providers login --provider Zenmux --api-key-env ZENMUX_API_KEY` (default `https://zenmux.ai/api/v1`).
The variable holds the Bearer key. `/connect zenmux` accepts an optional endpoint and a masked key; Enter saves,
refreshes the catalog, then tests. Failed refresh preserves the saved connection/catalog and skips the test;
`r` retries catalog discovery and, when recovered, tests the saved connection.
Plain-HTTP public hosts, URL credentials, query strings, fragments and redirects are refused. No listener or request starts
on installation, catalog/auth inspection or credential save alone. The preset is the
[documented API origin](https://zenmux.ai/docs/guide/quickstart).

Requests retain v1's `HTTP-Referer: https://mendcode.ai/` and `X-Title: opencode` attribution. The current Bearer token
wins over configured/model/plugin auth headers. Text, reasoning and parallel fragmented function calls stream;
tool results replay in call order. Signed `reasoning_details` replay only to the same provider/model within a tool
loop and never become transcript events. A new user turn discards them. Streams always request usage: uncached
input, output, reasoning and cache reads/writes; reported USD cost is retained when supplied, including zero.

Models are namespaced `zenmux:<provider>/<model>`. There are no guessed starter models or prices.
[Catalog refresh](https://zenmux.ai/docs/api/openai/openai-list-models.html) retains names, context, reasoning and
image capabilities, filtering non-text outputs. A proxy may also advertise `supported_parameters` and `max_output`
for tool capability and output caps. Explicit configured metadata supplies missing capabilities/prices.
The existing private atomic mode-0600 credential store, environment references, logout, model selection and
live disablement apply through the daemon and typed client. Real-account/proxy acceptance remains external;
all B10.19 tests use temporary directories and injected local responses, without network or new dependencies.

## GitLab (B10.20)

GitLab is opt-in and disabled by default, even with `GITLAB_TOKEN` or a legacy `gitlab-ai-provider` entry.
Connect it with `/connect gitlab`, or use the typed client's
`configureGitLab({ baseUrl, apiKeyEnv: "GITLAB_TOKEN", enabled: true, gitlab })`. The instance URL (`baseUrl` or
`GITLAB_INSTANCE_URL`: gitlab.com or your self-managed host, required, no default) and the optional `GITLAB_AI_GATEWAY_URL`
must be HTTPS (or loopback HTTP) without credentials, query or fragment. No SDK is loaded and no dependency is installed.

The native adapter exchanges the PAT/OAuth access token at `/api/v4/ai/third_party_agents/direct_access`,
caches direct credentials for 25 minutes, invalidates them on token rotation and retries once after 401.
Only direct Bearer credentials reach generation; PATs, cookies and API-key overrides cannot leak through
gateway headers. `duo-chat-*` IDs map to native Anthropic Messages, OpenAI Chat Completions or Responses
routes under `/ai/v1/proxy`, preserving streamed text, reasoning, tools and usage through existing adapters.
Credentials use the existing private mode-0600 store or environment reference, and logout retains settings.

`gitlab` options: `authType: "api" | "oauth"` (PAT by default), `aiGatewayUrl`, `rootNamespaceId`
(`gid://gitlab/Group/123`), optional numeric-string `projectId`, and bounded boolean `featureFlags`.
No namespace uses the static agentic/workflow catalog offline; an explicit namespace enables GraphQL discovery.
Pinned models take precedence; configured metadata wins on refresh. `duo-workflow-*` models are selectable,
retain `workflowRef`, and use the native Duo Workflow Service transport rather than agentic chat.

Workflow setup warms `/api/v4/ai/duo_workflows/direct_access`, creates `/duo_workflows/workflows`, then
connects to `/duo_workflows/ws` with the PAT/OAuth token in upgrade headers (never the URL). Returned
service URLs/tokens must satisfy the outbound policy. Checkpoints stream incremental text/reasoning;
completed conversations reuse their workflow ID in the daemon for up to 30 minutes. A daemon restart creates
a fresh workflow with the retained conversation. DWS does not expose measured usage: v2 leaves it unknown,
while Duo Chat continues to report provider usage. No character-to-token estimate is recorded as usage.

MCP and local built-in read/write/edit/search/shell actions enter the normal v2 tool/permission loop. Tool
results return as `actionResponse`, including errors; bulk reads combine their results. Only advertised tools
are accepted. DWS transport preapproval removes the duplicate server prompt; it never grants local permission.
Only the MCP privilege is requested; remote GitLab API actions are refused, and no filesystem fallback bypasses
permissions. Cancellation, user denial and turn completion release pending sockets. Failed/disconnected
workflows are not automatically reconnected. Messages/queues, checkpoint history and active runs are bounded.

Conservative decisions: explicit namespace/project IDs instead of repository auto-detection, supplied PAT or
OAuth access token instead of browser OAuth/refresh, no server plan/input approval automation, and no remote
GitLab API execution. These additional routes remain unavailable. Live GitLab/proxy acceptance requires a real
account/service and is not claimed by the injected no-network tests. The DWS wire reference is the
[GitLab provider's transport](https://gitlab.com/vglafirov/gitlab-ai-provider/-/blob/main/src/gitlab-workflow-client.ts).

## Cerebras (B10.09)

`cerebras` uses [Cerebras Chat Completions](https://inference-docs.cerebras.ai/api-reference/chat-completions)
at `https://api.cerebras.ai/v1`. It stays off by default, even with `CEREBRAS_API_KEY` present.
A `baseUrl` override must satisfy the outbound policy (no credentials, query or fragment). Redirects are refused. API keys/environment references, private storage, status,
login plans and logout use the existing daemon protocol; no OAuth listener or new dependency is added.

Enable with `/connect Cerebras`, `/providers` or
`providers login --provider Cerebras --api-key-env CEREBRAS_API_KEY`.
CLI login does not run inference; `/connect` explicitly saves/enables and tests on Enter.
The client exposes `configureCerebras`; omitted `enabled` keeps the provider's current/default state.
Disabled test/refresh calls make no HTTP request. Model ids use `cerebras:<model>`.

The native adapter handles text/reasoning SSE, fragmented parallel tools/results and final-chunk
input/output/reasoning/cache usage. It preserves v1's `X-Cerebras-3rd-Party-Integration: opencode`
header unless configured otherwise, and always uses the current Bearer key for inference/discovery.
SDK aliases (`reasoningEffort`, `parallelToolCalls`, `topLogprobs`, `logitBias`, `serviceTier`,
`reasoningFormat`, `promptCacheKey`, `responseFormat`) translate to native fields; native fields win.
Output limits become one bounded `max_completion_tokens`; `stream_options` is omitted.
Per-model capabilities, options, limits and configured pricing follow v2's existing transport.

Legacy `npm: "@ai-sdk/cerebras"` namespaces resolve natively without loading/installing the SDK;
`options.baseURL` and `options.apiKey` are recognized and the key never enters generation parameters.
Logout/key clearing also removes a legacy options key while retaining public configuration.
Refresh loads at most 400 sorted models, retains configured/starter metadata and variants, and
preserves saved bytes on failure. Reasoning variants follow v1's model-family rules, including its
broader GPT effort list; actual supported efforts depend on the model. The starter is v1's
`gpt-oss-120b` metadata, not an entitlement claim; replace it with configured/offline/refreshed models.

Tests inject local HTTP fakes and use temporary stores. Real Cerebras credentials, account access
and live model/effort acceptance remain external/unverified.

## Cohere (B10.10)

Cohere uses native Chat v2, matching v1's bundled `@ai-sdk/cohere` provider without installing/importing its SDK.
It stays off until explicitly enabled, even with `COHERE_API_KEY`. The default root is `https://api.cohere.com/v2`; an override must include `/v2` and satisfy the outbound policy
(URL credentials, query strings, fragments, plain-HTTP public hosts and redirects are refused).
`/connect Cohere` explicitly saves/enables and tests. CLI login saves without a provider request:

```sh
mendcode providers login --provider Cohere --api-key-env COHERE_API_KEY
```

The token travels only in the Bearer header. Existing `providers.set/list/test/refresh/logout/remove`, auth methods,
`providers.catalog` and `client.configureCohere` apply. Stored credentials use the private atomic provider file;
logout removes stored keys and preserves environment references/models. Legacy `npm: "@ai-sdk/cohere"`,
`options.baseURL` and `options.apiKey` resolve to native wire, require explicit enablement and never load the SDK.
Custom namespaces may specify `providerType: "cohere"` with the same restrictions.

Streaming supports text, thinking, tool plans, fragmented parallel function calls and tool-result replay.
Incomplete/error/oversized streams fail before tool execution; cancellation is quiet, idle/request deadlines and
429/5xx retries reuse the engine's existing policy. Usage prefers complete `usage.tokens` to billed units,
falling back to billed units only when totals are absent. Cache/reasoning breakdowns are unavailable and remain zero.
Standard generation options map to native fields (`topP`/`top_p` → `p`, `topK`/`top_k` → `k`,
`maxOutputTokens` → `max_tokens`, `stopSequences` → `stop_sequences`); native fields win aliases. Output caps cannot
exceed the model's configured limit. v1 supplied no Cohere variants, so none are invented; named custom variants work.
Images require explicit model metadata; text-only starters omit images with the existing omission note.

The starting catalog contains Command A and Command R+. Replace it with `models` or explicitly refresh.
Refresh queries `/v1/models?endpoint=chat`, filters deprecated/non-chat entries, deduplicates and bounds
pagination to 10 pages/400 models under one 10-second deadline. Starter/configured limits and options survive refresh;
failures preserve the saved file. [Chat wire](https://docs.cohere.com/v2/reference/chat-stream),
[model listing](https://docs.cohere.com/v1/reference/list-models),
[Command A](https://docs.cohere.com/docs/command-a), [Command R+](https://docs.cohere.com/docs/command-r-plus).

Decisions: opt-in/off by default, Bearer key required, HTTPS endpoint by default, no dependencies and local fakes in tests.
EXT acceptance remains pending for a real Cohere account and live streaming/tools/usage; no public service was called.

## Cloudflare Workers AI (B10.21)

`cloudflare-workers-ai` is an opt-in, token-authenticated provider using the existing
[Chat Completions compatibility endpoint](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).
The endpoint is built over HTTPS from your account id (or a full `baseUrl`); plain-HTTP public hosts,
credentials/query/fragment in URLs, redirects and anonymous requests are refused. An environment key
alone never enables it, and configuring a credential makes no request. Explicit enablement is required.

`CLOUDFLARE_API_KEY` supplies the Bearer token; `apiKeyEnv` selects another variable, or the private
mode-0600 provider store holds a submitted token. Tokens and their tails never appear in reports.
`CLOUDFLARE_ACCOUNT_ID` takes precedence over `cloudflareWorkersAi.accountId` (or legacy
`options.accountId`). A full endpoint needs no account id; without one the account id is required (no invented default).
`accountId: null` clears stored routing metadata. The account id builds `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`.

```json
{
  "providers": {
    "cloudflare-workers-ai": {
      "baseUrl": "http://127.0.0.1:1234/client/v4/accounts/local-account/ai/v1",
      "apiKeyEnv": "CLOUDFLARE_API_KEY",
      "cloudflareWorkersAi": { "accountId": "local-account" },
      "enabled": false
    }
  }
}
```

The initial catalog includes [Llama 3.3 70B](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/);
configured models and local models.dev metadata follow the existing precedence. As in v1, refresh retains
the configured/offline Workers AI catalog; it does not assume an OpenAI `/models` service. Per-model tools,
images and output caps use the shared factory. Streaming text, tool arguments/results, measured usage,
error redaction, retry delay and cancellation use the compatible adapter; no SDK or dependency is loaded.

The typed client exposes `configureCloudflareWorkersAI`. CLI login accepts
`providers login --provider cloudflare-workers-ai --api-key-env CLOUDFLARE_API_KEY` (account id from `CLOUDFLARE_ACCOUNT_ID`, or `--base-url`);
it saves without enabling or testing. Enable explicitly with `e` in `/providers`, `/connect cloudflare`,
or `configureCloudflareWorkersAI({ enabled: true })`. Logout removes only the stored token and keeps routing/models.
Real account acceptance remains external; no live service or credentials were used for the local fake tests.

## Cloudflare AI Gateway (B10.22)

`cloudflare-ai-gateway` uses v1's [Unified API](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)
format and exact `provider/model` ids through your account's gateway. It is off by default,
even with environment tokens or a legacy `ai-gateway-provider` entry. Redirects and plain-HTTP public hosts are
refused; adding the preset starts no listener, SDK, login or request. Cloudflare now deprecates `/compat`
for single-model calls, but retains it for existing integrations and dynamic routes; this adapter preserves v1's contract.

`CLOUDFLARE_API_TOKEN`, then `CF_AIG_TOKEN`, then the stored token/environment reference supply auth on every
request, matching v1's environment-first priority. Both `Authorization` and `cf-aig-authorization` carry the
current token; config/model/plugin auth headers cannot replace it. Upstream provider keys/BYOK belong to the proxy.
Without an explicit endpoint, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID` override config routing;
they build `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`. A fully specified endpoint bypasses those ID checks.

`providers.set` and `client.configureCloudflareAIGateway` accept optional `cloudflareAiGateway` routing,
`metadata`, `cacheTtl` (seconds), `cacheKey`, `skipCache` and `collectLog`. Partial edits merge; null clears
an override. Explicit options win over legacy `options` and `options.headers["cf-aig-metadata"]` (invalid JSON
is ignored, as in v1). These options become [gateway headers](https://developers.cloudflare.com/ai-gateway/glossary/),
never generation parameters. Unset cache/log options retain gateway defaults. Metadata and cache-key values
stay private; reports show only presence and routing, never tokens or key tails. Persistence is atomic mode 0600.

Text/reasoning streams, fragmented parallel local tools/results, model-controlled images/output limits,
input/output/reasoning/cache usage, retry classification and cancellation use the native compatible transport.
`providers.refresh` retains configured/offline models without HTTP; no model ids, prices or `/models` endpoint
are guessed. An empty catalog asks for `provider/model` ids and leaves the saved configuration unchanged.

```json
{"providers":{"cloudflare-ai-gateway":{"enabled":false,"baseUrl":"http://127.0.0.1:1234/v1/team/coding/compat","apiKeyEnv":"TEAM_GATEWAY_TOKEN","cloudflareAiGateway":{"accountId":"team","gatewayId":"coding","metadata":{"project":"local"},"skipCache":true,"collectLog":false},"models":[{"id":"anthropic/your-model","images":true,"tool_call":true}]}}}
```

`providers login --provider "Cloudflare AI Gateway" --cloudflare-account <id> --cloudflare-gateway <id> --api-key-env TEAM_GATEWAY_TOKEN
--models anthropic/your-model` explicitly enables and saves without testing. Optional `--cloudflare-account` and
`--cloudflare-gateway` save routing ids. `control-plane providers smoke --provider cloudflare-ai-gateway --execute`
runs the existing small test. Account/token issuance, proxy/BYOK provisioning and live Cloudflare acceptance remain
external and unverified. Tests use temporary stores and injected responses only; no new dependency or network.

## TogetherAI (B10.11)

`togetherai` uses native Chat Completions, including text/reasoning streaming, fragmented parallel
function calls, tool-result replay, model image capabilities and token/cache usage. It remains off
by default, including when `TOGETHER_API_KEY` or a v1 `npm: "@ai-sdk/togetherai"` configuration exists.
Connect it explicitly:
`providers login --provider TogetherAI --api-key-env TOGETHER_API_KEY` (default `https://api.together.ai/v1`).
The variable holds the Bearer key. `/connect TogetherAI` accepts an optional endpoint and a masked
key; Ctrl+E uses the environment reference, Enter saves and tests, `r` refreshes, `m` opens `/model`.
`client.configureTogetherAI` uses the existing `providers.set` command. No new protocol command or SDK dependency.

TogetherAI's public upstream is [OpenAI compatible](https://docs.together.ai/docs/inference/openai-compatibility).
Plain-HTTP public hosts,
URL credentials, queries, fragments and redirects are refused. Tokens are required even if custom
headers supply Authorization. Adding a preset, listing auth methods or planning login makes no network call.

Refresh accepts TogetherAI's native array or a compatible `data`/`models` envelope, excludes non-language
models, deduplicates and keeps at most 400 sorted ids. Explicit model metadata/variants survive refresh;
failed refresh leaves the saved catalog intact. Offline `models.dev.json` metadata remains supported.
Reasoning models expose v1's low/medium/high variants (plus max for DeepSeek V4); explicit variants win.
SDK `options.baseURL` and private `options.apiKey` resolve natively; logout removes stored keys while
retaining other configuration and environment references. SDK generation option names map to native fields.
Usage accepts nested and flat cached/reasoning token counts; provider-reported cost is used when present.
No prices or context limits are guessed. Tests use temporary directories and injected HTTP fakes.
Real TogetherAI account/endpoint acceptance remains unverified.

## Kilo (B10.23)

`kilo` uses native [OpenAI-compatible Chat Completions](https://kilo.ai/docs/gateway/api-reference)
with v1's `HTTP-Referer: https://mendcode.ai/` and `X-Title: opencode` attribution defaults.
It stays off by default, including with `KILO_API_KEY` or a saved SDK configuration. Connect it explicitly:
`providers login --provider Kilo --api-key-env KILO_API_KEY`.
The variable holds the Bearer key; it is read again on each request. The default endpoint is
`https://api.kilo.ai/api/gateway`. Generation, refresh and connection
tests reject plain-HTTP public hosts, URL credentials, query strings, fragments, redirects and missing tokens.
Disabled providers never make refresh/test requests. Saved v1 `options.baseURL`, `options.apiKey`
and `options.headers` are resolved locally without loading an SDK or exposing keys in request bodies.

The native adapter streams text/reasoning, fragmented parallel function calls, ordered tool results,
images according to model capabilities and cache/token usage. Reported USD cost (including zero)
is retained in microdollars. Model output limits cap generation; `providers.refresh` loads up to
400 model ids from the proxy, including context, reasoning, image, tool and output-limit metadata.
Explicit model overrides survive refresh. There are no invented starter models; refresh failures
preserve the current catalog. Protocol commands and typed client helpers are the existing
`providers.*`, auth reports, model catalog and selection APIs; read-only authority is unchanged.

Real Kilo account/billing acceptance remains an external gap. Tests use local transport fakes, temporary data directories and no network.

## Gateway presets (B11)

Twelve more presets speak plain Chat Completions through one shared guard (`packages/engine-native/src/gateway-presets.ts`):

| id | name | endpoint | key variable |
|---|---|---|---|
| `fireworks` | Fireworks | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| `huggingface` | Hugging Face | `https://router.huggingface.co/v1` | `HF_TOKEN` |
| `baseten` | Baseten | `https://inference.baseten.co/v1` | `BASETEN_API_KEY` |
| `moonshotai` | Moonshot AI (Kimi) | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| `minimax` | MiniMax | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |
| `xiaomi` | Xiaomi MiMo | `https://api.xiaomimimo.com/v1` | `XIAOMI_API_KEY` |
| `zai` | Z.AI | `https://api.z.ai/api/paas/v4` | `ZHIPU_API_KEY` |
| `opencode-go` | OpenCode Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` |
| `ant-ling` | Ant Ling | `https://api.tbox.cn/api/llm/v1` | `ANT_LING_API_KEY` |
| `nearai` | NEAR AI | `https://cloud-api.near.ai/v1` | `NEARAI_API_KEY` |
| `foundry` | Microsoft Foundry | none: your resource's OpenAI v1 root, required | `AZURE_AI_FOUNDRY_API_KEY` |
| `atomic-chat` | Atomic Chat | `http://127.0.0.1:1337/v1` (local, no key) | none |

All are opt-in: a key variable alone never enables one; connect it in `/connect` (or `providers.set` with `enabled: true`, which needs a key except for `atomic-chat`). There are no starter models: `providers.refresh` lists them (`/connect` refreshes before testing). Endpoints follow the shared outbound rule: HTTPS, or HTTP only on a literal loopback host, no URL credentials, query or fragment; redirects are refused; the current key is the only `Authorization`; a missing key sends nothing. Override an endpoint (a proxy, a regional host, Z.AI's coding plan at `https://api.z.ai/api/coding/paas/v4`) with `baseUrl`. Foundry sends the key as Bearer, which the Foundry OpenAI v1 route accepts.

The endpoints, key variables and the Atomic Chat port are the providers' public defaults as of writing and were not checked against live services (Ant Ling and Atomic Chat are the least certain). Tests use local transport fakes, temporary directories and no network.

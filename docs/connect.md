# Connecting providers

`/connect` offers API-key and ChatGPT OAuth methods; `/providers` manages API providers. Both are clients of the daemon's `providers.*` commands ([providers.md](providers.md)): the terminal never handles OAuth tokens.

## `/connect`

Pick a provider with the arrow keys or `1`-`9`, or press `/` and type part of its name or id (`free`, `router`): the list keeps the matches with their numbers, ↑↓ move among them, Enter connects the selected one and Esc ends the search. `/connect anthropic` (an id or a name) opens that provider's form directly.

| Choice | Asks for |
|---|---|
| OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Groq, DeepSeek | the API key |
| Ollama, LM Studio | nothing but the base URL (filled in) and optional model ids |
| Custom endpoint | name, format (`openai-compatible`, `openai`, `anthropic`), base URL, key and optional model ids |
| ChatGPT | browser or device login, using v2's own credential store |
| OpenCode (free) | nothing: adds your `opencode` CLI as an ACP agent ([below](#opencode-free)) |

OpenAI first opens a method picker (ChatGPT browser/device or API key). `/connect chatgpt` opens its OAuth methods or the saved authorization status. OAuth stays unavailable until the daemon has a configured public client id. Numeric shortcuts select the first nine providers; arrows also reach ChatGPT.

The bordered page uses the shared panel grid, with action hints in its header and a single column below 70 cells. During OAuth, `c` copies the authorization URL, `s` checks status and `x` or Escape cancels the pending flow. After login, `r` refreshes, `m` opens models and `d` then `y` removes v2 credentials. `e` retries a cancelled/failed flow. Reopening the page reads the saved status. Device codes and URLs are temporary authorization capabilities, not credential reports.

### The key

- It is typed or pasted into a masked field: bullets only, never the characters, plus a character count. A bracketed paste works; spaces and newlines are dropped.
- `ctrl+u` clears the field, backspace deletes the last character, `esc` goes back and discards it.
- `ctrl+e` switches to an environment variable instead: a preset shows which one (`ANTHROPIC_API_KEY`, ...), a custom endpoint asks for the name. The daemon reads it on every request, so it has to be set where the daemon runs. Nothing is stored but the variable's name.
- On Enter the key goes out once, in `providers.set`, and is gone from the terminal's state. No other command carries it, no toast or log names it, and an error that echoes it is masked before it is shown.

### After Enter

1. `providers.set` saves the provider. A refusal returns to the form with the reason and an empty key field.
2. `providers.test` runs, a user action: one tiny request to the provider. It shows `test ok · 312 ms · model` or the error. A failed test keeps what was saved; `e` edits it, `t` tests again.
3. On success, `r` refreshes the provider's model list (`providers.refresh`) and `m` opens the model page. The model catalog is reloaded in the background either way.

Custom endpoint names are lowercase letters, digits, `-` and `_`, starting with a letter (32 at most); `chatgpt` and preset ids are refused. Model ids are separated by commas or spaces (50 at most, 66 characters each).

## `/providers`

One row per provider: name, wire format, source (`config` for an entry in `providers.json`, `env` for an environment key alone), the key's masked tail (`…3f2a`, `set`, `env`, `none` for a local server, `missing`), on/off, model count, and the last result or the error that keeps it from working.

| Key | Action |
|---|---|
| `↑` `↓` | select |
| `enter` | show the endpoint, key status, error and models |
| `e` | turn it on or off (`providers.set { enabled }`) |
| `t` | test it (`providers.test`) |
| `r` | refresh its models (`providers.refresh`) |
| `d` | remove it, after `y` (`providers.remove`); a preset enabled by an environment key stays until the key goes |
| `a` | add one (`/connect`) |
| `esc` | back |

## Quick switch

`/model` (and `ctrl+x m`) opens a small card over the chat, not a page, to change this session's model. Rows are your favorites, then the last five used, then the catalog grouped by provider; each shows the name, the exact id and the provider with its effort. It is the same list and search as the pages below.

| Key | Does |
|---|---|
| type | filter at once (name, id and provider) |
| `↑` `↓` | move |
| `enter` | switch this session to the highlighted model, close |
| `←` `→` (or `ctrl+e`) | change the highlighted model's effort in place |
| `ctrl+f` | star or unstar the model |
| `tab` | open the full page below: roles and defaults |
| `esc` | close without a change |

`/model roles` (or `/model all`) opens the full page directly. `/model <id> [effort]` still switches without a screen, `/model reset` clears the session's choice, and F2 / F3 still cycle the next recent model and the next effort.

## Model page

`/model roles` groups the catalog by who serves it: the ChatGPT subscription, Claude Code, then each provider under its name. The roles are `this session`, `main`, `plan`, `subagent`, `compaction`, `dream`, `aside` and `small`.

- `f` stars the model of the focused row. Favorites lead the page, and a `*` marks a starred model wherever it is listed.
- The last five models you used (chosen on the page, with `/model <id>`, or with F2) are listed under Recent.
- Both live in `<dataDir>/tui/models.json`, next to the terminal's other files. The daemon never sees them; a missing or broken file is empty.

`←` `→` walk the models in the order the page lists them.

`/` on a role opens its fuzzy model picker; `/model search` opens it for this session. Search matches name, id and
provider. `ctrl+a` switches to the provider list (including Connect provider), `ctrl+f` toggles a favorite, and Enter
selects. Favorites and Recent lead the unfiltered list without duplicates. Escape backs out of a provider filter,
then returns to the role page. Native models with variants or efforts open the variant picker after selection.

## Where each list comes from

Every list is MendCode's own: no other program's cache is read or written, and no session's model is changed when a list changes.
A session on a model a list no longer has keeps it; its turn then fails with the provider's answer.

- **ChatGPT** (MendCode's engine): the subscription backend is asked which models your account can use (`GET …/backend-api/codex/models`,
  the request the Codex CLI makes), with MendCode's ChatGPT login, and the answer is kept in `<dataDir>/chatgpt-models.json`: the
  name, efforts and windows of each model, the ETag, and a hash of the account, never a token. A list older than 5 minutes is
  shown at once and refreshed in the background (a 304 when nothing changed). No network, an error or an empty answer keep the last
  list and are retried after a minute. A list of another account is asked again. A first listing with no list yet waits up to 5 s
  for it; with no login, or before the first answer, only the engine default (`gpt-6-luna`) is listed. A model the list does not
  have (`models set-default chatgpt gpt-6-astra`, `/model gpt-6-astra`) is asked for again once before it is refused. `codex:`
  models (the thread bridge) are the same list.
- **Claude Code**: `claude-fable`, `claude-opus`, `claude-sonnet` and `claude-haiku` (the newest of each family) and any full id of
  a family. Claude Code has no command that lists models, so there is nothing to refresh; they are shown when `claude --version`
  answers.
- **API-key providers**: the provider's preset, filled in by models.dev (`<dataDir>/models.dev.json`, refreshed in the background
  when a week old), or the `models` saved in `providers.json`. `providers refresh <id>` asks the provider's own list; an empty answer
  or an error keeps the current one. Azure, Vertex and Cloudflare AI Gateway have no list to ask: their models are the ids you
  configure.
- **ACP agents**: `acp:<name>`, plus the models the agent offered on its first turn (`<dataDir>/acp-models.json`).
- **pi**: the models pi's own configuration lists.

## Google Gemini

`/connect google` or `/connect Google Gemini` opens the masked API-key form; Ctrl+E uses `GOOGLE_GENERATIVE_AI_API_KEY`. Enter explicitly enables and tests the provider. Google Gemini follows the existing choices, preserving shortcuts 1–9; reach it with arrows. Refresh and model selection use the same keys as other providers. Custom endpoints also offer the `google` native format. Gemini stays disabled until explicitly enabled; see [native provider behavior](providers.md#google-gemini-native-b1003).

## GitHub Copilot

`/connect github-copilot` (or `/connect GitHub Copilot`) offers device login and a masked GitHub token.
Copilot follows the existing choices, preserving shortcuts 1–9. Device login needs a configured
`MENDCODE_GITHUB_COPILOT_CLIENT_ID`; missing configuration keeps the token fallback available.
During login, `c` copies the code, `s` checks status and `x` or Escape cancels. Reopen a saved login
to see its status; `r` refreshes credentials, `m` opens models and `d` then `y` logs out.
Token login uses Ctrl+E for `GITHUB_COPILOT_TOKEN`, with the existing test/refresh flow.
The provider stays off until explicit login/enablement. Enterprise configuration and credential
boundaries are in [providers.md](providers.md#github-copilot-native-b1014).

`bun scripts/render-frames.ts .agents-frames/B10.14 --b10-14 100x30 180x50` renders isolated app-harness evidence.

Console accounts use the separate local-only [Console selector](console.md): `/org` or `/console` (B74).

## Azure OpenAI

`/connect azure` (or `/connect Azure OpenAI`) offers API key and Microsoft Entra ID from the daemon environment.
Azure is appended after the existing choices, preserving shortcuts 1–9. Enter a resource name or HTTPS endpoint,
API version, Responses/Chat Completions format, v1/deployment URLs and deployment ids. Ctrl+E uses `AZURE_API_KEY`;
Entra accepts a token variable name or the client credentials documented in [providers.md](providers.md#azure-openai--microsoft-entra-id-b1002).
Tab only changes focus. Enter explicitly saves/enables and tests; failed tests keep public fields for editing.
Reopening retains public settings. `/providers` shows Entra, API version and routing in its details.
Refresh retains configured deployment ids without discovering global models. Header hints and bordered panels
use the existing grid, with one column below 70 cells.

`bun scripts/render-frames.ts .agents-frames/B10.02 --b10-02 100x30 180x50` renders isolated app evidence.

## Amazon Bedrock

`/connect amazon-bedrock`, `/connect Amazon Bedrock`, or `/connect bedrock` offers AWS credential chain and Bedrock bearer token. It follows all existing choices, preserving shortcuts 1–9. Tab moves focus; Enter on the last field explicitly enables, saves and tests. Ctrl+E on the bearer form uses `AWS_BEARER_TOKEN_BEDROCK`; typed tokens are masked and cleared on submission. Region/profile/endpoint, metadata and credential-process opt-ins use the shared panel grid, header hints and single-column compact layout. Reopening keeps public settings; `e` edits a failed test, `t` retries, `r` refreshes models, `m` opens selection. `/providers` shows the auth route and AWS settings without key tails. See [AWS boundaries](providers.md#amazon-bedrock--aws-b1001).

`bun scripts/render-frames.ts .agents-frames/B10.01 --b10-01 100x30 180x50` renders isolated app-harness evidence.

## Google Vertex AI

`/connect google-vertex`, `/connect Google Vertex AI`, or `/connect vertex` opens public ADC settings: project, location, endpoint override, token-variable name, quota project, metadata opt-in and publisher model ids. The choice is appended, preserving shortcuts 1–9. Tab only moves focus; Enter on the last field explicitly saves, enables and tests. No token input or OAuth browser flow appears. Metadata is off by default. The shared panel grid fills wide screens, with header hints and a single column below 70 cells.

Reopening retains public settings. `e` edits, `t` retries, `r` retains the offline/configured model catalog and `m` selects a namespaced model. `/providers` shows ADC presence and routing; `e` toggles enablement. External Google credentials are never removed. See [ADC behavior and remaining federation gaps](providers.md#google-vertex-ai--gcp-adc-b1004).

`bun scripts/render-frames.ts .agents-frames/B10.04 --b10-04 100x30 180x50` renders isolated app-harness evidence.

## Vertex Anthropic

`/connect google-vertex-anthropic` or `/connect Vertex Anthropic` opens the public ADC form. The provider follows every existing choice, preserving shortcuts 1–9. Project, Claude location (default `global`), endpoint, token-variable name, quota project, metadata opt-in and versioned Claude publisher ids use the same bordered panel grid and header hints as Vertex Gemini. No token input or OAuth flow appears. Tab changes focus only; Enter on the last field explicitly enables, saves and tests. Failed tests preserve fields for `e` edit/`t` retry; `r` retains publisher ids and `m` opens models. `/providers` shows ADC presence/routing and can turn the provider off. See [native behavior and external gaps](providers.md#vertex-anthropic-b1005).

Model rows use the catalog label for long Vertex Anthropic namespaces; the header retains the exact id. Compact role values end with an ellipsis when they need more space.

`bun scripts/render-frames.ts .agents-frames/B10.05 --b10-05 100x30 180x50` writes isolated app-harness evidence without contacting a provider.

## Mistral

`/connect Mistral` (or `/connect mistral`) follows existing choices, preserving their shortcuts. The shared bordered grid shows a masked API-key input; Ctrl+E selects the `MISTRAL_API_KEY` reference without reading/displaying it. Enter explicitly enables, saves and tests; failed tests keep `e` edit/`t` retry, `r` refreshes chat models and `m` opens model selection. `/providers` shows state/key/endpoint/models and `e` toggles off immediately through the daemon. Mistral stays off until this explicit connection or another enable action. The custom endpoint form includes the `mistral` wire type. See [native behavior and external acceptance](providers.md#mistral-b1007).

`bun scripts/render-frames.ts .agents-frames/B10.07 --b10-07 100x30 180x50` writes isolated app frames, without real credentials or network.
## DeepInfra

`/connect DeepInfra` (or `/connect deepinfra`) opens an optional endpoint override (blank uses `https://api.deepinfra.com/v1/openai`) and the masked API-key form.
It follows all existing choices, preserving shortcuts 1–9. Reopening retains the public endpoint;
the token field stays empty. Tab only changes focus. Ctrl+E selects `DEEPINFRA_API_KEY`; Enter explicitly enables,
saves and tests. `e` edits a failed test, `t` retries, `r` refreshes and `m` opens namespaced models.
`/providers` shows key presence, endpoint and model count; `e` disables immediately through the daemon.
The existing shared bordered grid, header hints and compact single-column layout are preserved.
See [provider behavior and external acceptance](providers.md#deepinfra-b1008).

`bun scripts/render-frames.ts .agents-frames/B10.08 --b10-08 100x30 180x50` writes isolated app frames.
## Perplexity

`/connect perplexity` (or `/connect Perplexity`) follows the existing choices without moving shortcuts 1–9.
Optionally override the endpoint (default `https://api.perplexity.ai`), then enter the masked Bearer key. Ctrl+E uses `PERPLEXITY_API_KEY`. Enter explicitly enables and tests; `r` refreshes models, `m` opens model selection,
and `/providers` toggles or removes the configuration. See the [Sonar retirement note](providers.md#perplexity-sonar-compatibility-b1012).

`bun scripts/render-frames.ts .agents-frames/B10.12 --b10-12 100x30 180x50` renders isolated app-harness evidence.

## Alibaba

`/connect alibaba` or `/connect Alibaba` opens an optional endpoint (default the international DashScope compatible endpoint) and the masked Bearer-key form.
Alibaba follows existing choices without moving shortcuts 1–9. Ctrl+E uses `DASHSCOPE_API_KEY`. Enter explicitly enables and tests; `r` refreshes models and `m` opens model selection.
`/providers` shows connection details and supports test, refresh, live on/off and confirmed removal.
Panels and header hints follow the shared grid, with a single column below 70 cells. See the [provider policy](providers.md#alibaba-model-studio-b1013).

`bun scripts/render-frames.ts .agents-frames/B10.13 --b10-13 100x30 180x50` renders isolated app-harness evidence.

## OpenCode Zen

`/connect opencode`, `/connect OpenCode Zen` or `/connect zen` opens the masked key form (optional endpoint, default `https://opencode.ai/zen/v1`).
Zen follows the existing choices without moving shortcuts 1–9. Enter the key; Ctrl+E references
`OPENCODE_API_KEY` instead. Enter explicitly enables, loads proxy models, then tests the first model. A failed refresh
keeps the saved connection and skips testing. `r` refreshes, `t` tests, `e` edits and `m` opens model selection.
`/providers` supports details, live on/off and confirmed removal. Panels use the shared grid and header hints;
compact terminals below 70 cells use one column. The [provider policy](providers.md#opencode-zen-b1015) describes formats,
credential storage and the external console/account gap. There is no "free models, no key" choice in this form: Zen
refuses its free tier to any client but OpenCode's own (re-checked live 2026-10-17), so the free models go through
**OpenCode (free)** below.

`bun scripts/render-frames.ts .agents-frames/B10.15 --b10-15 100x30 180x50` renders isolated app-harness evidence.

## OpenCode (free)

OpenCode's free Zen models (`big-pickle`, `*-free`) answer only OpenCode's own client: a direct API call with no key
gets `FreeTierError`. So the last `/connect` choice, **OpenCode (free)**, does not add a provider. Enter adds your
`opencode` CLI as the [ACP agent](acp-engine.md) `opencode` (`opencode acp`), with no form and no key, through the same
`acpAgents` setting `/acp` edits; an `opencode` agent you already set up is left as it is. Then pick `acp:opencode`
(OpenCode's default model) in `/model`. After its first turn, `/model` also lists every model OpenCode offered, as
`acp:opencode/<model>` (`acp:opencode/opencode/glm-5.3-flash-free`…); with `opencode auth login` done, those include
your OpenCode providers too. After the first turn on a model, its effort levels are offered too (`low`, `high`, `max` for
`deepseek-v4.1-flash-free`), set through OpenCode's effort select ([ACP effort](acp-engine.md#effort)).

It needs `opencode` on the daemon's PATH (`pnpm add -g opencode-ai`). Requests go to opencode.ai under OpenCode's terms,
and the free tier is rate limited: OpenCode retries a limited call quietly, so a turn can sit without output; Esc stops it.
The turn runs on OpenCode's own tools and permissions, approved through MendCode's flow like any ACP agent.

## LLMGateway

`/connect llmgateway` or `/connect LLMGateway` opens an optional endpoint (default `https://api.llmgateway.io/v1`) and the masked Bearer-key form.
LLMGateway follows existing choices without moving shortcuts 1–9. Ctrl+E uses `LLMGATEWAY_API_KEY`. Enter explicitly enables, loads the gateway catalog, then tests its first model. Failed refresh
keeps the saved configuration and skips testing; `r` retries refresh, `t` tests and `e` edits with an empty token field.
`m` opens model selection after a successful test. `/providers` offers details, on/off and confirmed removal.
Panels use the shared grid, with header hints and a single column below 70 cells. The
[provider policy](providers.md#llmgateway-b1016) documents authentication and the external account gap.

`bun scripts/render-frames.ts .agents-frames/B10.16 --b10-16 100x30 180x50` renders isolated app-harness evidence.

## NVIDIA

`/connect nvidia` or `/connect NVIDIA` opens an optional endpoint (default `https://integrate.api.nvidia.com/v1`) and the masked Bearer-key form.
NVIDIA follows the existing choices without moving shortcuts 1–9. Ctrl+E uses `NVIDIA_API_KEY`. Enter explicitly enables, loads proxy models, then tests the first model. A failed refresh keeps
the saved configuration and skips testing; `r` retries refresh, `t` tests and `e` edits with an empty token field.
`m` opens model selection after a successful test. `/providers` offers details, live on/off and confirmed removal.
Panels use the shared grid with header hints and a single column below 70 cells. The
[provider policy](providers.md#nvidia-b1017) documents the defaults and the external account/service gap.

`bun scripts/render-frames.ts .agents-frames/B10.17 --b10-17 100x30 180x50` renders isolated app-harness evidence.

## SAP AI Core

`/connect sap-ai-core` or `/connect SAP AI Core` follows existing choices without moving shortcuts 1–9.
Enter the masked JSON service key from your SAP BTP instance; the AI Core API root (including `/v2`) is optional and otherwise derived from the key. Ctrl+E references
`AICORE_SERVICE_KEY`; JSON spaces are preserved. Optional deployment/resource-group fields override daemon
environment defaults. Leave models blank to discover the tenant catalog. Enter explicitly enables, refreshes,
then tests; a failed refresh skips testing. `r` retries refresh, `t` tests, `e` edits and `m` selects a model.
`/providers` supports details, live on/off and confirmed removal. Shared bordered panels, header hints and
compact scrolling remain unchanged. [Credential and endpoint policy](providers.md#sap-ai-core-b1018).

`bun scripts/render-frames.ts .agents-frames/B10.18 --b10-18 100x30 180x50` renders isolated app-harness evidence.

## Zenmux

`/connect zenmux` or `/connect Zenmux` follows existing choices without moving shortcuts 1–9.
Optionally override the endpoint (default `https://zenmux.ai/api/v1`) and enter the masked Bearer key. Ctrl+E references `ZENMUX_API_KEY`. Enter explicitly enables, loads the catalog, then tests its first model. A failed refresh skips testing;
`r` retries refresh, `t` tests, `e` edits with an empty token field and `m` opens model selection.
`/providers` offers details, live on/off and confirmed removal. Shared bordered panels, header hints and
single-column rendering below 70 cells follow the existing page. See [provider policy](providers.md#zenmux-b1019).

`bun scripts/render-frames.ts .agents-frames/B10.19 --b10-19 100x30 180x50` renders isolated app-harness evidence.

## GitLab

`/connect gitlab` adds GitLab after the existing choices without moving shortcuts 1–9. Enter your GitLab instance URL (HTTPS, required: gitlab.com or self-managed),
masked token and optional GitLab Group ID for workflow discovery. Ctrl+E references
`GITLAB_TOKEN`. Save explicitly enables, loads the catalog, then tests an agentic model. Failed discovery
skips testing; `r` retries, `t` tests, `e` clears the token for editing, and `m` opens model selection.
`/providers` shows the catalog, live on/off and confirmed removal. The form uses shared bordered panels,
header hints and a single column below 70 cells. `/model` selects `gitlab:duo-workflow-*` for native DWS
streaming with local tool permissions; `/providers` shows namespace and workflow tools. No namespace uses
the offline workflow catalog. Numeric `projectId` can be supplied via `configureGitLab`/provider config;
repository auto-detection and browser OAuth remain unavailable. See [GitLab policy](providers.md#gitlab-b1020).

`bun scripts/render-frames.ts .agents-frames/B10.20 --b10-20 100x30 180x50` renders isolated app-harness evidence.

## Cerebras

`/connect Cerebras` or `/connect cerebras` opens an optional endpoint (default `https://api.cerebras.ai/v1`) and the masked API-key form.
Cerebras follows all existing choices without moving shortcuts 1–9. Ctrl+E uses `CEREBRAS_API_KEY`. Tab changes focus only. Enter explicitly enables, saves and tests;
`e` edits failures with an empty key, `t` retries, `r` refreshes and `m` opens namespaced models/variants.
Reopening retains only public connection fields. `/providers` offers details, live on/off and removal.
The existing shared bordered grid, header hints and single-column layout below 70 cells are preserved.
See [provider behavior and external acceptance](providers.md#cerebras-b1009).

`bun scripts/render-frames.ts .agents-frames/B10.09 --b10-09 100x30 180x50` writes isolated app frames.

## Cohere

`/connect Cohere` or `/connect cohere` follows all existing choices, preserving shortcuts 1–9.
Optionally override the Cohere v2 root (default `https://api.cohere.com/v2`) and enter the masked Bearer key. Ctrl+E references `COHERE_API_KEY`. Tab only changes focus; Enter explicitly enables, saves and tests.
Reopening retains the public URL with an empty key. `e` edits failures, `t` retries, `r` refreshes chat models
and `m` opens namespaced model selection. `/providers` offers details, live on/off and confirmed removal.
The existing shared bordered panels and header hints remain, with one column below 70 cells.
See [native behavior and external acceptance](providers.md#cohere-b1010).

`bun scripts/render-frames.ts .agents-frames/B10.10 --b10-10 100x30 180x50` writes isolated app frames.

## Cloudflare Workers AI

`/connect cloudflare-workers-ai`, `/connect Cloudflare Workers AI` or `/connect cloudflare` opens the
optional endpoint, masked Bearer token, your Cloudflare account id (required unless you give a full endpoint) and optional model ids. Ctrl+E references
`CLOUDFLARE_API_KEY` and clears typed credentials. Tab changes focus only; Enter on the final field
explicitly enables, saves and tests. `e` edits, `t` retries, `r` retains the configured/offline catalog and
`m` selects a namespaced model. Reopening keeps public routing/models and an empty token input.
`/providers` shows account routing and supports live on/off and confirmed removal. The provider is appended
without moving existing numeric shortcuts. Shared bordered panels fill the page, wide forms show routing
beside the fields, and terminals below 70 columns use one column. Hints stay in the page header.
See [provider policy and external gap](providers.md#cloudflare-workers-ai-b1021).

`bun scripts/render-frames.ts .agents-frames/B10.21 --b10-21 100x30 180x50` writes isolated app-harness frames.

## Cloudflare AI Gateway

`/connect cloudflare-ai-gateway`, `/connect Cloudflare AI Gateway` or `/connect cloudflare gateway` opens
an optional endpoint, masked gateway token, your account and gateway ids (required unless you give a full endpoint) and `provider/model` ids. The choice is
appended after existing providers. Ctrl+E clears typed credentials and uses `CLOUDFLARE_API_TOKEN` or `CF_AIG_TOKEN`.
Tab changes focus only; Enter on the final field explicitly enables, saves and tests. `e` edits, `t` retries,
`r` retains the local catalog and `m` opens model selection. Reopening retains public routing/models with an
empty token field. `/providers` shows metadata/cache-key presence and public cache/log options, supports live
on/off and confirmed removal. Shared bordered panels, header hints and compact single-column layout apply.
See [gateway policy and external gaps](providers.md#cloudflare-ai-gateway-b1022).

`bun scripts/render-frames.ts .agents-frames/B10.22 --b10-22 100x30 180x50` writes isolated app-harness frames.

## Kilo

`/connect kilo` or `/connect Kilo` follows all existing choices, preserving shortcuts 1–9.
Optionally override the endpoint (default `https://api.kilo.ai/api/gateway`) and enter the masked Bearer key; Ctrl+E uses `KILO_API_KEY` instead.
Tab only moves focus. Enter explicitly enables, saves, refreshes the catalog, then tests its first model.
A failed refresh skips testing; `r` retries discovery and tests on recovery, `t` tests again,
`e` edits with an empty token field and `m` opens namespaced model selection. `/providers` offers
details, live on/off and confirmed removal. The existing bordered panel grid, header hints and
single-column layout below 70 cells are preserved. See [provider policy](providers.md#kilo-b1023).

`bun scripts/render-frames.ts .agents-frames/B10.23 --b10-23 100x30 180x50` writes isolated app frames.

### Default effort per model (C7)

On the variant page (`/variants`, or right after picking a model) `d` saves the highlighted effort or variant as that model's
default (`Default` takes it away), and `s` also saves the choice as the `main` role, which new sessions start with. A model
picked on the model page, the picker or with `/model <id>` without an effort starts with its saved default; an effort typed
after the id wins. Defaults live in `<dataDir>/tui/models.json` under `defaults` (`{ "<model id>": { effort?, variant? } }`),
local like the favorites.

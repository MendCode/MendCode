# Connecting providers

Use `/connect` to add an API-key provider or sign in with ChatGPT OAuth, then `/providers` to manage API providers. Both use the daemon's `providers.*` commands ([providers.md](providers.md)); the terminal never handles OAuth tokens.

## `/connect`

1. Open `/connect`.
2. Pick a provider with the arrow keys or `1`-`9`. Numeric shortcuts select the first nine providers; arrows also reach ChatGPT.
3. Press Enter to connect the selected provider.

To search, press `/` and type part of a name or id, such as `free` or `router`. Matches keep their numbers; ↑↓ move among them, Enter connects the selection and Esc ends the search.

Use an id or name to open a form directly, for example `/connect anthropic`.

| Choice | Asks for |
|---|---|
| OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Groq, DeepSeek | the API key |
| Ollama, LM Studio | nothing but the base URL (filled in) and optional model ids |
| Custom endpoint | name, format (`openai-compatible`, `openai`, `anthropic`), base URL, key and optional model ids |
| ChatGPT | Sign in with ChatGPT in the browser ([setup](setup.md#logins)), using v2's own credential store |
| OpenCode (free) | nothing: adds your `opencode` CLI as an ACP agent ([below](#opencode-free)) |

OpenAI first opens a method picker (ChatGPT browser/device or API key). `/connect chatgpt` opens its OAuth methods or the saved authorization status. The browser method needs nothing configured; device code is offered only with a configured Codex-style client id (`MENDCODE_OPENAI_OAUTH_CLIENT_ID`). Numeric shortcuts select the first nine providers; arrows also reach ChatGPT.

### OAuth controls

| When | Key | Does |
|---|---|---|
| During OAuth | `c` | Copy the authorization URL. |
| During OAuth | `s` | Check status. |
| During OAuth | `x` or Escape | Cancel the pending flow. |
| After login | `r` | Refresh. |
| After login | `m` | Open models. |
| After login | `d` then `y` | Remove v2 credentials. |
| Cancelled/failed flow | `e` | Retry. |

Reopening the page reads the saved status. Device codes and URLs are temporary authorization capabilities, not credential reports.

The bordered page uses the shared panel grid, with action hints in its header and a single column below 70 cells.

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

Open `/providers` to see one row per provider:

| Field | Shows |
|---|---|
| Name and wire format | The provider and its format. |
| Source | `config` for an entry in `providers.json`; `env` for an environment key alone. |
| Key | Masked tail (`…3f2a`), `set`, `env`, `none` for a local server, or `missing`. |
| State | On/off. |
| Models | Model count. |
| Result | Last result or the error that keeps it from working. |

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

Open `/model roles` to see the catalog grouped by who serves it: the ChatGPT subscription, Claude Code, then each provider under its name.

Available roles:

- `this session`
- `main`
- `plan`
- `subagent`
- `compaction`
- `dream`
- `aside`
- `small`

- `f` stars the model of the focused row. Favorites lead the page, and a `*` marks a starred model wherever it is listed.
- The last five models you used (chosen on the page, with `/model <id>`, or with F2) are listed under Recent.
- Both live in `<dataDir>/tui/models.json`, next to the terminal's other files. The daemon never sees them; a missing or broken file is empty.

`←` `→` walk the models in the order the page lists them.

### Search for a model

Press `/` on a role to open its fuzzy model picker, or use `/model search` for this session. Search matches name, id and provider. Favorites and Recent lead the unfiltered list without duplicates.

| Key | Does |
|---|---|
| `ctrl+a` | Switch to the provider list, including Connect provider. |
| `ctrl+f` | Toggle a favorite. |
| Enter | Select; native models with variants or efforts then open the variant picker. |
| Escape | Back out of a provider filter, then return to the role page. |

## Where each list comes from

Every list is MendCode's own: no other program's cache is read or written, and no session's model is changed when a list changes.
A session on a model a list no longer has keeps it; its turn then fails with the provider's answer.

### ChatGPT

For MendCode's engine, the subscription backend is asked which models your account can use with MendCode's ChatGPT login: `GET …/backend-api/codex/models`, the request the Codex CLI makes.

The answer is kept in `<dataDir>/chatgpt-models.json`: each model's name, efforts and windows, the ETag, and a hash of the account, never a token. `codex:` models (the thread bridge) use the same list.

| Condition | Behavior |
|---|---|
| List older than 5 minutes | Show it at once and refresh in the background; 304 when nothing changed. |
| No network, error or empty answer | Keep the last list; retry after a minute. |
| List of another account | Ask again. |
| First listing, no list yet | Wait up to 5 s. |
| No login, or before the first answer | List only the engine default, `gpt-6-luna`. |
| Model absent from list | Ask again once before refusing, including `models set-default chatgpt gpt-6-astra` or `/model gpt-6-astra`. |

With a Sign in with ChatGPT login, the list is asked of `api.openai.com/v1/models` instead, OpenAI's own request for that route. Models marked `supported_in_api: false` are left out.

### Claude Code

The list contains `claude-fable`, `claude-opus`, `claude-sonnet` and `claude-haiku`, the newest of each family, and any full id of a family.

Claude Code has no command that lists models, so there is nothing to refresh. They are shown when `claude --version` answers.

### API-key providers

The list uses the provider's preset, filled in by models.dev, or the `models` saved in `providers.json`. The models.dev cache, `<dataDir>/models.dev.json`, refreshes in the background when a week old.

`providers refresh <id>` asks the provider's own list. An empty answer or error keeps the current one. Azure, Vertex and Cloudflare AI Gateway have no list to ask: their models are the ids you configure.

### ACP and pi

| Engine | Model list |
|---|---|
| ACP agents | `acp:<name>`, plus models offered on the agent's first turn (`<dataDir>/acp-models.json`). |
| pi | Models pi's own configuration lists. |

## Google Gemini

1. Open `/connect google` or `/connect Google Gemini` to reach the masked API-key form. Google Gemini follows the existing choices, preserving shortcuts 1–9; reach it with arrows.
2. Enter the key, or use Ctrl+E for `GOOGLE_GENERATIVE_AI_API_KEY`.
3. Press Enter to explicitly enable and test the provider. Gemini stays disabled until explicitly enabled.

Refresh and model selection use the same keys as other providers. Custom endpoints also offer the `google` native format. See [native provider behavior](providers.md#google-gemini-native-b1003).

## GitHub Copilot

Open `/connect github-copilot` (or `/connect GitHub Copilot`) for device login or a masked GitHub token. Copilot follows the existing choices, preserving shortcuts 1–9.

- Device login needs a configured `MENDCODE_GITHUB_COPILOT_CLIENT_ID`; without it, the token fallback remains available.
- Token login uses Ctrl+E for `GITHUB_COPILOT_TOKEN`, with the existing test/refresh flow.
- The provider stays off until explicit login/enablement.

| When | Key | Does |
|---|---|---|
| During login | `c` | Copy the code. |
| During login | `s` | Check status. |
| During login | `x` or Escape | Cancel. |
| Saved login | `r` | Refresh credentials. |
| Saved login | `m` | Open models. |
| Saved login | `d` then `y` | Log out. |

Reopen a saved login to see its status. Enterprise configuration and credential boundaries are in [providers.md](providers.md#github-copilot-native-b1014).

`bun scripts/render-frames.ts .agents-frames/B10.14 --b10-14 100x30 180x50` renders isolated app-harness evidence.

Console accounts use the separate local-only [Console selector](console.md): `/org` or `/console` (B74).

## Azure OpenAI

Open `/connect azure` (or `/connect Azure OpenAI`) for an API key or Microsoft Entra ID from the daemon environment. Azure is appended after the existing choices, preserving shortcuts 1–9.

1. Enter a resource name or HTTPS endpoint, API version, Responses/Chat Completions format, v1/deployment URLs and deployment ids.
2. Choose credentials. Ctrl+E uses `AZURE_API_KEY`; Entra accepts a token variable name or the client credentials documented in [providers.md](providers.md#azure-openai--microsoft-entra-id-b1002).
3. Press Enter to explicitly save/enable and test. Tab only changes focus; failed tests keep public fields for editing.

Reopening retains public settings. `/providers` shows Entra, API version and routing in its details. Refresh retains configured deployment ids without discovering global models.

Header hints and bordered panels use the existing grid, with one column below 70 cells.

`bun scripts/render-frames.ts .agents-frames/B10.02 --b10-02 100x30 180x50` renders isolated app evidence.

## Amazon Bedrock

Open `/connect amazon-bedrock`, `/connect Amazon Bedrock`, or `/connect bedrock` to choose AWS credential chain or Bedrock bearer token. It follows all existing choices, preserving shortcuts 1–9.

1. Fill in region/profile/endpoint, metadata and credential-process opt-ins. Tab moves focus.
2. On the bearer form, enter a masked token or use Ctrl+E for `AWS_BEARER_TOKEN_BEDROCK`. Typed tokens are cleared on submission.
3. Press Enter on the last field to explicitly enable, save and test.

Reopening keeps public settings:

| Key | Does |
|---|---|
| `e` | Edit a failed test. |
| `t` | Retry. |
| `r` | Refresh models. |
| `m` | Open selection. |

`/providers` shows the auth route and AWS settings without key tails. The form uses the shared panel grid, header hints and single-column compact layout. See [AWS boundaries](providers.md#amazon-bedrock--aws-b1001).

`bun scripts/render-frames.ts .agents-frames/B10.01 --b10-01 100x30 180x50` renders isolated app-harness evidence.

## Google Vertex AI

Open `/connect google-vertex`, `/connect Google Vertex AI`, or `/connect vertex` for public ADC settings. The choice is appended, preserving shortcuts 1–9.

1. Fill in project, location, endpoint override, token-variable name, quota project, metadata opt-in and publisher model ids. Metadata is off by default.
2. Use Tab to move focus only.
3. Press Enter on the last field to explicitly save, enable and test.

No token input or OAuth browser flow appears. The shared panel grid fills wide screens, with header hints and a single column below 70 cells.

Reopening retains public settings. `e` edits, `t` retries, `r` retains the offline/configured model catalog and `m` selects a namespaced model. `/providers` shows ADC presence and routing; `e` toggles enablement. External Google credentials are never removed. See [ADC behavior and remaining federation gaps](providers.md#google-vertex-ai--gcp-adc-b1004).

`bun scripts/render-frames.ts .agents-frames/B10.04 --b10-04 100x30 180x50` renders isolated app-harness evidence.

## Vertex Anthropic

Open `/connect google-vertex-anthropic` or `/connect Vertex Anthropic` for the public ADC form. The provider follows every existing choice, preserving shortcuts 1–9.

1. Fill in project, Claude location (default `global`), endpoint, token-variable name, quota project, metadata opt-in and versioned Claude publisher ids.
2. Use Tab to change focus only; no token input or OAuth flow appears.
3. Press Enter on the last field to explicitly enable, save and test.

The form uses the same bordered panel grid and header hints as Vertex Gemini. Failed tests preserve fields for `e` edit/`t` retry; `r` retains publisher ids and `m` opens models.

`/providers` shows ADC presence/routing and can turn the provider off. See [native behavior and external gaps](providers.md#vertex-anthropic-b1005).

Model rows use the catalog label for long Vertex Anthropic namespaces; the header retains the exact id. Compact role values end with an ellipsis when they need more space.

`bun scripts/render-frames.ts .agents-frames/B10.05 --b10-05 100x30 180x50` writes isolated app-harness evidence without contacting a provider.

## Mistral

Open `/connect Mistral` (or `/connect mistral`), following existing choices and preserving their shortcuts. The shared bordered grid shows a masked API-key input.

1. Enter the key, or use Ctrl+E to select the `MISTRAL_API_KEY` reference without reading/displaying it.
2. Press Enter to explicitly enable, save and test. Mistral stays off until this connection or another enable action.

| Key | After a test |
|---|---|
| `e` / `t` | Edit/retry failed tests. |
| `r` | Refresh chat models. |
| `m` | Open model selection. |

`/providers` shows state/key/endpoint/models; `e` toggles off immediately through the daemon. The custom endpoint form includes the `mistral` wire type. See [native behavior and external acceptance](providers.md#mistral-b1007).

`bun scripts/render-frames.ts .agents-frames/B10.07 --b10-07 100x30 180x50` writes isolated app frames, without real credentials or network.
## DeepInfra

Open `/connect DeepInfra` (or `/connect deepinfra`) for an optional endpoint override and the masked API-key form. Blank uses `https://api.deepinfra.com/v1/openai`. It follows all existing choices, preserving shortcuts 1–9.

1. Enter the key, or use Ctrl+E for `DEEPINFRA_API_KEY`. Tab only changes focus.
2. Press Enter to explicitly enable, save and test.

Reopening retains the public endpoint; the token field stays empty.

| Key | Does |
|---|---|
| `e` | Edit a failed test. |
| `t` | Retry. |
| `r` | Refresh. |
| `m` | Open namespaced models. |

`/providers` shows key presence, endpoint and model count; `e` disables immediately through the daemon. The existing shared bordered grid, header hints and compact single-column layout are preserved. See [provider behavior and external acceptance](providers.md#deepinfra-b1008).

`bun scripts/render-frames.ts .agents-frames/B10.08 --b10-08 100x30 180x50` writes isolated app frames.
## Perplexity

Open `/connect perplexity` (or `/connect Perplexity`), following the existing choices without moving shortcuts 1–9.

1. Optionally override the endpoint, default `https://api.perplexity.ai`.
2. Enter the masked Bearer key, or use Ctrl+E for `PERPLEXITY_API_KEY`.
3. Press Enter to explicitly enable and test.

Use `r` to refresh models and `m` to open model selection. `/providers` toggles or removes the configuration. See the [Sonar retirement note](providers.md#perplexity-sonar-compatibility-b1012).

`bun scripts/render-frames.ts .agents-frames/B10.12 --b10-12 100x30 180x50` renders isolated app-harness evidence.

## Alibaba

Open `/connect alibaba` or `/connect Alibaba` for an optional endpoint and the masked Bearer-key form. Alibaba follows existing choices without moving shortcuts 1–9.

1. Optionally set the endpoint; the default is the international DashScope compatible endpoint.
2. Enter the key, or use Ctrl+E for `DASHSCOPE_API_KEY`.
3. Press Enter to explicitly enable and test.

Use `r` to refresh models and `m` to open model selection. `/providers` shows connection details and supports test, refresh, live on/off and confirmed removal.

Panels and header hints follow the shared grid, with a single column below 70 cells. See the [provider policy](providers.md#alibaba-model-studio-b1013).

`bun scripts/render-frames.ts .agents-frames/B10.13 --b10-13 100x30 180x50` renders isolated app-harness evidence.

## OpenCode Zen

Open `/connect opencode`, `/connect OpenCode Zen` or `/connect zen` for the masked key form. Zen follows the existing choices without moving shortcuts 1–9.

1. Optionally set the endpoint, default `https://opencode.ai/zen/v1`.
2. Enter the key, or use Ctrl+E to reference `OPENCODE_API_KEY`.
3. Press Enter to explicitly enable, load proxy models, then test the first model. A failed refresh keeps the saved connection and skips testing.

| Key | Does |
|---|---|
| `r` | Refresh. |
| `t` | Test. |
| `e` | Edit. |
| `m` | Open model selection. |

`/providers` supports details, live on/off and confirmed removal. Panels use the shared grid and header hints; compact terminals below 70 cells use one column.

The [provider policy](providers.md#opencode-zen-b1015) describes formats, credential storage and the external console/account gap.

There is no "free models, no key" choice in this form. Zen refuses its free tier to any client but OpenCode's own (re-checked live 2026-10-17), so free models go through **OpenCode (free)** below.

`bun scripts/render-frames.ts .agents-frames/B10.15 --b10-15 100x30 180x50` renders isolated app-harness evidence.

## OpenCode (free)

OpenCode's free Zen models (`big-pickle`, `*-free`) answer only OpenCode's own client. A direct API call with no key gets `FreeTierError`, so the last `/connect` choice, **OpenCode (free)**, does not add a provider.

1. Select **OpenCode (free)** and press Enter. This adds your `opencode` CLI as the [ACP agent](acp-engine.md) `opencode` (`opencode acp`), with no form and no key.
2. Pick `acp:opencode`, OpenCode's default model, in `/model`.
3. After its first turn, choose from every model OpenCode offered: `acp:opencode/<model>`, such as `acp:opencode/opencode/glm-5.3-flash-free`. With `opencode auth login` done, these include your OpenCode providers too.

The agent is saved through the same `acpAgents` setting `/acp` edits. An `opencode` agent already set up is left as it is.

After the first turn on a model, its effort levels are offered too: `low`, `high`, `max` for `deepseek-v4.1-flash-free`. These use OpenCode's effort select ([ACP effort](acp-engine.md#effort)).

It needs `opencode` on the daemon's PATH (`pnpm add -g opencode-ai`). Requests go to opencode.ai under OpenCode's terms,
and the free tier is rate limited: OpenCode retries a limited call quietly, so a turn can sit without output; Esc stops it.
The turn runs on OpenCode's own tools and permissions, approved through MendCode's flow like any ACP agent.

## LLMGateway

Open `/connect llmgateway` or `/connect LLMGateway` for an optional endpoint and the masked Bearer-key form. LLMGateway follows existing choices without moving shortcuts 1–9.

1. Optionally override the endpoint, default `https://api.llmgateway.io/v1`.
2. Enter the key, or use Ctrl+E for `LLMGATEWAY_API_KEY`.
3. Press Enter to explicitly enable, load the gateway catalog, then test its first model. Failed refresh keeps the saved configuration and skips testing.

| Key | Does |
|---|---|
| `r` | Retry refresh. |
| `t` | Test. |
| `e` | Edit with an empty token field. |
| `m` | Open model selection after a successful test. |

`/providers` offers details, on/off and confirmed removal. Panels use the shared grid, with header hints and a single column below 70 cells. The [provider policy](providers.md#llmgateway-b1016) documents authentication and the external account gap.

`bun scripts/render-frames.ts .agents-frames/B10.16 --b10-16 100x30 180x50` renders isolated app-harness evidence.

## NVIDIA

Open `/connect nvidia` or `/connect NVIDIA` for an optional endpoint and the masked Bearer-key form. NVIDIA follows the existing choices without moving shortcuts 1–9.

1. Optionally override the endpoint, default `https://integrate.api.nvidia.com/v1`.
2. Enter the key, or use Ctrl+E for `NVIDIA_API_KEY`.
3. Press Enter to explicitly enable, load proxy models, then test the first model. A failed refresh keeps the saved configuration and skips testing.

| Key | Does |
|---|---|
| `r` | Retry refresh. |
| `t` | Test. |
| `e` | Edit with an empty token field. |
| `m` | Open model selection after a successful test. |

`/providers` offers details, live on/off and confirmed removal. Panels use the shared grid with header hints and a single column below 70 cells. The [provider policy](providers.md#nvidia-b1017) documents the defaults and the external account/service gap.

`bun scripts/render-frames.ts .agents-frames/B10.17 --b10-17 100x30 180x50` renders isolated app-harness evidence.

## SAP AI Core

Open `/connect sap-ai-core` or `/connect SAP AI Core`, following existing choices without moving shortcuts 1–9.

1. Enter the masked JSON service key from your SAP BTP instance, or use Ctrl+E to reference `AICORE_SERVICE_KEY`. JSON spaces are preserved.
2. Optionally set the AI Core API root, including `/v2`; otherwise it is derived from the key.
3. Optionally override deployment/resource-group fields instead of daemon environment defaults. Leave models blank to discover the tenant catalog.
4. Press Enter to explicitly enable, refresh, then test. A failed refresh skips testing.

| Key | Does |
|---|---|
| `r` | Retry refresh. |
| `t` | Test. |
| `e` | Edit. |
| `m` | Select a model. |

`/providers` supports details, live on/off and confirmed removal. Shared bordered panels, header hints and compact scrolling remain unchanged. [Credential and endpoint policy](providers.md#sap-ai-core-b1018).

`bun scripts/render-frames.ts .agents-frames/B10.18 --b10-18 100x30 180x50` renders isolated app-harness evidence.

## Zenmux

Open `/connect zenmux` or `/connect Zenmux`, following existing choices without moving shortcuts 1–9.

1. Optionally override the endpoint, default `https://zenmux.ai/api/v1`.
2. Enter the masked Bearer key, or use Ctrl+E to reference `ZENMUX_API_KEY`.
3. Press Enter to explicitly enable, load the catalog, then test its first model. A failed refresh skips testing.

| Key | Does |
|---|---|
| `r` | Retry refresh. |
| `t` | Test. |
| `e` | Edit with an empty token field. |
| `m` | Open model selection. |

`/providers` offers details, live on/off and confirmed removal. Shared bordered panels, header hints and single-column rendering below 70 cells follow the existing page. See [provider policy](providers.md#zenmux-b1019).

`bun scripts/render-frames.ts .agents-frames/B10.19 --b10-19 100x30 180x50` renders isolated app-harness evidence.

## GitLab

Open `/connect gitlab`, which adds GitLab after the existing choices without moving shortcuts 1–9.

1. Enter your required GitLab instance URL: HTTPS, gitlab.com or self-managed.
2. Enter the masked token, or use Ctrl+E to reference `GITLAB_TOKEN`. Optionally provide a GitLab Group ID for workflow discovery.
3. Save to explicitly enable, load the catalog, then test an agentic model. Failed discovery skips testing.

| Key | Does |
|---|---|
| `r` | Retry. |
| `t` | Test. |
| `e` | Clear the token for editing. |
| `m` | Open model selection. |

`/providers` shows the catalog, live on/off and confirmed removal. The form uses shared bordered panels, header hints and a single column below 70 cells.

`/model` selects `gitlab:duo-workflow-*` for native DWS streaming with local tool permissions. `/providers` shows namespace and workflow tools; no namespace uses the offline workflow catalog.

Numeric `projectId` can be supplied via `configureGitLab`/provider config. Repository auto-detection and browser OAuth remain unavailable. See [GitLab policy](providers.md#gitlab-b1020).

`bun scripts/render-frames.ts .agents-frames/B10.20 --b10-20 100x30 180x50` renders isolated app-harness evidence.

## Cerebras

Open `/connect Cerebras` or `/connect cerebras` for an optional endpoint and the masked API-key form. Cerebras follows all existing choices without moving shortcuts 1–9.

1. Optionally override the endpoint, default `https://api.cerebras.ai/v1`.
2. Enter the key, or use Ctrl+E for `CEREBRAS_API_KEY`. Tab changes focus only.
3. Press Enter to explicitly enable, save and test.

| Key | Does |
|---|---|
| `e` | Edit failures with an empty key. |
| `t` | Retry. |
| `r` | Refresh. |
| `m` | Open namespaced models/variants. |

Reopening retains only public connection fields. `/providers` offers details, live on/off and removal. The existing shared bordered grid, header hints and single-column layout below 70 cells are preserved. See [provider behavior and external acceptance](providers.md#cerebras-b1009).

`bun scripts/render-frames.ts .agents-frames/B10.09 --b10-09 100x30 180x50` writes isolated app frames.

## Cohere

Open `/connect Cohere` or `/connect cohere`, following all existing choices and preserving shortcuts 1–9.

1. Optionally override the Cohere v2 root, default `https://api.cohere.com/v2`.
2. Enter the masked Bearer key, or use Ctrl+E to reference `COHERE_API_KEY`. Tab only changes focus.
3. Press Enter to explicitly enable, save and test.

Reopening retains the public URL with an empty key.

| Key | Does |
|---|---|
| `e` | Edit failures. |
| `t` | Retry. |
| `r` | Refresh chat models. |
| `m` | Open namespaced model selection. |

`/providers` offers details, live on/off and confirmed removal. The existing shared bordered panels and header hints remain, with one column below 70 cells. See [native behavior and external acceptance](providers.md#cohere-b1010).

`bun scripts/render-frames.ts .agents-frames/B10.10 --b10-10 100x30 180x50` writes isolated app frames.

## Cloudflare Workers AI

Open `/connect cloudflare-workers-ai`, `/connect Cloudflare Workers AI` or `/connect cloudflare`. The provider is appended without moving existing numeric shortcuts.

1. Fill in the optional endpoint, masked Bearer token, Cloudflare account id and optional model ids. The account id is required unless you give a full endpoint.
2. To use an environment reference instead, press Ctrl+E for `CLOUDFLARE_API_KEY`; this clears typed credentials. Tab changes focus only.
3. Press Enter on the final field to explicitly enable, save and test.

| Key | Does |
|---|---|
| `e` | Edit. |
| `t` | Retry. |
| `r` | Retain the configured/offline catalog. |
| `m` | Select a namespaced model. |

Reopening keeps public routing/models and an empty token input. `/providers` shows account routing and supports live on/off and confirmed removal.

Shared bordered panels fill the page. Wide forms show routing beside the fields; terminals below 70 columns use one column. Hints stay in the page header. See [provider policy and external gap](providers.md#cloudflare-workers-ai-b1021).

`bun scripts/render-frames.ts .agents-frames/B10.21 --b10-21 100x30 180x50` writes isolated app-harness frames.

## Cloudflare AI Gateway

Open `/connect cloudflare-ai-gateway`, `/connect Cloudflare AI Gateway` or `/connect cloudflare gateway`. The choice is appended after existing providers.

1. Fill in the optional endpoint, masked gateway token, account and gateway ids, and `provider/model` ids. Account and gateway ids are required unless you give a full endpoint.
2. To use an environment reference, press Ctrl+E for `CLOUDFLARE_API_TOKEN` or `CF_AIG_TOKEN`; this clears typed credentials. Tab changes focus only.
3. Press Enter on the final field to explicitly enable, save and test.

| Key | Does |
|---|---|
| `e` | Edit. |
| `t` | Retry. |
| `r` | Retain the local catalog. |
| `m` | Open model selection. |

Reopening retains public routing/models with an empty token field. `/providers` shows metadata/cache-key presence and public cache/log options, and supports live on/off and confirmed removal.

Shared bordered panels, header hints and compact single-column layout apply. See [gateway policy and external gaps](providers.md#cloudflare-ai-gateway-b1022).

`bun scripts/render-frames.ts .agents-frames/B10.22 --b10-22 100x30 180x50` writes isolated app-harness frames.

## Kilo

Open `/connect kilo` or `/connect Kilo`, following all existing choices and preserving shortcuts 1–9.

1. Optionally override the endpoint, default `https://api.kilo.ai/api/gateway`.
2. Enter the masked Bearer key, or use Ctrl+E for `KILO_API_KEY`. Tab only moves focus.
3. Press Enter to explicitly enable, save, refresh the catalog, then test its first model. A failed refresh skips testing.

| Key | Does |
|---|---|
| `r` | Retry discovery and test on recovery. |
| `t` | Test again. |
| `e` | Edit with an empty token field. |
| `m` | Open namespaced model selection. |

`/providers` offers details, live on/off and confirmed removal. The existing bordered panel grid, header hints and single-column layout below 70 cells are preserved. See [provider policy](providers.md#kilo-b1023).

`bun scripts/render-frames.ts .agents-frames/B10.23 --b10-23 100x30 180x50` writes isolated app frames.

### Default effort per model (C7)

Open the variant page with `/variants`, or right after picking a model:

| Key or choice | Does |
|---|---|
| `d` | Save the highlighted effort or variant as that model's default. |
| `Default` | Remove the saved default. |
| `s` | Also save the choice as the `main` role, which new sessions start with. |

A model picked on the model page, the picker or with `/model <id>` without an effort starts with its saved default. An effort typed after the id wins.

Defaults live in `<dataDir>/tui/models.json` under `defaults` (`{ "<model id>": { effort?, variant? } }`), local like the favorites.

# Web search and image generation

Use `websearch` to find pages, `webfetch` to read them, and `image_gen` to generate or edit images. Search and image generation use the keys or subscription routes described below.

## Fetch PDFs and GitHub repositories

Explicit balanced/full `webfetch` modes provide these inputs:

| Mode | Does |
|---|---|
| `pdf` | Extracts up to 100 pages using an already installed `pdftotext`. PDF input is capped at 5 MiB; scratch is removed afterward. |
| `github` | Accepts public `owner/repo` identifiers for shallow scratch clones. Successful clones remain in the daemon data directory. |

Both require execute permission and daemon-only argument arrays with sandbox policy, isolated HOME and no inherited credentials.

| Command limit | Value |
|---|---|
| Deadline | 30-second deadline. |
| Output | 2 MiB output cap. |
| Scratch | Sampled 50 MiB scratch limit; temporary overshoot possible. |

Hooks, external/file git protocols and credential helpers are disabled. Content is untrusted and never executed.

- Peer turns cannot call webfetch.
- Disable resource ports with `/tier webfetch_modes off`.
- No account, dependency download or video support is added.

## Choose search and image routes

Web search is key-gated. Claude Code and ACP agents get both tools too, as `mcp__mendcode__webfetch` and `mcp__mendcode__websearch`, for the sites their own tools refuse ([Claude Code](claude-code.md)); Codex runs its own live web search. Image generation preserves key-gated API calls and adds independently configured subscription generation and captions.

### Search without an API key

With no search key and a ChatGPT login (MendCode's own or the Codex CLI's), `websearch` uses the subscription's search endpoint, the one the Codex CLI calls for its web tool.

This works with any session model because the tool runs in MendCode, not in the model's provider.

The subscription's hosted `web_search`, which the provider runs inside a response, is offered only when no `websearch` tool is registered. On 2026-10-08 it answered every request with a server error while the search endpoint kept working.

| Variable | Turns off |
|---|---|
| `MENDCODE_WEB_SEARCH=0` | Both search routes. |
| `MENDCODE_IMAGE_GEN=0` | Hosted `image_generation`. |

`websearch` and `image_gen` are ordinary function tools. The latter selects its own generation and caption models, independent of the active chat model.

### Key handling

The daemon reads environment keys when it starts. A key added later needs a daemon restart to register the tool.

Keys go only to the provider's own host, never to an event, log or error message. If a provider echoes the key in an error body, it is replaced with `***`.

## websearch (permission: read)

| Argument | Requirement |
|---|---|
| `query` | Required, at most 400 characters. |
| `numResults` | 1 to 10, default 5. |

The result is a numbered list of title, link, date when the provider gives one, and a snippet of at most 400 characters. The whole result is capped like every tool output.

The first configured provider wins:

| order | provider | key | call |
|---|---|---|---|
| 1 | Exa | `EXA_API_KEY` | `POST https://api.exa.ai/search`, header `x-api-key` |
| 2 | Brave | `BRAVE_API_KEY` | `GET https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token` |
| 3 | Tavily | `TAVILY_API_KEY` | `POST https://api.tavily.com/search`, bearer auth |
| 4 | OpenRouter web plugin | `OPENROUTER_API_KEY` (only when none of the above is set) | `POST {OPENROUTER_BASE_URL or https://openrouter.ai/api/v1}/chat/completions` with `plugins: [{ id: "web" }]` |

The OpenRouter plugin grounds a model's answer, so the results are the sources that answer cited. The model is `openai/gpt-4o-mini` unless `MENDCODE_WEBSEARCH_OPENROUTER_MODEL` names another one. It costs a short model call per search.

Timeout 25 s, cancelled with the turn. Use `webfetch` to read a result page.

## image_gen (permission: write)

| Argument | Use |
|---|---|
| `prompt` | Required. The tool description guides the model through scene or purpose, subject, details and constraints; exact text in quotes with font and placement; for edits, what to change and what to keep. |
| `transparent_background` | A transparent PNG for cutouts and icons. |
| `size` | `1024x1024` default, `1536x1024`, `1024x1536`. |
| `n` | 1 or 2. |
| `path` | Optional output path. |
| `referenced_image_paths` | Up to five absolute local paths. |
| `num_last_images_to_include` | 1–5 distinct recent session images. |

Never combine reference selectors. For a new image, omit both or use recent count 0.

- Missing references fail before a provider call.
- References are capped at 50 MB each.
- Local files pass read and external-directory permission checks before being read or transmitted; their identity is bound to the approval.

### Save generated images

With the setting absent, files are saved inside the project, by default `generated/<prompt-slug>-<n>.png`. The default name never overwrites: it takes the first free number.

An explicit `path` is resolved against the project. A path outside it, including through a symlink, is refused before any paid call.

- With `n=2`, an explicit path gets `-1` and `-2` before the extension.
- JPEG gets `.jpg`.
- Legacy API calls accept PNG/JPEG; configured adapters also accept WebP/GIF.

The result carries the saved paths as text and the images as `ToolResult.images` (at most two, each at most 5 MB; a larger file is saved and reported as too large to show).

The first configured provider wins:

| order | provider | key | model |
|---|---|---|---|
| 1 | OpenRouter | `OPENROUTER_API_KEY` | chat completion with `modalities: ["image","text"]` and an aspect ratio from `size`; model `google/gemini-2.5-flash-image`, override with `OPENROUTER_IMAGE_MODEL`. One call per image. |
| 2 | OpenAI Images | `OPENAI_API_KEY` | `POST {OPENAI_BASE_URL or https://api.openai.com/v1}/images/generations`, model `gpt-image-2.6-sunburst` (the configured and subscription default too; if the API refuses it, one retry with `gpt-image-2.5-sunburst`, named in the result), override with `OPENAI_IMAGE_MODEL`. `dall-e-*` models get `response_format: b64_json`, and `dall-e-3` one request per image. |

Timeout 180 s. If you have both keys and want OpenAI, unset `OPENROUTER_API_KEY` for the daemon (or pick another image-output model with `OPENROUTER_IMAGE_MODEL`).

### Independent configuration (B50.1)

Set `image_generation` through `settings.set` or the typed client helper. Settings apply at the next turn.

| Helper | Does |
|---|---|
| `imageGeneration(settings)` | Set the configuration. |
| `imageGeneration()` | Read it. |
| `imageGeneration(null)` | Clear it. |

### Enable generation and captions

| Session or setting | Behavior |
|---|---|
| Native session | Subscription generation requires explicit `enabled: true`; ChatGPT models have hosted `image_generation`. |
| [Claude Code](claude-code.md) session | An absent `enabled` counts as on while a ChatGPT login or a saved OpenAI provider key exists, since Claude Code has no image tool of its own. |
| Setting absent | Existing API-key selection remains. |
| `enabled: false` | Hide the tool entirely. |
| Captions | Require explicit `caption.enabled: true`. |

Subscription calls use MendCode's own ChatGPT login first, then the Codex CLI's.

```json
{
  "image_generation": {
    "enabled": true,
    "adapter": "codex-oauth",
    "model": "openai:gpt-image-2.6-sunburst",
    "timeout_ms": 180000,
    "options": { "quality": "high", "size": "1536x1024" },
    "caption": { "enabled": true, "model": "chatgpt:vision-model", "required": false, "max_chars": 2000 }
  }
}
```

### Models and options

`gpt-image-2.6-flare` is the faster variant; set it as `model`. A model you configure is never swapped. Model refs accept `provider:model` and v1 `provider/model`.

`options` go to the request as they are:

| Option | Values or behavior |
|---|---|
| `quality` | `low`, `medium`, `high`, `xhigh`, `max`, `auto` |
| `complexity` | `low`, `medium`, `high`; 2.6 |
| `background`, `output_format`, `output_compression`, `moderation` | As documented by the Images API, along with any other field it documents. |
| `options.size` | Override the three listed `size` values; both edges must be a multiple of 16, ratio at most 3:1. Otherwise `size` stays one of the three listed sizes. |

### Adapter selection

| Selection | Adapter |
|---|---|
| `auto`, OpenAI without API credentials | Codex OAuth. |
| `auto`, OpenAI with credentials | OpenAI-compatible. |
| `auto`, OpenRouter | OpenRouter's Image API. |
| Other providers | Require explicit `openai-compatible`. |
| Explicit `codex-oauth` | Keep using the subscription even when API keys exist. |

With no image model/key, enabled subscription generation defaults to `openai:gpt-image-2.6-sunburst`. Configured API providers retain their image model defaults.

### Credentials and request boundaries

Codex credentials are read from its login on each call without refreshing or rewriting that file. Its token can go only to the official ChatGPT backend or an explicitly configured loopback adapter; redirects are refused.

API adapters use saved provider credentials or the existing environment keys.

| Request setting | Behavior |
|---|---|
| `base_url` | Overrides the image base. |
| OpenRouter | Uses `/images`. |
| Codex | Uses `/images/generations` or `/images/edits`. |
| Compatible edits | Use multipart `image[]`. |
| `options` | Bounded provider generation parameters, never credentials, routing or references. |
| `timeout_ms` | 1–600000. |

### Configured output

Configured generation saves originals under `<dataDir>/generated_images`; an explicit `path` saves inside the project. Default filenames never overwrite.

- PNG/JPEG/WebP/GIF bytes are validated.
- Output/downloads are capped at 50 MB.
- Downloads never receive credentials.

Full TUI results use the shared bordered panel with saved paths, generation model and the actual optional caption. There is no inline raster preview.

### Captions

Caption calls use the independently selected native vision provider without tools or hosted tools. A model explicitly declared text-only is refused.

| Caption setting or outcome | Behavior |
|---|---|
| `caption.prompt` | Override the description request. |
| `max_chars` | Cap persisted text, 1–10000. |
| Optional failure | Report caption unavailable and retain the image. |
| `required: true` | Fail after saving the artifact and return its path. |
| Disabled captions | Make no model call. |

Local fake services cover these contracts. Account access and provider model availability still require live service verification.

Frames: `bun scripts/render-frames.ts .agents-frames/B50.1 100x30 180x50 --b50-1`.

### While an image is generated

While `image_gen` or the native engine's hosted `image_generation` runs, its card shows v1's wait canvas in every view, minimal too. It shows `Generating image` and the prompt over a bordered ASCII field, with the model and requested size below.

| Tool | Model and size rows |
|---|---|
| `image_gen` | Prints `model …` and `size …` before its request. |
| Hosted tool | Knows neither, so says `default image model` and `size auto`. |

A call waiting for approval keeps the plain header. When the call ends, the finished card replaces the canvas.

### Open a finished picture

In every view, a row under the finished picture describes the file and keeps v1's buttons: `PNG · 1.2 MB  open  folder  copy path`.

| Button | Does |
|---|---|
| `open` | Show the image in the system's viewer. |
| `folder` | Show it in its folder: Finder, Explorer, or the folder on Linux. |
| `copy path` | Put the path on the clipboard. |

`open` and `folder` use the daemon's `image.open`:

- Local clients only.
- The file must be a regular file whose bytes are a PNG, JPEG, GIF or WebP.
- A stored blob, named by its hash, opens through a copy with an extension in the system's temporary folder.

The path is `image_gen`'s saved file, the native hosted tool's stored blob, or the file a Codex session saved. A failed call has no row; a narrow screen drops buttons that do not fit.

Codex's own image generation saves the file itself and gets the same card: revised prompt, saved path and picture, stored like a native one. A failed or blocked call is an error card with Codex's reason.

### Canvas size

The canvas has the shape and cells of the picture it waits for. The finished picture uses the same box, so nothing jumps sideways or changes size; the finished card's `■ 1 image` line puts it one row lower.

With room available:

| Requested size | Canvas cells |
|---|---|
| `1024x1024` | 48 × 24 |
| `1024x1536` (portrait) | 32 × 24 |
| `1536x1024` (landscape) | 72 × 24 |
| Other `WxH`, or an aspect such as `16:9` | Keeps its shape inside 72 × 24. |
| `auto`, or no size yet | Square until a size arrives. |

Pixels become cells at the terminal's measured cell size, or 8 × 16 px when it reports none.

A narrow transcript (small terminal or sidebar open) or a short screen shrinks the box while keeping its shape. It never takes more than the screen's rows less 8 for the card's header, composer and footer. An 80 × 30 terminal draws a square at 44 × 22.

### Animation and presets

The field loops one of the built-in presets (`drops` by default, `cycle`, `constellation`, `orbit`, `pulse`, `scanner`) or your own frames, one frame per 280 ms. It moves with the busy pulse the app already runs while a turn works, so it adds no timer and stops when the call ends. Reduced motion (`MENDCODE_REDUCED_MOTION=1`, the setting, or screen-reader mode) and `imageWait: "static"` hold the first frame.

Use `/customize` → Image generation for these customize keys:

| Key | Values or effect |
|---|---|
| `imageWait` | `animated`, `static` |
| `imageWaitPreset` | Choose a preset. |
| `imageWaitSpeed` | ms per frame, 80–5000. |
| `imageWaitColor` | `mixed` accents the moving marks; also `accent`, `muted`. |
| `imageWaitMeta` | The model and size rows. |

Two more live in `<dataDir>/tui/profile.json`:

```json
{
  "imageWaitPreset": "fox",
  "imageWaitArt": [
    { "name": "fox", "frames": [[" /\\_/\\ ", "( o.o )"], [" /\\_/\\ ", "( -.- )"]], "fit": "contain", "align": "center" },
    { "name": "logo", "static": "MEND\nCODE" }
  ],
  "imageWaitCanvas": { "minWidth": 16, "maxWidth": 72, "minHeight": 8, "maxHeight": 24, "heightRatio": 1, "paddingX": 2, "paddingY": 1 }
}
```

Pick a user preset by its name:

| Preset field | Use |
|---|---|
| `frames` | Each frame is a string or a list of lines. |
| `static` | One static frame instead. |
| `fit` | `contain`, or `crop` to keep the middle rows, for frames sized differently from the field. |
| `align` | `left`, `center`, `right`, for frames sized differently from the field. |

Limits are 16 presets, 64 frames each, 48 lines of 160 single-cell characters. Escapes and controls are dropped.

### Canvas settings

`imageWaitCanvas` bounds the box of a generated picture, waiting or finished. The values in the example above are the defaults.

| Field | Effect |
|---|---|
| `maxWidth`, `maxHeight` | At most `maxWidth` × `maxHeight` cells. |
| `minWidth`, `minHeight` | The canvas alone grows to `minWidth` × `minHeight` where room allows, so very long or tall shapes stay legible. |
| `heightRatio` | Height over width assumed for `auto`: 1, square. |
| `paddingX`, `paddingY` | Field margins inside the border. |

A short box gives up padding first, then the model row, then the size row. A profile saved with unchanged earlier fixed-box defaults (`maxWidth` 52, `maxHeight` 16, `heightRatio` 0.45) gets these defaults.

## Limits

- OpenRouter image output depends on the model: one that returns no image gives an error naming `OPENROUTER_IMAGE_MODEL`.
- Local references require read permission; external-directory policy also applies. Remote references are not downloaded as edit inputs.
- Search results are only as fresh as the provider's index; the tool has no paging.
- Without independent configuration, the provider is chosen by existing keys. Explicit image configuration selects its own adapter/model.

The native engine can run `webfetch` as a persisted read job after explicit
`experimental.async_tools` opt-in. See [async tools and questions](async-tools.md).
## Explicit routes on demand

`/pet new` uses the same image API abstraction as `image_gen`, including OpenAI-key and Codex-subscription routes, but only after a local full-tier plan and explicit paid-call confirmation. It forces transparent PNG, medium quality and a fixed 1024×1024 provider canvas; post-processing stays local. See [custom pet generation](customize.md#experimental-custom-pet-generator) for estimates, budget reservations, unsupported output and the unverified owner-only real-provider checklist.

The optional `mendcode-web-routing` skill adds no default tools/listeners. `createWebRouting` in `@mendcode/tools` is an injectable daemon host helper: each HTTPS endpoint receives its own credential, destination approval and bounded query. Missing credentials fail before dispatch. Hosted fallback is off unless the caller supplies consent for the exact fallback endpoint/query disclosure; it gets a separate approval and never the primary credential. Secret markers, detected secrets and route keys are refused in queries; output is bounded/redacted and transport errors do not expose credentials.

The host must apply existing domain/network guards, client locality and normal approvals in `authorize`/`request`. This helper is not in the default webfetch tool; no provider is installed or selected automatically. Endpoint/provider choice and real credentials remain user decisions, with tests using injected local fakes.

# Web search and image generation

Explicit balanced/full `webfetch` modes: `pdf` extracts up to 100 pages using an already installed `pdftotext`; `github` accepts public `owner/repo` identifiers for shallow scratch clones. Both require execute permission and daemon-only argument arrays with sandbox policy, isolated HOME and no inherited credentials. PDF input is capped at 5 MiB and scratch removed afterward. Commands have a 30-second deadline, 2 MiB output cap and sampled 50 MiB scratch limit (temporary overshoot possible). Successful clones remain in the daemon data directory; hooks, external/file git protocols and credential helpers are disabled. Content is untrusted and never executed. Peer turns cannot call webfetch. Disable resource ports with `/tier webfetch_modes off`. No account, dependency download or video support is added.

Web search is key-gated. Claude Code and ACP agents get both tools too, as `mcp__mendcode__webfetch` and `mcp__mendcode__websearch`, for the sites their own tools refuse ([Claude Code](claude-code.md)); Codex runs its own live web search. Image generation preserves key-gated API calls and adds independently configured subscription generation and captions.

With no search key and a ChatGPT login (MendCode's own or the Codex CLI's), `websearch` uses the subscription's search endpoint, the one the Codex CLI calls for its web tool; it works with any model of the session, because the tool runs in MendCode, not in the model's provider. The subscription's hosted `web_search` (a tool the provider runs inside a response) is offered only when no `websearch` tool is registered: on 2026-10-08 it answered every request with a server error while the search endpoint kept working. `MENDCODE_WEB_SEARCH=0` turns both off and `MENDCODE_IMAGE_GEN=0` the hosted `image_generation`. `websearch` and `image_gen` are ordinary function tools. The latter selects its own generation and caption models, independent of the active chat model.

The daemon reads the keys from its environment when it starts (so a key added later needs a daemon restart to register the tool). Keys are sent only to the provider's own host, never written to an event, log or error message: a provider that echoes the key in an error body gets it replaced with `***`.

## websearch (permission: read)

Arguments: `query` (required, at most 400 characters) and `numResults` (1 to 10, default 5). Returns a numbered list of title, link, date when the provider gives one, and a snippet of at most 400 characters. The whole result is capped like every tool output.

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

Arguments: `prompt` (required), `size` (`1024x1024` default, `1536x1024`, `1024x1536`), `n` (1 or 2), `path` (optional), `referenced_image_paths` (up to five absolute local paths), or `num_last_images_to_include` (1–5 distinct recent session images). Never combine reference selectors; omit both, or use recent count 0, for a new image. Missing references fail before a provider call. References are capped at 50 MB each; local files pass read and external-directory permission checks before being read or transmitted, and their identity is bound to the approval.

With the setting absent, files are saved inside the project, by default `generated/<prompt-slug>-<n>.png`. The default name never overwrites: it takes the first free number. An explicit `path` is resolved against the project and refused, before any paid call, when it lies outside it, also through a symlink. With `n=2` an explicit path gets `-1` and `-2` before the extension. JPEG gets `.jpg`. Legacy API calls accept PNG/JPEG; configured adapters also accept WebP/GIF.

The result carries the saved paths as text and the images as `ToolResult.images` (at most two, each at most 5 MB; a larger file is saved and reported as too large to show).

The first configured provider wins:

| order | provider | key | model |
|---|---|---|---|
| 1 | OpenRouter | `OPENROUTER_API_KEY` | chat completion with `modalities: ["image","text"]` and an aspect ratio from `size`; model `google/gemini-2.5-flash-image`, override with `OPENROUTER_IMAGE_MODEL`. One call per image. |
| 2 | OpenAI Images | `OPENAI_API_KEY` | `POST {OPENAI_BASE_URL or https://api.openai.com/v1}/images/generations`, model `gpt-image-2` (the configured and subscription default too), override with `OPENAI_IMAGE_MODEL`. `dall-e-*` models get `response_format: b64_json`, and `dall-e-3` one request per image. |

Timeout 180 s. If you have both keys and want OpenAI, unset `OPENROUTER_API_KEY` for the daemon (or pick another image-output model with `OPENROUTER_IMAGE_MODEL`).

### Independent configuration (B50.1)

Set `image_generation` through `settings.set` or the typed client `imageGeneration(settings)` helper. `imageGeneration()` reads it; `imageGeneration(null)` clears it. Settings apply at the next turn. In a native session subscription generation requires explicit `enabled: true` (the ChatGPT models have the hosted `image_generation`); in a [Claude Code](claude-code.md) session an absent `enabled` counts as on while a ChatGPT login or a saved OpenAI provider key exists, since Claude Code has no image tool of its own. Subscription calls use MendCode's own ChatGPT login first, then the Codex CLI's. Captions require explicit `caption.enabled: true`. Existing API-key selection remains when the setting is absent; `enabled: false` hides the tool entirely.

```json
{
  "image_generation": {
    "enabled": true,
    "adapter": "codex-oauth",
    "model": "openai:gpt-image-2",
    "timeout_ms": 180000,
    "options": { "quality": "high", "size": "1536x1024" },
    "caption": { "enabled": true, "model": "chatgpt:vision-model", "required": false, "max_chars": 2000 }
  }
}
```

Model refs accept `provider:model` and v1 `provider/model`. `auto` selects Codex OAuth for OpenAI without API credentials, OpenAI-compatible for OpenAI with credentials, or OpenRouter's Image API for OpenRouter. Other providers require explicit `openai-compatible`. Explicit `codex-oauth` keeps using the subscription even when API keys exist. With no image model/key, enabled subscription generation defaults to `openai:gpt-image-2`; configured API providers retain their image model defaults.

Codex credentials are read from its login on each call without refreshing or rewriting that file. Its token can go only to the official ChatGPT backend or an explicitly configured loopback adapter; redirects are refused. API adapters use saved provider credentials or the existing environment keys. `base_url` overrides the image base; OpenRouter uses `/images`, Codex uses `/images/generations` or `/images/edits`, compatible edits use multipart `image[]`. `options` holds bounded provider generation parameters, never credentials, routing or references. `timeout_ms` is 1–600000.

Configured generation saves originals under `<dataDir>/generated_images`; an explicit `path` saves inside the project. PNG/JPEG/WebP/GIF bytes are validated, output/downloads capped at 50 MB, and downloads never receive credentials. Default filenames never overwrite. Full TUI results use the shared bordered panel with saved paths, generation model and the actual optional caption; there is no inline raster preview.

Caption calls use the independently selected native vision provider without tools or hosted tools. A model explicitly declared text-only is refused. `caption.prompt` overrides the description request; `max_chars` caps persisted text (1–10000). Optional failure reports caption unavailable and retains the image; `required: true` fails after saving the artifact and returns its path. Disabled captions make no model call. Local fake services cover these contracts; account access and provider model availability still require live service verification.

Frames: `bun scripts/render-frames.ts .agents-frames/B50.1 100x30 180x50 --b50-1`.

### While an image is generated

While `image_gen` or the native engine's hosted `image_generation` runs, its card (in every view, minimal too) is v1's wait canvas: `Generating image` and the prompt over a bordered ASCII field, with the model and requested size under it (`image_gen` prints `model …` and `size …` before its request; the hosted tool knows neither, so it says `default image model` and `size auto`). A call still waiting for its approval keeps the plain header. When the call ends, the finished card replaces the canvas. Under a finished picture, in every view, one row says what the file is and keeps v1's buttons: `PNG · 1.2 MB  open  folder  copy path`. `open` shows the image in the system's viewer and `folder` shows it in its folder (Finder, Explorer; the folder on Linux), both through the daemon's `image.open` (local clients only; the file must be a regular file whose bytes are a PNG, JPEG, GIF or WebP; a stored blob, named by its hash, opens through a copy with an extension in the system's temporary folder). `copy path` puts the path on the clipboard. The path is `image_gen`'s saved file, the native hosted tool's stored blob, or the file a Codex session saved; a failed call has no row, and a narrow screen drops the buttons that do not fit. A Codex session's own image generation (Codex saves the file itself) gets the same card: the revised prompt, the saved path and the picture, stored like a native one; a failed or blocked one is an error card with Codex's reason.

The canvas has the shape and the cells of the picture it waits for, and the finished picture is drawn in the same box, so nothing jumps sideways or changes size when it arrives (the finished card's `■ 1 image` line puts it one row lower). With room for it, `1024x1024` is 48 × 24 cells, `1024x1536` (portrait) 32 × 24 and `1536x1024` (landscape) 72 × 24; any other `WxH`, or an aspect such as `16:9`, keeps its shape inside 72 × 24. `auto`, and a call that has not said its size, is square until a size arrives. Pixels become cells at the terminal's measured cell size (8 × 16 px when it does not report one). A narrow transcript (a small terminal, the sidebar open) or a short screen shrinks the box, keeping its shape: it never takes more than the screen's rows less 8 (the card's header, the composer and the footer), so an 80 × 30 terminal draws a square at 44 × 22.

The field loops one of the built-in presets (`drops` by default, `cycle`, `constellation`, `orbit`, `pulse`, `scanner`) or your own frames, one frame per 280 ms. It moves with the busy pulse the app already runs while a turn works, so it adds no timer and stops when the call ends. Reduced motion (`MENDCODE_REDUCED_MOTION=1`, the setting, or screen-reader mode) and `imageWait: "static"` hold the first frame.

`/customize` → Image generation sets the profile keys `imageWait` (`animated`, `static`), `imageWaitPreset`, `imageWaitSpeed` (ms per frame, 80–5000), `imageWaitColor` (`mixed` accents the moving marks, `accent`, `muted`) and `imageWaitMeta` (the model and size rows). Two more live in `<dataDir>/tui/profile.json`:

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

A user preset is picked by its name; it has `frames` (each a string or a list of lines) or one `static` frame, and `fit` (`contain`, or `crop` to keep the middle rows) and `align` (`left`, `center`, `right`) for frames of another size than the field. At most 16 presets, 64 frames each, 48 lines of 160 single-cell characters; escapes and controls are dropped. `imageWaitCanvas` (the values above are the defaults) bounds the box of a generated picture, waiting or finished: at most `maxWidth` × `maxHeight` cells; the canvas alone grows to `minWidth` × `minHeight` where the room allows, so a very long or tall shape stays legible; `heightRatio` is the height over the width assumed for `auto` (1, square); `paddingX` and `paddingY` are the field's margins inside the border. A short box gives up the padding first, then the model row, then the size row. A profile saved with the earlier fixed-box defaults (`maxWidth` 52, `maxHeight` 16, `heightRatio` 0.45, nothing changed) gets these.

## Limits

- OpenRouter image output depends on the model: one that returns no image gives an error naming `OPENROUTER_IMAGE_MODEL`.
- Local references require read permission; external-directory policy also applies. Remote references are not downloaded as edit inputs.
- Search results are only as fresh as the provider's index; the tool has no paging.
- Without independent configuration, the provider is chosen by existing keys. Explicit image configuration selects its own adapter/model.

The native engine can run `webfetch` as a persisted read job after explicit
`experimental.async_tools` opt-in. See [async tools and questions](async-tools.md).
# Explicit routes on demand

`/pet new` uses the same image API abstraction as `image_gen`, including OpenAI-key and Codex-subscription routes, but only after a local full-tier plan and explicit paid-call confirmation. It forces transparent PNG, medium quality and a fixed 1024×1024 provider canvas; post-processing stays local. See [custom pet generation](customize.md#experimental-custom-pet-generator) for estimates, budget reservations, unsupported output and the unverified owner-only real-provider checklist.

The optional `mendcode-web-routing` skill adds no default tools/listeners. `createWebRouting` in `@mendcode/tools` is an injectable daemon host helper: each HTTPS endpoint receives its own credential, destination approval and bounded query. Missing credentials fail before dispatch. Hosted fallback is off unless the caller supplies consent for the exact fallback endpoint/query disclosure; it gets a separate approval and never the primary credential. Secret markers, detected secrets and route keys are refused in queries; output is bounded/redacted and transport errors do not expose credentials.

The host must apply existing domain/network guards, client locality and normal approvals in `authorize`/`request`. This helper is not in the default webfetch tool; no provider is installed or selected automatically. Endpoint/provider choice and real credentials remain user decisions, with tests using injected local fakes.

# Voice dictation (B14)

Speak into the prompt and review the words at the cursor before sending. Dictation works the same with MendCode's own engine, Claude Code, Codex, pi or an ACP agent.

1. Hold **space** on the prompt, as in Claude Code. Once the key repeats, the spaces it typed are taken back.
2. Wait for the red dot, then speak while holding the key. An amber dot and `starting… wait to speak` mean the microphone and speech model are still opening.
3. Let go. The words land at the cursor for review; nothing is sent by itself.

## Recording controls

| Control | Does |
|---|---|
| `/voice` or `ctrl+x v` (`voice.toggle`) | starts and stops the same recording without holding |
| `esc` | drops the recording |
| `/voice on` / `/voice off` | set `voice.enabled` |
| `/voice status` | shows provider, model and what is missing |
| `/voice language` | lists `auto` and every language the on-device model hears, by name |
| `/voice language es` | selects one language |
| `/voice language es en` | selects two at once; any other ISO code works with an API |
| `/voice start|stop|cancel` | explicit recording controls |

### Readiness and live transcript

The terminal asks whether dictation is ready on the first repeat of a held space; a space typed by hand asks nothing. This also builds the on-device helper in the background, so the first recording does not wait for the compiler.

While listening, a row over the prompt shows:

- A red dot and bars that move with your voice: `▁▂▃▄▅▆▇█`, newest on the right; `.:-=+*#` in an ASCII terminal.
- The clock, the words heard so far and how it stops.

If the transcript does not come back because the daemon stopped or the connection closed, the words already shown in the row become a prompt draft instead of being lost. An empty transcript falls back to them too. Only `esc` drops what was said.

## Where the words come from

### On this Mac

Apple's on-device speech model is the default on macOS 26 or later: free, no key, no setup, and no audio leaves the machine. `voice.provider: "local"` asks for it by name.

It is on without `/voice on` only in the full tier. Minimalist and balanced leave it off until `/voice on`; `/voice off` turns it off anywhere.

On first use:

- macOS asks for microphone access.
- A language may need its model downloaded by macOS; the helper waits up to 3 minutes.

With the language unset, it listens in the first two languages of System Settings > Language & Region at once. On a bilingual Mac that can be English and Spanish, each on its own model, about 19 MB for the helper.

It keeps the transcript the models are surer of. While listening, the row shows the running words of the model whose text reads as its own language: a model hearing another language spells its sounds in its own words. Words arrive about a second after they are said.

The region does not pick the model. English (Panama) hears with US English, not the Irish model Apple's own lookup returns.

| Choice | Result |
|---|---|
| `/voice language es` | listens with one named language alone |
| `/voice language es en` | hears the two named languages at once |

On macOS 26 the on-device model knows English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, Cantonese and eleven languages of India. For another language, use an API.

### An API

On Linux, Windows, when `provider` or `base_url` is set, or where the on-device model cannot run, the daemon uses an API:

1. It records a 16 kHz mono WAV under `<dir>/voice/` with the first installed recorder: `rec`/`sox`, then `arecord` on Linux or `ffmpeg` on macOS/Linux.
2. It uploads the finished clip to an OpenAI-compatible `POST <base>/audio/transcriptions`.
3. It deletes the file.

**Note:** The clip leaves the machine, so this stays off until `/voice on`. Bars stay flat because the level is not measured; words appear once the upload answers. On Windows only SoX works (best effort).

### Recording ownership

Only one recording runs at a time, owned by the connection that started it. A disconnect, `esc`, `/voice off` or daemon shutdown drops it.

## Setting

`settings.set {voice: {...}}` (or the config file), all fields optional:

| field | default | meaning |
|---|---|---|
| `enabled` | on for on-device dictation in the full tier, otherwise off until `/voice on` (always off for an upload) | master switch |
| `provider` | `local` on macOS 26+, else `openai` | `local` for the on-device model; any other id names the provider whose API key and base URL are used (`/connect`, `providers.json`, environment). Subscription logins (ChatGPT/Codex) are not API keys and do not work here |
| `model` | `gpt-4o-mini-transcribe` | transcription model (`whisper-1`, Groq `whisper-large-v3`, ...) |
| `base_url` | provider's | custom endpoint (HTTPS or loopback HTTP, no credentials/query), e.g. a local whisper server. Provider credentials go to it only if `provider` is also set; otherwise no auth header is sent |
| `language` | auto | ISO 639 code such as `es`, or two (`es,en`) heard at once on this Mac; an API gets the first as its hint |
| `max_seconds` | 60 | 5..300 |
| `timeout_ms` | 60000 | upload timeout |

## Telegram voice messages

With the [Telegram bridge](channels.md) on and `voice.enabled`, a voice message from a paired chat follows this sequence:

1. It is downloaded and transcribed.
2. The chat gets `Heard: ...`.
3. The text runs as an ordinary prompt, never as a `/command`.

Messages over 5 minutes or 20 MB are refused. With voice off, the chat gets `Could not transcribe: voice dictation is off`.

## Security

`voice.control` is local-only: remote and peer clients get `forbidden`. It is not a read-only command.

Keys never reach logs or errors; provider replies are scrubbed of the header values. The terminal never records or uploads by itself.

## Implementation

A small Swift helper (`packages/daemon/assets/dictate.swift`) is compiled once with Apple's Command Line Tools into `<dir>/voice/local/<hash>/`. It streams levels and the running transcript to the daemon, which relays them only to the terminal that records (`voice.live`).

| Code | Area |
|---|---|
| `packages/daemon/src/voice.ts`, `voice-local.ts` (+ `assets/dictate.swift`) and `voice-recorder.ts` | daemon recording and transcription |
| `packages/protocol/src/voice.ts` | protocol |
| `apps/cli/src/ui/app/voice.ts`, `apps/cli/src/view/voice-row.ts` | terminal dictation and row |

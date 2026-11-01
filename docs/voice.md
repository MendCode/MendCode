# Voice dictation (B14)

Speak into the prompt. Hold **space** on the prompt, as in Claude Code: once the key repeats, the spaces it typed are taken back, the microphone listens while it stays held, and the words land at the cursor when you let go (for review; nothing is sent by itself). `/voice` or `ctrl+x v` (`voice.toggle`) starts and stops the same recording without holding; `esc` drops it.

The row shows the moment the hold is noticed: an amber dot and `starting… wait to speak` while the microphone and the speech model open, then the red dot once they listen. The terminal asks whether dictation is ready on the first repeat of a held space (a space typed by hand asks nothing), which also builds the on-device helper in the background, so the first recording does not wait for the compiler. If the transcript does not come back (the daemon stopped, the connection closed), the words already shown in the row are put in the prompt as a draft instead of being lost; an empty transcript falls back to them too. Only `esc` drops what was said.

While it listens a row over the prompt shows a red dot, bars that move with your voice (`▁▂▃▄▅▆▇█`, the newest on the right; `.:-=+*#` in an ASCII terminal), the clock, the words heard so far and how it stops. It works the same whatever runs the session: MendCode's own engine, Claude Code, Codex, pi or an ACP agent.

- `/voice on` / `/voice off` set `voice.enabled`; `/voice status` shows provider, model and what is missing; `/voice language` lists `auto` and every language the on-device model hears, by name (`/voice language es`, or two at once: `/voice language es en`; any other ISO code works with an API); `/voice start|stop|cancel` are the explicit forms.

## Where the words come from

**On this Mac (default on macOS 26 or later).** Apple's on-device speech model hears the microphone: free, no key, no setup, and no audio leaves the machine. A small Swift helper (`packages/daemon/assets/dictate.swift`) is compiled once with Apple's Command Line Tools into `<dir>/voice/local/<hash>/` and streams levels and the running transcript to the daemon, which relays them only to the terminal that records (`voice.live`). The first use of a language may download its model (macOS does it; the helper waits up to 3 minutes for it). macOS asks for microphone access the first time. With the language unset it listens in the first two languages of System Settings > Language & Region at once (English and Spanish on a bilingual Mac, each on its own model, about 19 MB for the helper) and keeps the transcript the models are surer of (while listening, the row shows the running words of the model whose text reads as its own language, since a model hearing another language spells its sounds in its own words; the words arrive about a second after they are said); the region does not pick the model, so English (Panama) hears with US English, not the Irish model Apple's own lookup returns. `/voice language es` names one language and listens with it alone; `/voice language es en` names the two to hear at once. On macOS 26 the on-device model knows English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, Cantonese and eleven languages of India; for another language use an API. It is on without `/voice on` only in the full tier; minimalist and balanced leave it off until `/voice on`, and `/voice off` turns it off anywhere. `voice.provider: "local"` asks for it by name.

**An API (Linux, Windows, or when chosen).** With `provider` or `base_url` set, or where the on-device model cannot run, the daemon records the clip with the first installed recorder (`rec`/`sox`, then `arecord` on Linux or `ffmpeg` on macOS/Linux) into a 16 kHz mono WAV under `<dir>/voice/`, uploads the finished clip to an OpenAI-compatible `POST <base>/audio/transcriptions` and deletes the file. The clip leaves the machine, so this stays off until `/voice on`. Its bars stay flat (the level is not measured), and the words appear once the upload answers. On Windows only SoX works (best effort).

One recording at a time, owned by the connection that started it; a disconnect, `esc`, `/voice off` or daemon shutdown drops it.

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

With the [Telegram bridge](channels.md) on and `voice.enabled`, a voice message from a paired chat is downloaded, transcribed, echoed back as `Heard: ...` and run as an ordinary prompt (never as a `/command`). Over 5 minutes or 20 MB is refused; with voice off the chat gets `Could not transcribe: voice dictation is off`.

## Security

`voice.control` is local-only (remote and peer clients get `forbidden`) and is not a read-only command. Keys never reach logs or errors (provider replies are scrubbed of the header values). The terminal never records or uploads by itself.

Code: `packages/daemon/src/voice.ts`, `voice-local.ts` (+ `assets/dictate.swift`) and `voice-recorder.ts`, `packages/protocol/src/voice.ts`, `apps/cli/src/ui/app/voice.ts`, `apps/cli/src/view/voice-row.ts`.

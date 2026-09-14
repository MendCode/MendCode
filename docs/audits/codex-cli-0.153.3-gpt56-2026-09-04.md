# Codex CLI and OpenAI model audit — 2026-09-04

This audit records the upstream Codex CLI comparison used for the 0.1.43
release. The reference CLI stable release was `0.153.3` (`rust-v0.153.3`).
OpenAI's current model pages identify the flagship model as `gpt-6-astra` and
the 5.6 family as `gpt-5.6`/Sol, Terra, and Luna.

## Ported in 0.1.43

- Add `gpt-6-astra`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna` to the OpenAI catalog fallback. A stale cache or bundled
  `models.dev` snapshot no longer hides these models from the picker.
- Preserve live `models.dev` entries when they exist, so the fallback cannot
  replace newer provider metadata.
- Add API and ChatGPT OAuth presets with documented context limits and API
  prices. GPT-6 Astra keeps its 1.05M context/922K input limit; ChatGPT OAuth
  Sol, Terra, and Luna keep the existing 256K effective limit imposed by the
  Responses Lite adapter.
- Recognize Astra and its documented `fast` variant in the ChatGPT OAuth
  catalog. Astra stays on the standard Codex Responses transport; the current
  MendCode Responses Lite compatibility contract is limited to the 5.6 tiers.
- Keep the compact Commands history in the Ctrl+T horizontal widget tray,
  including its direct session-open action.

## Reviewed and intentionally not ported

- Upstream's asynchronous model-picker refresh (`5fc7840cf6d0`) is a larger
  TUI/server contract change. MendCode already refreshes `models.dev` in the
  provider service; this release adds the static safety net without changing
  picker lifecycle or selection state.
- Luna Reserve usage fallback, app-server collaboration-mode discovery, live
  context-compaction status, rate-limit banners, permission-profile discovery,
  startup warning condensation, automatic thread naming, and submission-ID
  steer acknowledgement were reviewed from the upstream history. Each needs a
  separate MendCode contract and regression surface, so none is represented as
  shipped behavior here.
- The upstream CLI version is not copied into MendCode's `version` request
  header. The existing `0.144.0` value belongs to MendCode's internal
  Responses Lite compatibility contract, and the upstream source contains no
  equivalent current header contract to justify changing it.

## Sources

- [OpenAI GPT-6 Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI GPT-5.6 Sol model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI Codex CLI releases](https://github.com/openai/codex/releases)

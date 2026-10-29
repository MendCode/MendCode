# Activity audio

The four WAV assets are preserved from legacy MendCode `v0.1.44`
(`234d4b6034085e1b78d5a73973c62ecc3150d09f`), under
`src/mendcode/packages/opencode/src/cli/cmd/tui/asset/`.
No v1 implementation or UI framework is imported.

`charge.wav` is the 3.35-second hum. The three one-second pulses rotate in
order. Playback applies PCM gain (hum 0.24; pulses 0.26–0.40) to cached copies
inside the explicit daemon data directory. Source WAVs are unchanged.

# Optional engines: withdrawn

The W9 OpenCode serve and Cursor SDK adapters have been removed, including their workspace packages, daemon registration API and tier features. Neither had an official SDK/type contract installed or vendored, a recorded real-protocol fixture, or a transport mapping interactive approvals to MendCode. Their handwritten ports and local fakes did not establish interoperability.

`/tier` no longer lists or enables `opencode` / `cursor`; neither adapter is available as an engine. New feature overrides are rejected. Existing saved overrides are ignored without discarding unrelated feature settings. Saved adapter model choices absent from the native catalog fail before a turn or compaction runs; select an available model explicitly or use a portable handoff. Model metadata remains readable for wire compatibility. The separate OpenCode Zen API provider remains available.

Reintroduction requires a pinned official protocol/SDK, a sanitized recorded fixture exercised offline, exact approval translation (or refusal before execution), daemon-only process launch with argument arrays, local-only execution and credentials owned by the external tool. It must remain opt-in, off by default and labelled `experimental` in `/tier` and `/engines` until verified against the real tool. Installing an SDK or using an external account remains an explicit host decision.

# MendCode prompt source snapshots

Tracked prompt snapshots used as evidence for provider-aware `mend prompts build --mode focus`.

Policy:

- Only OSS sources with clean Apache-2.0 licensing are copied here.
- OpenClaude and DeepSeek stay behavior-only until licensing is independently safe.
- Runtime must not depend on `/private/tmp/mendcode-harnesses`. That directory was a spike workspace only.
- MendCode adapts source prompts to preserve MendCode identity and must not impersonate upstream CLIs.

Metadata lives in `sources.json` with source repo, commit, license, copiedAt, source path, and bytes.

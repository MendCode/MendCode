# Release channels and experimental continuity

These features are under development. They are not available in the published v0.1.43 release.

## Update preferences

```sh
mendcode upgrade channel
mendcode upgrade channel set beta
mendcode upgrade --check
mendcode upgrade
mendcode upgrade 0.1.44-beta.1
mendcode upgrade --rollback
```

The explicit version above illustrates syntax; it does not claim that version has been published. Supported channels are `stable`, `beta`, and `nightly`. Existing installations default to stable. Changing the preference does not install anything. Installing an explicit version does not change the preference. The TUI `/release-channel` command edits the same backend preference.

Stable excludes prereleases; beta excludes nightly builds. Draft candidates are not offered to users. Channel selection does not choose a different session database.

The in-app updater requires a release index verified against the authorized GitHub workflow, and uses its pinned installer digest and artifact checksums. GitHub CLI must be available for attestation verification. Missing metadata, failed provenance and incompatible database schemas stop installation. Older releases without the required index cannot be installed through this new verification path.

`upgrade --check` reports the selected channel and retained operation/startup status without opening or migrating the session database. Download, verification, activation and startup are separate states. Installation alone does not mean the backend and TUI are ready.

The TUI, `run`, and `stats` share the local backend and its database writer. `run --attach` resolves models on the selected server without opening a local session database. A failed session or rejected request exits with a failure status. Other local database commands may still require closing the backend before use; the writer guard reports this explicitly.

Rollback retains sessions and never restores a database backup automatically. It requires verified metadata for the retained executable and a compatible database. Close connected terminals after their work finishes. Unknown legacy compatibility, an active backend or an incompatible schema blocks rollback. Windows rollback is not currently enabled.

## Experimental runtime

Merge these options into the existing MendCode configuration to enable individual capabilities:

```json
{
  "experimental": {
    "async_tools": true,
    "async_questions": true,
    "session_recall": true,
    "reasoning_auto": true
  }
}
```

All options default off, including in beta and nightly. Existing prompt modes remain `minimal`, `focus`, `full`, and `custom`.

- Async tools support built-in read, grep, glob and webfetch, retaining their permissions. Each session allows four active and eight queued jobs. Shell, mutations and arbitrary MCP tools are excluded.
- Async questions appear in Ctrl+T. The model can continue independent work while waiting for an explicit reply. Silence is never approval; tool authorization remains in the permission system.
- Recall tools page through the current session and linked descendants, including earlier compacted history. `session_notes` stores bounded, versioned working notes for the current session, with no global memory writes.
- Balanced Auto starts at a supported medium equivalent and can escalate to high after an explicit relevant verification or technical failure. It does not change model or service tier. Manual reasoning overrides Auto. The widget labels the actual last request, not a guessed current setting.

Disabling async options stops new work and cancels active continuations while retaining history. Reload the session to enable them again after disabling. Lost processes are marked interrupted after restart and are not automatically rerun.

OpenAI native async tool calling and WebSocket steering are not enabled. The current implementation uses MendCode's common executor and safe checkpoints. Live API/subscription parity and token savings have not been established.

# Unfinished-work audit — 2026-10-04

Scope: repository source, slash/CLI dispatch, protocol settings and tiers, tests, documentation, and the October 3–4
handoff entries. Base: `631d5ab`. Graft's existing graph was queried without refresh before removals; declarations,
callers and dynamic accesses were then checked directly in this checkout. Historical handoff statuses were not edited.
This is a source sweep plus directed local verification, not a full-suite or live-provider certification.

## Changes

| Item | Finished or removed | Test / evidence |
|---|---|---|
| Native cross-session `threads` read/search/wait | **Done:** target-specific `@thread` consent or individual approval in ask/smart/edits/full/plan; session answers narrowed to once | `engine-native/test/thread-consent.test.ts`: all modes, repeated calls, allow rules, saved grants, target isolation and denial |
| Permission-hook target rewrite | **Done:** recompute the gate for rewritten arguments; mentioned A cannot authorize B | `thread-consent.test.ts`: redirect refused without a second target's consent |
| Approval races | **Done:** cancellation, changed deny rules and disabled thread tools prevent execution | `thread-consent.test.ts`; `daemon/test/thread-mcp.test.ts` |
| External-engine thread MCP reads | **Done:** same individual gate for read/search/wait; full mode and session caching cannot bypass it | `daemon/test/thread-mcp.test.ts`: repeated calls in full/edits/plan, mentions and denial |
| Unmentioned merge-back | **Done:** individual consent as it imports another transcript; existing write/plan ceiling retained | `thread-consent.test.ts`; `daemon/test/threads.test.ts` |
| Official-package tier switches with no loader | **Done:** `official_packages`, `autoresearch`, `web_routing` now gate installed resources live, independently of stored disable preferences | `daemon/test/package-tier.test.ts`: tier/override matrix, real local install, command removal/restoration, unchanged preferences |
| Offline `storage_compact` switch | **Done:** persisted opt-out refuses preview and writes before database mutation | `daemon/test/storage-compact.test.ts`: exact original bytes, roundtrip and backup checks |
| Unused `USAGE_LIMIT_OPEN_STATES` | **Done:** shared state type and store validation use it; closed states cannot overwrite an open pause | `store/test/usage-pauses.test.ts`: invalid state preserves the existing pause |
| Notice-only Hono generation | **Removed:** no backend, help entry, completion or runtime notice branch; legacy flag is exit 64 before startup | `cli/test/b18-support.test.ts`: help/completions, subprocess with explicit temporary `--dir`, no database |
| Corrupt `--entry--keep-config` completion | **Done:** restored separate options in all completion formats | `b18-support.test.ts` |
| mDNS flags/config that never publish | **Removed:** CLI flags rejected, enabling config rejected before launch/write; false/domain wire fields retained for compatibility | `cli/test/http-cli.test.ts`, `daemon/test/http.test.ts`, `daemon/test/server-rest.test.ts` |
| Synthetic project spending state and budget defaults | **Removed:** init no longer writes them; actual daemon budget controls retained | `daemon/test/project-control.test.ts`: absence on fresh init and exact legacy preservation |
| Unread project memory/focus settings and generated focus files | **Removed:** init contains consumed metadata only; focus descriptions report actual native prompt inputs rather than fictitious reasoning/tool/worktree policies | `project-control.test.ts`: selector persists, models unchanged, legacy files preserved byte-for-byte |
| Blocked AI-config cascade/critic alternatives | **Removed:** recipes offer executable single-model bindings; inspector links actual `/compound` and `/compaction` contracts | `daemon/test/ai-config.test.ts`, `cli/test/ai-config.test.ts`: save/validate, no provider calls, alternative switching, bounded frames |
| ACP auxiliary-role gap documented as future work | **Done:** `acp:` choices refused outside main and skipped by auxiliary fallback; native reviewer validates its role too | `daemon/test/models.test.ts`: every non-main role, native fallback, main still allowed |
| Placeholder upgrade destination | **Removed:** empty/off default; explicit release repository required before network; legacy sentinel refused | `upgrade/test/upgrade.test.ts`: configuration, fake releases, verification, rollback |
| Windows persistent-service promise / incorrect socket error | **Removed:** help labels activation macOS/Linux only; unsupported manager fails with manual `daemon start|run` alternative and no mutation | `daemon/test/user-service.test.ts`: unsupported status/install, zero manager calls/files; launchd/systemd fake lifecycles |
| Ten unused exports/helpers | **Removed:** `COLORS`, `LIVE_MAX_ROWS`, `defaultActivityMascotConfig`, `spreadRow`, `compactionBlock`, `firstSentence`, `referenceOf`, `DEEPINFRA_BASE_URL`, `PRESET_KEY_ENVS`, `isAbort` | Graft callers plus direct references; TypeScript and CLI footprint checks |
| Stale behavior descriptions | **Done:** sessions, permissions, MCP, tiers, packages, storage, automation, HTTP config, upgrades, ACP and AI config describe the current contracts | Direct source comparison; corresponding checks above |

## Handoff reconciliation and conservative boundaries

| Item | Finished or removed / current limit | Test / evidence |
|---|---|---|
| October 3 local gaps: semantic memory, workflow gates/retry/history, session pause/stop, workspaces, interpreter syntax/stdlib | **Done in base:** concrete handlers/services are present; no duplicate implementation added | Current source inspected (`memory-consolidator.ts`, workflows, session control, workspace adapters, interpreter); their existing suites not rerun here |
| October 4 ACP bridge/child lineage, fork transcript sharing, token estimates, pi isolation, pending REST MCP approvals and pre-limit checkpoints | **Done in base:** later handoff entries supersede the earlier open list | Current bridge/policy, store transcript prefix, shared `estimateTokens`, pi policy and checkpoint sources; bridge tests run here, other unchanged suites not rerun |
| Simulated OpenCode/Cursor engines | **Removed in base:** retired selections are rejected; saved unrelated settings remain | Current optional-engine boundary and docs; unchanged retired-engine tests not rerun |
| Zstd dictionary | **Skipped as production compression:** Bun's installed API has no dictionary input and no new dependency is authorized. Ordinary zstd, content sharing and prefix experiments remain real and documented | Existing held-out dictionary experiment is explicitly experimental, with a binary-availability skip; not run here |
| Automatic 90% model compaction and M7 memory watcher | **Decided (2026-10-25):** the default compaction point is now 90% of the window or the window less the reply reserve, whichever comes first (Codex caps at 90%, pi keeps 16k free, opencode 20k or the output limit); an explicit `threshold`/`token_limit` is unchanged. No memory watcher: none of Codex, pi or opencode v2 runs a background model call over the session to write memories, so the bounded checkpoint/manual memory and Dream (scheduled, opt-in) stay the paths | `engine-native/test/compaction.test.ts`, `daemon/test/context-limits.test.ts`; [compaction.md](compaction.md) |
| Public releases, OAuth/accounts, cloud sharing, Telegram, microphone/editor integrations, provider and attestation canaries | **Partial:** existing opt-in/local boundaries retained, no external activation or account use; updater off until an explicit accessible repository is configured | Relevant configured/fake ports inspected; upgrade local fakes run; other account-dependent canaries not run |
| Ownership-sensitive uninstall, remote source downloads and cross-daemon sync | **Partial:** exact owned targets/local operations only; unsupported destinations, URLs or remote synchronization remain explicit refusals | Existing bounded local adapters and documented policies; unchanged suites not rerun |
| Conditional test skips | **Done audit:** every matched skip has a host/binary prerequisite, opt-in canary or fixture-generation reason. None removed or weakened | Direct inspection of Codex/browser/compiled/PTY/sandbox/rg/zstd/PowerShell/frame/fixture/performance guards |
| Legitimate placeholder/TODO matches | **Retained:** prompt hints, template substitutions, redaction markers, user todo lists and opt-in learning exercises are implemented behavior | Direct consumers checked; no executable TODO/FIXME/coming-soon stub found in the scanned runtime paths |
| TUI fields that appear unreferenced literally | **Retained:** role icons/labels/leads are read dynamically by transcript rendering; `showFooterContext` is a legacy wire key normalized to false and absent from customization | Direct calculated-key consumer and profile normalization; footprint/TUI automation pass |
| Public exports and kernel receipts | **Retained:** schemas/SDK exports are public boundaries; orchestration receipts are implemented kernel behavior, not an optional switch | Graft/source review; no public API removed merely for lacking an internal call |

Decisions: preserve additive wire compatibility, withdraw nonfunctional options, keep existing user files, and retain
explicit manual/opt-in behavior for unresolved platform/service policies. Official package permissions without a saved
tier preserve explicit existing installations; tiers do not install or execute packages. No new dependency was added.

Security: no change to `READ_ONLY_COMMANDS`, no new process/network capability, and no raw secret output. Thread history
remains bounded, redacted, same-project and unavailable to remote/peer clients. Native and MCP history approvals cannot
be converted into broad grants or settled by automatic reviewers. Tests use temporary directories and local fakes;
no provider, external account or real user runtime directory was used.

## Verification

Only new/changed tests plus the two requested CLI guards were run. Results by invocation (some files repeat after
relevant source changes):

| Files (paths relative to their package test directory) | Result |
|---|---|
| Engine-native `thread-consent`; daemon `threads`, `thread-mcp` | Final 44 pass, 0 fail |
| CLI `b18-support`, `http-cli`, `footprint`, `tui-automation`; daemon `http`, `server-rest`, `project-control`; upgrade `upgrade` | 96 pass, 0 fail |
| Daemon `package-tier`, `storage-compact`; store `usage-pauses` | 8 pass, 0 fail |
| Daemon `ai-config`, `user-service`; CLI `ai-config`, `footprint`, `tui-automation` | 35 pass, 0 fail |
| Daemon `project-control` after removing the remaining inert metadata | Final 7 pass, 0 fail |
| Daemon `models` | 9 pass, 0 fail |
| CLI `footprint`, `tui-automation`; daemon `ai-config` after the model fix | Final 18 pass, 0 fail |
| CLI `b18-support` after adding its help assertion | Pass, 0 fail |

These invocations cover **183 distinct tests in 18 files**, with no failures or skips. Required root typecheck:
`./node_modules/.bin/tsc -p tsconfig.base.json --noEmit` → **exit 0**. `git diff --check` → **exit 0**.
Full suites, standalone builds, `scripts/perf.test.ts`, disk-budget tests and live terminal/OS managers were not run
under the requested validation boundary; no fresh performance, disk-budget or physical-host acceptance is claimed.

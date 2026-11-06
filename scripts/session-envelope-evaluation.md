# Compact JSON envelopes reconstructed in JS — rejected product experiment

Baseline: a6a2ed17. The candidate removed sessionId/seq/type/at from stored JSON and rebuilt
protocol events in JS from SQL columns. Paged history, exact replay, sync, recall, permissions,
message revisions, forks, usage backfills, turn backfills, delta folding and maintenance were adapted.
Typecheck and 65 focused tests passed. Store suite: 273 pass, one disk-ratio failure because
full copies shrank while fork cost stayed 104857.6 bytes; the budget was not changed.

Five alternating runs per revision, isolated compiled faux daemons, 1000/10000-message sessions:

| Metric | Baseline median | Compact median |
|---|---:|---:|
| Allocated growth/session, bytes | 5734.40 | 4587.52 |
| CPU/turn, µs | 3663.98 | 3612.04 |
| Store read, ms | 0.072 | 0.079 |
| Daemon idle RSS, MB | 98.6 | 97.0 |
| Daemon loaded RSS, MB | 129.6 | 131.4 |
| Daemon ready, ms | 112.2 | 112.6 |
| Long-session first frame, ms | 129.6 | 144.2 |
| Stream p95, ms | 4.116 | 5.317 |

Store reads: baseline 0.068–0.073 ms, candidate 0.079 ms in all five runs.
Long-session first-frame ranges: 126.9–133.5 vs 143.5–161.4 ms.
Stream p95 ranges: 3.818–4.214 vs 5.248–5.596 ms.
Rejected for observed read/open/stream regressions. No compact payloads ship; no migration was enabled.

Compatibility: an earlier binary expects the envelope inside JSON. It cannot safely read compact
payloads: events lose type/session/sequence/time, breaking dispatch and historical operations.
A retained implementation would require downgrade refusal or an explicit lossless conversion back,
not merely a higher schema marker that old binaries ignore. Never open compact fixtures with old binaries.
The final retained product still uses complete JSON envelopes, with the existing delta-archive caveat.

Private evidence: envelope-product-ab.json, envelope-daemon-ab.json, envelope-product-rejected.patch,
envelope-targeted.log and envelope-store.log in the task evidence directory. No user transcript is included.

## Foreground transitions

Read-only measurement of the migrated copy found 93753 foreground events, 15153747 payload bytes,
and only one event repeating the preceding foreground state. session-actor already suppresses
unchanged states. Keeping only capture boundaries would omit 14876154 bytes of intermediate
transitions, including generating/tool/approval/cancelling/error. These are consumed by exact reconnect
and foreground reconstruction, not just compaction-facts. Rejected for behavior loss; no history removed.
Evidence: foreground-evaluation.json. The session-disk-probe fixture contains no foreground events,
so this change cannot lower its bytes/session even if historical fidelity were relaxed.

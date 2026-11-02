# Projection duplication evaluation

Retained product f61ebfda: 5570.56 allocated growth bytes per short/long fixture session; target below 4096 remains unmet.

DBSTAT, 100 short sessions; bytes/session are table/index allocated pages (not incremental growth) and cell payload:

| Object | Before allocated / payload | After delta lengths allocated / payload |
|---|---:|---:|
| events | 3440.64 / 2885 | unchanged |
| engine_messages | 1146.88 / 849 | unchanged |
| events_message_item | 655.36 / 390 | unchanged |
| folded_deltas | 655.36 / 329.11 | 491.52 / 196 |
| turns | 491.52 / 207 | unchanged |
| turns_seq | 163.84 / 65 | unchanged |
| turns_item | 163.84 / 94 | unchanged |
| usage_calls | 163.84 / 109 | unchanged |
| usage_calls_day | 163.84 / 45 | unchanged |

Five alternating read-query experiments on an offline copy:

- usage_calls projection vs all corresponding fields extracted from events: 7133 calls, median 8.081 vs 69.845 ms. Reject deriving the projection. This is SQL read evidence, not an integrated daemon A/B of a removed projection.
- turns_item removed in a rolled-back transaction: median .000789 vs .006381 ms/query. It serves completion/revision writes and item lookup. Reject removal.
- turns_seq removed in a rolled-back transaction: median .003105 vs .022657 ms/query. It serves ordered history/ranges. Reject removal. Initial NOT INDEXED results were invalid because SQLite can still use indexes for WITHOUT ROWID tables; actual DROP INDEX transactions establish the result.
- Preview derivation: correlated query experiments timed out (120s, then 10s); not a viable implementation. Independent indexed item lookup, both routes warmed, five pairs of 1000 queries: stored preview median 2.261 ms, range 2.210–2.349; event lookup median 3.325, range 3.217–3.387. This is a lower bound: decoding, revisions, whitespace normalization and Unicode truncation remain additional work. Reject this derivation, not every possible preview representation.

No product change in this step; engine_messages left untouched. No claim of achieving Pi's short-session target or proving it impossible.

Evidence before the additional filesystem restriction: ~/.mendcode-v2/task-evidence/session-delta-fold/projection-dbstat-evaluation.json. Evidence after restriction: /tmp/mend-session-disk-yoiBbi/{indexes-ab.json,preview-point-ab.json,preview-warm-ab.json}. No new writes to the real data directory after that restriction; no installation or restarts of user processes.

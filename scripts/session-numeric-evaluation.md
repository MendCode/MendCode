# Direct numeric session keys — rejected product experiment

Baseline: a6a2ed17. Five alternating runs per revision, identical session-disk-probe fixture.
The experiment implemented numeric_events/session mapping, direct writes and paginated reads,
all physical SQL consumers, and bounded transactional idle migration with active-session protection.
No write triggers. A read-only union reconciled legacy/numeric rows during incremental migration.
Migration rollback/restart/cascade tests passed; typecheck and focused fork/reader tests passed.

| Metric | Baseline median | Numeric median |
|---|---:|---:|
| Allocated growth/session, bytes | 5734.40 | 5242.88 |
| CPU/turn, µs | 3904.64 | 4032.59 |
| Store read, ms | 0.073 | 0.088 |
| Daemon idle RSS, MB | 98.5 | 97.7 |
| Daemon loaded RSS, MB | 132.3 | 131.4 |
| Daemon ready, ms | 110.8 | 119.4 |
| Long-session first frame, ms | 145.0 | 145.8 |
| Stream p95, ms | 5.626 | 5.904 |

Store read ranges: baseline 0.069–0.074 ms; numeric 0.087–0.091 ms. A revised no-legacy
page route still measured 0.085 ms, and required numeric ownership transfer on parent deletion.
Rejected: the observed read regression is outside noise. Favorable standalone SQL results do
not establish product acceptance. This rejects this integrated design, not every possible numeric design.
No budgets changed; no numeric schema ships. Old binaries were never run against numeric fixtures.

Private reproducible evidence (not transcript contents): numeric-product-ab.json,
numeric-daemon-ab.json, numeric-fast-probe.json, numeric-product-rejected.patch,
numeric-events-rejected.ts and numeric-events-rejected.test.ts in the task evidence directory.

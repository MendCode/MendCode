# String-sliced envelopes v2: rejected integration

Base product: 3fb96daa (runtime identical to a6a2ed17). No format enabled in retained product.

Implemented prefix slicing after packEvent and a single string reconstruction helper before parseEvent; adapted all readers from the prior experiment and preserved mixed legacy fork identities. No additional JSON parse/stringify on streaming writes. Exact string comparison over the private original backup: 1,953,057 visited, 1,953,057 compactable, zero mismatches. Typecheck and 28 focused tests (143 assertions) passed.

Five alternating source-store pairs: short allocated growth 5734.40 → 4587.52 B; median read .077 → .086 ms, base range .072–.078, candidate .081–.088. CPU/turn 4068.71 → 4205.43 µs (base 3972.25–4274.32). This integration fails the no-read-regression criterion even without the previous redundant serialization.

Five alternating daemon pairs with BOTH binaries freshly rebuilt: long first frame 145.1 → 144.7 ms (base 141.9–152.5); short stream p95 5.570 → 5.783 ms (base 5.502–6.010); client RSS 171.5 → 171.0 MB (base 168.9–172.6); daemon idle 98.1 → 97.2 MB; loaded 125.2 → 124.0 MB. No demonstrated regression in these metrics. An earlier run against an older compiled baseline produced a large client RSS difference and is INVALID for acceptance; rebuilding the base removed it. This also limits causal conclusions from the earlier envelope daemon experiment.

Decision: remove this product integration for measured store read regression, not because envelopes are intrinsically slow. No format marker, idle envelope migration, downgrade guard or installer changes retained/implemented: the format is not accepted or enabled. These requirements remain prerequisites for any future accepted envelope integration, not completed features. No migrated-copy physical size claimed for this variant.

Private evidence: ~/.mendcode-v2/task-evidence/session-delta-fold/{envelope-v2-exact.json,envelope-v2-disk-ab.json,envelope-v2-daemon-fresh-ab.json,envelope-v2-product.patch}. Rejected tests moved to ~/.Trash/session-envelope-v2-rejected. Original backup and live database untouched.

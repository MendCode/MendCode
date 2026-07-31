Last release: v0.1.22
Target ref: v0.1.23

## Loop Workflows

- Added scheduler health and wake metadata, retry/backoff state, run leases, completion state, and safer CLI/API reporting for durable loops.

## Context and compaction

- Set GPT-5.6 ChatGPT OAuth models to a 256K effective input/context limit and a provider-aware 90% compaction threshold.
- Improved compaction summaries and local transcript continuity across live updates, reconnects, and resumed work.

## TUI reliability

- Improved session synchronization, virtual transcript windows, Changes Review rendering, setup copy, and smart permission review state.
- Added focused regressions for loop lifecycle, session layout, compaction, provider adapters, and permission paths.
- Fixed cross-platform release smoke tests to validate the public `Usage:` help header.

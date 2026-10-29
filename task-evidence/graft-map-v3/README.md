# Code map v3 evidence

Generated and inspected on 2026-10-04 in `night/map-polish`. These are transcript-renderer text frames, not live-terminal captures. The requested shared output directory `.agents/runs/frames/graft-map-v3/` is outside this runtime's writable roots; the 15 frames are kept here for handoff.

```sh
GRAFT_MAP_FRAMES=1 GRAFT_MAP_FRAMES_DIR="$PWD/task-evidence/graft-map-v3" bun test apps/cli/test/code-map.test.ts apps/cli/test/footprint.test.ts apps/cli/test/tui-automation.test.ts
./node_modules/.bin/tsc -p tsconfig.base.json --noEmit
```

- Tests: 55 passed, 1 failed. Code map (46 tests) and footprint (9 tests) passed. TUI automation could not open its temporary Unix socket: `Bun.listen` returned `EPERM` before the flow ran. No full suite was run.
- Typecheck: exit 0. `git diff --check`: exit 0.
- All 15 filenames and dimensions match v2: five cases at 60x20, 100x30 and 180x50. The generation test checks row widths, frame heights and absence of ANSI escapes.
- Inspected all frames against v2. All five 60-column frames and all search frames are byte-identical. The 180-column callers frames are also byte-identical.
- At 100 columns, balanced callers now keep `chat-transcript.test:7` and `tool-card-sessions.test:2` before callee suffixes. Expanded callers retain `chat-transcript.test:7`; the longer suffix cannot fit. Full detail retains names and the caller suffixes that fit, rather than truncating any file suffix.
- Graft trace at 100 columns now retains `transcript:399`; at 100 and 180 columns its single direct callee has a two-dash arrow. Hanging descendants retain their indentation. The unit regression also checks single callers and ASCII connectors.
- No network, providers, user data directories, new dependencies, daemon/tool permissions or tier changes. Only the existing CLI view changed.

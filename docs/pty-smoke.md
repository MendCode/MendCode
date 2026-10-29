# Terminal smoke

Run `bun scripts/pty-smoke.ts` on macOS or Linux with Bun 1.3.13 or later. It builds the shipped CLI and daemon through the same `compiledTarget` as `scripts/perf.ts`, opens a native OS PTY, and sends bracketed paste, Enter, approval, scroll and resize keys. No terminal emulator dependency is installed.

The harness owns a temporary HOME, data directory and project. Both processes receive an explicit `--dir`, the daemon uses `--engine faux --local-only --pure`, and the environment excludes credentials, provider configuration and proxies. Only the local Unix socket is used. The observer reads that temporary daemon's events to wait for completion; interactions themselves go through the PTY. The fixture graft result does not launch graft or MCP, and the usage limit does not call a provider. `@thread` references only the temporary seeded session.

Frames default to `captures/pty-smoke/` (ignored by Git). Use `--frames /path/to/frames` for an authorized evidence directory, including `.agents/runs/frames/pty-smoke` in the main checkout when writable. Each text frame has the terminal's exact row and cell dimensions. The receiver applies cursor movements, differential updates, erases and wide characters; unsupported escape sequences fail rather than silently corrupt evidence. `result.json` records completed runs. A failed scenario keeps its frame and exits nonzero. All child processes and temporary data are removed in `finally`.

The full script contains scenarios for home, a new chat, streamed output, approval, all three tier bundles and their `/tier` panels, pulse cards, a synthetic graft trace with expanded tools, 60×20 / 100×30 / 180×50 resize, manual compaction and its memory panel, an expanded `@thread` snapshot, a queued message and `/queue`, usage-limit pause in rich and minimalist views, and a seeded long transcript with Page Up / Home / End. Faux compaction is deliberately skipped: this checks its real panel, not the native summarization engine. `--short` checks home, streaming, approval and clean exit. Faux triggers are typed with a trailing space to avoid path-paste detection and slash/mention completion; actual slash commands use bracketed paste. Tier waits match the applied notice, not the text still in the prompt. Home loads earlier event windows while keeping the reader's anchor, so the harness repeats Home until message 0 appears. Resize explicitly sends `SIGWINCH` after updating the PTY size.

`--panel-review [--tiers full,balanced,minimalist] --frames <evidence-dir>` drives `/panel` against the fresh compiled daemon at 60×20, 100×30, 180×50 and 220×60: from home and from a session with activity (`/faux-activity`: read/edit/write tools with declared paths, a todo list, one timed call, plus a running tool and a queued message) it runs the bare command, `next` through the whole cycle, each preset, galaxy focus, `/panel off`, the toggle key, the hidden `/sidebar` aliases and `/panel edit`, and checks the saved profile and a restarted client. Minimalist asserts every refusal; balanced asserts the galaxy refusal keeps the previous preset. It cannot create sub-agents (the faux engine has none), so lineage and agents rows are covered by the app harness only.

`--tui-bugs --frames <evidence-dir>` runs the full-tier flow at 100×30 and 200×60 with a temporary
fixture pet. It adds fragmented/empty text paste, an image-path chip, settings previews and changes,
and a faux question alongside approval, queue, limit and side-sheet frames. `PTY_TUI_BUGS=1
PTY_SMOKE_FRAMES=<evidence-dir> bun test scripts/pty-smoke.test.ts` selects this regression flow.
PTY uses half-block pets; focused app regressions also verify image placements and intact request
backgrounds. Neither test claims graphical Ghostty or real-provider verification.

`bun test scripts/pty-smoke.test.ts packages/engine-faux/test/smoke.test.ts` runs the short compiled smoke plus receiver and native PTY renderer checks. If OS socket listening is denied with EPERM/EACCES, only the integrated test is explicitly skipped; renderer checks still exercise native TTY input and all three resizes. Other failures are not skipped. This skip is missing integration evidence, not acceptance.

For a full test run, set `PTY_SMOKE_FULL=1`. `PTY_SMOKE_FRAMES=/path/to/frames` preserves full-run frames and separate `renderer-*` PTY frames. Tests otherwise use temporary evidence directories. `failure.json` records blocked or failed runs without claiming a completed scenario.

## Final regression matrix

`bun scripts/pty-smoke.ts --matrix --frames <evidence-dir>` builds once and runs the complete flow at 60×20, 100×30 and 180×50 in each tier, twice: the Mend palette and the terminal palette with ASCII prompt borders. The 18 cases retain `.txt` cell grids and `.ansi` cell/style snapshots, with per-case results and `matrix.json`. ASCII cases reject extended colour escapes. These native PTY snapshots can be rendered for visual inspection; they are not screenshots of a graphical terminal emulator.

Matrix coverage adds both right-bar presets and their scroll state, pending MCP approvals, `/tree`, empty and two-hunk `/changes replay`, `/extensions`, all six `/usage` tabs, all three `/context` tabs, `/pr` and `/acp`. Usage and context come from stateless faux fixtures; replay is seeded only in the temporary store. The pending MCP command is disabled and never started. PR watching and ACP connections remain unconfigured. Minimalist intentionally keeps the raw code trace and refuses right-bar presets; balanced/full render the map and cards.

Final regression fixes wrap minimalist approval actions and the empty quota explanation, clear stale notices on the next built-in slash command, and include hidden-card header space when deciding whether to show the right-bar scroll hint. Each has a focused regression test. The matrix does not verify real providers, external PR/ACP services, an MCP connection, or native compaction summarization.

The final matrix on 2026-10-04 passed all 18 cases (780 frames, visually reviewed) with CLI exit 0 in each case. The changed test files plus footprint and TUI automation passed 78 tests with zero failures; root typecheck exited 0. Run records and styled captures are under `.agents/runs/frames/pty-final/verified/` in the main checkout, with scope and limitations in `pty-final/review.md`.

## Verified full run — 2026-10-04

The socket restriction is lifted. The full compiled CLI/daemon run passed on macOS arm64 / Bun 1.3.13: 28 flow frames, 52 streamed deltas, seven completed turns and CLI exit 0. All scenarios above passed, including graft at each size and the 120-message transcript through its first and last request. Frames and `result.json` are in the authorized main-checkout `.agents/runs/frames/pty-smoke/`; native `renderer-*` frames are separate. Earlier failure artifacts are retained under `previous-failures/`.

Three product defects were reproduced before their regression tests passed:

- The narrow panel sheet overlaid the latest transcript and request/limit chrome. It now reserves layout rows, retains at least six transcript rows when space permits, and places prompt cursors and request hit targets after the sheet.
- Pasted built-in slash commands were treated as absolute attachment paths. Recognized commands now remain prompt text; explicit paths still go through the daemon attachment handler.
- `@thread` collided with MCP's `@server:resource` syntax and failed with `unknown MCP resource`. The thread namespace is reserved, and only the original submitted text grants MCP reads; attached snapshots cannot cause additional resource reads.

Verification: `PTY_SMOKE_FULL=1 PTY_SMOKE_FRAMES=<evidence-dir> bun test scripts/pty-smoke.test.ts apps/cli/test/right-sheet.test.ts apps/cli/test/slash-paste.test.ts packages/daemon/test/mcp-content.test.ts apps/cli/test/footprint.test.ts apps/cli/test/tui-automation.test.ts` — 26 pass, zero fail/skip. Root `./node_modules/.bin/tsc -p tsconfig.base.json --noEmit` — exit 0. No full suite, provider calls, real graft/MCP process, native compaction summary, or reset-time provider continuation was exercised.

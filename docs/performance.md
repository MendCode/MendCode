# Performance budgets

The [README measurement record](../README.md#measurements) is a dated checkout-specific run,
not the historical baseline below. On 2026-10-04 the restricted host refused `ps` with `EPERM`,
so `bun scripts/perf.ts --check` could not collect RAM or frame results. A separate call to
the exported `compiledTarget` and `measureCliStartup` measured compiled help startup (five
launches, temporary HOME/data); it does not establish the remaining performance budgets.

Reproduce the isolated help measurement without process inspection:

```sh
bun -e '
import { compiledTarget, measureCliStartup } from "./scripts/perf"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
const dir = mkdtempSync(path.join(tmpdir(), "mend-readme-startup-"))
try { console.log(await measureCliStartup(await compiledTarget(dir))) }
finally { rmSync(dir, { recursive: true, force: true }) }
'
```

`bun scripts/perf.ts` is the repeatable benchmark of the terminal client and the daemon. It builds the compiled binary (the flags of `bun run build`), seeds a session of N messages through the real store, starts the real daemon on the offline faux engine with a throwaway `HOME`, and runs the terminal client against it in a fresh process. Nothing touches `~/.mendcode*`, the network or a provider.

```
bun scripts/perf.ts [--messages 0,1000,10000] [--scroll-presses 120] [--mode daemon,solo] [--exec-argv FLAGS] [--source] [--check]
```

JSON goes to stdout, a table to stderr. `--check` exits 1 when a budget is exceeded. `--scroll-presses` pages up that many times (1,500 reaches the top of 10,000 messages); `--exec-argv` bakes Bun runtime flags into the compiled binaries to measure them. `--source` measures the same code under `bun` instead of the compiled binary; it loads every zod locale (the daemon reads about 165 MB instead of 120), so use it only to compare source changes quickly.

## What is measured

| Measure | How |
|---|---|
| Daemon RSS | `ps` on the daemon process: idle (no client) and with the client attached and reading |
| Client RSS | the client process after start-up (idle), after paging through the whole history, and after streaming an answer; JS heap is reported beside it |
| Messages | 0, 1,000 and 10,000 (user and agent alternating, markdown with lists and code) |
| Start-up | app module graph import, first drawn frame, `help` end to end (median of 5), daemon printing its socket |
| Frame time | p50, p95, max of one frame: idle redraw, page up and page down through the history, one streamed delta (400 deltas, about 18 KB). The real differential screen encodes each frame into a byte counter |

The probe (`scripts/perf-client.ts`) wires the client like `apps/cli/src/main.ts`: real `@mendcode/client`, `createApp` and `createScreen`. Frames are drawn on demand, one per event, which is the worst case; the real renderer coalesces events inside 16 ms.

Memory is reported twice. RSS (`ps`) counts the binary's clean code pages and pages the kernel can drop or compress, so it moves between identical runs (the real CLI's client RSS 60 s after a reply ranged from 55 to 85 MB while its footprint stayed within 29 to 33 MB). On macOS `scripts/perf-proc.ts` also reads the physical footprint, its lifetime peak and the CPU time of a process (`proc_pid_rusage` through `bun:ffi`, nothing installed); the probe and `scripts/perf.ts` print the footprint beside the RSS, and on Linux only RSS and CPU are available. Compare builds with the footprint and the CPU.

Three more scripts, none of them budgeted, measure what the probe cannot:

| Script | What it measures |
|---|---|
| `bun scripts/perf-real.ts --binary PATH` | The real CLI in a pseudo-terminal against a separate faux-engine daemon: time to the first frame and until a typed key shows in the prompt, key-to-echo latency (before the reply and after the idle minute), client and daemon CPU while an 18 KB reply streams and during 60 s at rest, frames and bytes written per reply, memory after boot, after the reply and after the idle minute, and the time Ctrl+X q takes to exit. `--scenario startup --runs N` only repeats cold launches; `--scenario clients --clients 1,2,4,8` attaches that many terminals (each its own project and session) to one daemon and reports memory per count; `--focus unfocused` sends a focus-lost report before the reply |
| `bun scripts/perf.ts --build-to DIR`, `--prebuilt DIR` | Builds the CLI and the probe once into `DIR`, and runs the probe on those binaries, so builds can be compared without compiling again |
| `bun scripts/perf-ab.ts --a DIR --b DIR --out DIR` | Alternates two prebuilt builds over N pairs (order swapped every other pair), runs the real-CLI session and the probe, and prints each metric's median and range per build, flagging a median outside the other build's range. Raw runs stay in `--out` (keep it outside the repository) |

Reading the A/B tables: a flag on a metric whose code did not change (a scroll frame after a change to streaming) is the noise of five runs; repeat that metric before believing it. The exit time after a long session is bimodal on this machine (about 9 or 23 ms in both builds); the exit time of a cold launch is a stable 9 ms.

## Attribution A/B (`scripts/perf-attrib.ts`)

The macOS footprint of a whole process moves 5 to 10 MB between identical runs (after a reply: a 8.7 MB spread over six runs of one build), so a 2 MB difference needs a dozen rounds per side and still does not say what grew. `perf-attrib` measures the parts, most of which do not move between identical runs, in one session per side on the offline faux engine (no login, no network, throwaway HOME and data):

```
bun scripts/perf-attrib.ts --base REF|BINARY --cand REF|BINARY [--rounds 2] [--rest 20] [--layout solo|split] [--json] [--markdown] [--out DIR] [--keep]
bun scripts/perf-attrib.ts --calibrate BINARY [--rounds 3]       # same build on both sides; rewrites scripts/perf-attrib-noise.json
bun scripts/perf-attrib.ts --rescore DIR [--markdown] [--write-noise]   # score runs saved with --out again
```

A `REF` is any commit: it is built in a temporary `git worktree` (`bun install --frozen-lockfile`, `scripts/build.ts`) that is removed at the end. A `BINARY` is copied and never touched. Sides alternate within each round. `solo` (default) is the terminal hosting the daemon, as a user runs it, the one the skill's baseline measures; `split` is a terminal plus a daemon process of its own, with `tui.*` and `daemon.*` metrics.

| Metric (names in the JSON) | How | Noise between identical runs |
|---|---|---|
| `*.heap.type.<Type>` | JS object count per type, `bun:jsc` `heapStats()` after a full GC | none for most types (0 for the median) |
| `*.rest.ctor.<kind>:<Name>.bytes/.count`, `js_live_b`, `js_code_b` | bytes per constructor from a V8 heap snapshot at rest; `js_live_b` is the sum without compiled code (JIT timing moves compiled code by up to 1 MB) | `ModuleRecord` 85 B; `js_live_b` 38 KB; `code:*` up to 0.7 MB |
| `*.heap.size_b`, `extra_b`, `objects`, `protected` | `heapStats()` totals | `size_b` 1.2 MB, `objects` 0.9 % |
| `*.region.<Name>` | dirty plus swapped MB per region, `vmmap --summary` (macOS) or `smaps_rollup` (Linux) | 0.1 to 0.6 MB per region |
| `*.fp_mb`, `peak_mb`, `rss_mb` | `scripts/perf-proc.ts`; RSS is shown, never judged | footprint 1.4 MB ready, 4.8 MB rest, 8.7 MB after a reply |
| `*.cpu_ms.ready/after/rest` | CPU from spawn to ready, for the reply, for the idle seconds | 40 / 135 / 20 ms |
| `disk.bytes`, `disk.table.<name>` | bytes of every column of the session's rows, as `bench/real.ts` | 0 |
| `binary.bytes` | size of the file | 0 |
| module list | `require.cache` of the ready process; a compiled build's chunks have hash names, so they are told apart by size | 0 |

Memory is taken before the heap probe at each phase and the probe (a collection, and the snapshot at rest) after it, so a phase is never measured through its own probe; the later phases carry the same probe on both sides. The probe is `scripts/perf-attrib-preload.ts`, loaded with `BUN_OPTIONS=--preload` by the script only. The product has no hook for it, so a build that is not being measured has no timer, handler or import to pay for (`perf-attrib.test.ts` checks that nothing under `apps` or `packages` reads the dump variable and that the preload registers nothing without `PERF_ATTRIB_DIR`). It also works on binaries built before this script existed.

**Noise threshold.** `--calibrate` runs one build against itself and stores, per metric, the widest spread (max minus min) seen in `scripts/perf-attrib-noise.json`. A comparison flags a metric when the difference of the medians exceeds 1.5 times that spread (a floor of 0.2 MB applies to memory). Metrics calibration never saw get 5 % of their value with a floor per unit. Recalibrate after changing the machine, the Bun version or the script's scenario. The committed file was measured with `solo`; `split` metrics reuse it where the names match and fall back to the default otherwise. Not done: CPU by function (`--cpu-prof`); CPU is reported per phase only.

**Output.** `--markdown` is a compact table with the verdict on its first line, ready for a review; `--json` is versioned (`schema`) and carries every metric as `{base, cand, delta, threshold, status}`. The verdict is `igual` (nothing above the noise), `baja X`, or `sube X`, followed by the regions, object types, constructors and disk tables that explain it. The exit code is 1 when the verdict is `sube` (CI or a reviewer treats it as a finding) and 0 otherwise. The report also prints the skill's reference line (real model, 2026-11-03: footprint 64 / 66 MB, peak 80 MB, 2.6 KB per session); the faux engine writes less per session and a tool-less reply, so that line orients and does not gate. The optional mode with a real login is not implemented here: use `bench/real.ts` of the skill for it.

Reading a report: a `sube` caused only by deterministic metrics (a few hundred objects, tens of KB of JS, the binary) is a real, small cost of new code; a `sube` in a footprint or region row with the JS metrics flat is a native allocation (a buffer, a mapping, a child) and needs `--layout split` or a profile. Rows that are all `same` with a footprint difference in the raw numbers mean the footprint difference was noise.

## Budgets

`scripts/perf-budgets.ts` holds them and `scripts/perf.test.ts` fails when a run exceeds one (rules unit-tested, and the compiled measurement for 0, 1,000 and 10,000 messages, about 15 s). They are measured values plus headroom: RSS about 1.25x, frame times and start-up 4x (the real frame limit is 16.7 ms). Raise one only with the reason in the commit. The numbers are macOS ones; on Linux x64 every absolute RSS budget is 25 MB higher (`PLATFORM_RSS_MB`: the same binary measures about 22 MB more there and grows the same), growth budgets are not.

**On a CI runner** the same budgets are developer-machine numbers, so the CI workflows (`.github/actions/checks`) set `MENDCODE_TEST_TIME_SCALE=3`. Every wall-clock budget in the tests goes through `scripts/test-budget.ts` (`budgetMs`, `timeScale`) and is multiplied by it; `scripts/test-shards.sh` raises bun's 5 s per-test timeout by the same factor. Memory, byte, count and growth budgets are never scaled, and nothing sets the variable locally. With it set, the 2,000-session disk budget (`packages/store/test/disk-budget.test.ts`, about 50 s here, over 4 minutes on a CI disk) runs on 500 sessions against 25 % of the byte budget: bytes per session, the delta count and the shrink on compaction are still asserted; what only a developer's full run proves is that nothing grows faster than linearly at 2,000 sessions.

Measured on Apple silicon, Bun 1.3.13, compiled binary, faux engine:

| | 0 msgs | 1,000 | 10,000 |
|---|---|---|---|
| Daemon RSS idle / with client | 96 / 103 MB | 96 / 117 | 96 / 129 |
| Client RSS idle / after use | 64 / 104 MB | 70 / 132 | 70 / 131 |
| First frame | 61 ms | 84 | 86 |
| Stream frame p95 | 2.8 ms | 5.5 | 3.9 |
| Scroll up / down p95 | 1.8 / 1.5 ms | 3.8 / 3.6 | 2.6 / 2.4 |

Before RAM round 2 (2026-10-03, same machine): daemon 120 / 128, 120 / 142, 120 / 152 MB; client 66 / 125, 74 / 164, 75 / 153 MB. Frame p95 rose by about 2 ms because one frame in eight runs the client's collection (below); the budget is 16.7 ms.

`help` takes about 95 ms. History size does not move idle memory: the client lays out a window of 400 blocks and the daemon pages the event log.

### Solo mode (one process)

`bun scripts/perf.ts --mode daemon,solo` runs both shapes (`--mode solo` alone works too); solo hosts the daemon inside the probe, like a terminal started with no daemon (`--process solo`; the setting `processMode: auto`, the default in every tier, does the same when no daemon is running; `daemon` keeps two processes, and the probe's two-process runs below measure that shape, see [the design](design/memory-single-process.md)). The program prints the load average before and after and asks for a repeat above 3. The run below, 2026-10-05, had load 5.5 to 5.7 on a shared machine, after `--splitting` and the store paging change:

| Solo, probe | 0 msgs | 1,000 | 10,000 |
|---|---|---|---|
| Process RSS idle / after use | 113 / 148 MB | 125 / 207 | 133 / 216 |
| Hosting the daemon / first frame | 95 / 180 ms | 98 / 196 | 95 / 210 |
| Stream frame p95 | 5.6 ms | 9.0 | 9.1 |
| Scroll up / down p95 | 4.5 / 4.6 ms | 7.4 / 6.7 | 8.4 / 6.9 |

The same run in two processes (daemon + client): 142 / 195 MB, 147 / 243, 148 / 249; scroll p95 1.5 to 3.8 ms, stream 2.8 to 5.3. The probe understates a real client; with the real CLI in a pseudo-terminal (split build, load 3 to 8) two processes took 167 / 188 MB and solo 124 / 145 MB with 0 messages, and 187 / 216 against 141 / 165 with 1,000. `PERF_BUDGETS_SOLO` holds the solo budgets (RSS 170 / 270 MB, hosting 400 ms, first frame 840 ms, frame p95 15 to 27 ms), and `--check` enforces them. The extra solo frame time is the daemon sharing the thread; the client's collection grows from about 1.7 to 4.5 ms with both heaps in one process.

## Findings

- Fixed: streaming re-rendered the whole answer's markdown at every delta, so a frame cost grew with the answer (p95 20 ms at 18 KB). `renderMarkdown` now keeps the rows before the last safe blank line and renders only the tail; p95 is about 4 ms and flat. A differential test (`apps/cli/test/markdown-settled.test.ts`) checks it against the whole renderer on generated documents, chunk by chunk.
- Fixed, daemon: the protocol's zod schemas. Importing all ~900 of them cost 301k heap objects and 47 MB RSS in the compiled binary (a 33 MB process grew to 81 MB; now 44 MB). Every schema is built the first time something touches it (`packages/protocol/src/lazy.ts`: `lazySchema(() => z.strictObject(...))`, a stand-in that forwards to the real schema, so `parse`, `.extend`, `.shape`, `z.infer` and composition work unchanged). Importing the protocol builds 20 of them; an idle daemon builds about 50 (settings and provider config); each command a client sends builds only its own, because `decodeFrame` and `parseCommand` look the command up in `COMMAND_SCHEMAS` by `type` instead of walking the 370-way union (`Command` itself is still the full union, built for documentation and for the error text of an unknown `type`). Rules: a wrapper schema (`z.lazy`, `.optional()`, `.transform()`, `.pipe()` at the root) is not wrapped, because zod's JSON Schema output finds those by identity; `packages/protocol/test/lazy-schemas.test.ts` converts every export to JSON Schema, compares `decodeFrame` and `parseCommand` with the full schemas, and counts what an import and a command build. All 923 exports produce byte-identical JSON Schema before and after.
- Fixed, client: the RSS that grows over the first frames was not JS data (the heap stays near 8 MB) but garbage the runtime collects late: a frame builds a few hundred KB of rows, spans and strings, and the process keeps asking the OS for fresh pages until a collection runs (`footprint` on a paused client reported 36 MB physical and 45 MB reclaimable of the 110 MB `ps` showed). The screen now runs a full collection after every 8th drawn frame (`apps/cli/src/ui/memory-governor.ts`; about 2 ms on a 10 to 25 MB heap, 1% of a 60 fps stream); `MENDCODE_GC_FRAMES=N` changes the interval and `0` turns it off. A collection costs time in proportion to the heap, so one that takes more than 4 ms stretches the wait to the next in proportion (a 250 ms collection on a large heap waits 62 intervals); on the shared heap of a `bun test apps/cli` process, two image tests that draw a hundred frames through a real screen went from 1 s to 8 s locally and past the 15 s limit on a CI runner before that. Row encoding no longer allocates an object per cell for ASCII and narrow text (`takeCells`).
- Fixed, client: scrolling up through a long history laid out every block it passed and kept all their rows (about 5 KB of heap per message; 56 MB of heap and 335 MB RSS in a source run that scrolled 1,500 pages through 10,000 messages, with scroll p95 at 10 ms). The transcript now keeps rows for the 600 most recently drawn blocks and keeps only the row count of older ones (`ROWS_CACHE_BLOCKS`); a block is laid out again when it comes into view. The same run: 28 MB of heap, 248 MB RSS, scroll p95 4.7 ms.
- Fixed, both: `bun build --compile --splitting` makes the modules a session rarely touches lazy chunks inside the executable: the compiled client uses about 22 MB less and the daemon about 10 MB less (the real CLI in two processes: 200 to 167 MB idle).
- Fixed, both: reading a page of history cost time proportional to the history before it (the `events_read` view cannot be cut by LIMIT), 21 ms per page at 10,000 messages; each branch is now cut before the merge (`eventsPage`, `packages/store/src/store.ts`): 0.2 ms, and the solo scroll p95 went from 34 to 8 ms.
- Fixed, daemon: after hours of real turns (2 sessions, Claude Code and native) the daemon stood at 305 MB RSS and 216 MB physical footprint (387 MB peak), with 60 MB of live heap; one full collection brought RSS to 164 MB. Turns leave their requests and streams as garbage that JavaScriptCore collects late. The daemon now runs one full collection 30 s after it goes idle (no turn, job or engine task running; a new idle moment restarts the wait; `packages/daemon/src/idle-gc.ts`). RSS counts memory that the physical footprint does not (the binary's clean code pages and pages the kernel can take back), so the two differ by a roughly constant amount for the same binary: in the case above 89 MB (305 RSS against 216 footprint), and for an idle daemon on the faux engine with no client 41 MB (97 MB RSS against 56 MB footprint, macOS, compiled binary, median of five runs of `bun scripts/perf.ts --mode daemon --messages 0`, 2026-11-02). Compare builds with the footprint; RSS also moves with what the kernel has compressed or dropped, and the real CLI's client RSS after 60 s idle ranged from 55 to 85 MB between identical runs while its footprint stayed at 29 to 33 MB.
- Tried, no gain: a full collection in the daemon two seconds after a burst of commands (RSS unchanged; commands leave little garbage, turns do), and SQLite `cache_size` 1, 2 and 8 MB (no signal above the noise at load 8 to 9). Both left as they were.
- Fixed, daemon: the code graph kept the whole text of every scanned file. The names the scanner returns are slices of the file, and a slice keeps its source alive; on a 2,873-file repository the records held 73 MB of heap after the scan (the cache file is 7 MB) and indexing peaked at 419 MB RSS. Each record is now copied through JSON (`scanFile`, `packages/codegraph/src/indexer.ts`): 17 MB after the scan, 32 MB with the graph built, 274 MB peak. Only the two most recently asked projects stay built in memory (`MAX_PROJECTS_IN_MEMORY`) and one nobody asked for in 10 minutes is dropped (`IDLE_DROP_MS`); the next question rebuilds it from its cache file.
- Fixed, both: JIT tiers. A terminal restarts itself once at start, in place (`execve`, the same pid and terminal, before anything is drawn), without the DFG and FTL tiers; the daemon starts without FTL only (`LEAN_JIT`, apps/cli/src/launcher.ts). Measured (compiled, 0 / 10,000 messages): client idle 63 / 69 → 52 / 59 MB and after use 126 / 155 → 93 / 111 MB with stream p95 under 8 ms; daemon idle 92 → 88 MB; a cold index of 2,873 files 1.7 → 1.8 s and its peak about 40 MB lower (without DFG too it took 2.5 to 3.9 s, so the daemon keeps it). A terminal that hosts the daemon (solo) takes the daemon's setting. Each process drops the variables once started, so the daemon, agent shells and editors get the user's environment. `MENDCODE_JIT=1` keeps every tier, `MENDCODE_JIT=0` turns the JIT off.
- Fixed, daemon and solo terminal: the daemon's JIT environment now also compiles a function to machine code only after 16 times the usual warm-up (`thresholdForJITAfterWarmUp` 8000, `thresholdForJITSoon` 2000, the terminal's values), with the DFG tier left on. Hosting the daemon compiled the daemon's one-shot startup code (a first-run burst of commands runs the daemon's very large command handler once), and that compiled code, not the heap, held the memory: the fresh-HOME prompt measured as in the README (`tmux` 160 by 45, 12 s, summed `ps` RSS) went from 178 to about 154 MB RSS (footprint 108 to 94 MB), flat for any warm-up from 8000 to 50000. Where the memory is, measured on a compiled binary (macOS, Bun 1.3.13): the Bun runtime with the 70 MB bundle embedded and nothing evaluated 22 MB RSS (7 MB footprint); evaluating the terminal's import graph 45 MB (20); evaluating every module the daemon and the terminal import 80 MB (47); the running solo prompt about 154 MB (94), the difference being the first frame, the first-run commands and the garbage they leave (a full collection after the prompt lowers the footprint by about 30 MB but not the RSS, because the freed pages stay resident until the kernel takes them). Tried, no gain: JSC heap growth factors, `numberOfGCMarkers` (worse), mimalloc purge options, `jitMemoryReservationSize` (a small reservation only stops compiling), one collection after the first frame or while modules load (4 MB at most, inside the noise), `BUN_JSC_useBaselineJIT=0` (-12 MB, but every function stays in the interpreter).
- Fixed, client: an imported pet. A 30-frame, 352-pixel pet was kept fully inflated (14 MB of RGBA), its cache was inflated whole and then copied frame by frame, and finding the box every frame shares read all of them. The cache (format 4, `apps/cli/src/pets/sprite.ts`) now deflates each frame on its own, records the shared box, and a frame inflates only when read (the last 4 stay); a crop that is the whole frame is not copied. A format-3 cache is rewritten from its own frames without the sheet decoder, and a pet's older caches are removed. Measured with such a pet (compiled, fresh session): idle 121 → 97 MB, start peak 146 → 122 MB (94 / 118 without a pet); the first start after a sheet change 228 → 188 MB.
- Fixed, daemon and solo terminal: creating the native engine converted every tool's zod arguments to JSON Schema, once for the main agent and again for sub-agents, before any turn. A tool's spec is now built the first time a turn lists it and is shared by both toolsets (`withLazySpecs` and `toSpec` in `packages/engine-native/src/engine.ts`). Startup marks (RSS at each phase of the fresh-HOME solo prompt) put the engine's creation at 15 MB of the daemon's 31 MB start; the prompt went 149 → 144 MB RSS (footprint 89 → 84, peak 107 → 101; 2026-11-02). The same marks put evaluating the daemon's import graph at 41 MB (zod 5.5 MB of footprint, then about 0.1 MB per module, spread across the protocol's 148 modules) and the first frames at about 30 MB.
- Fixed, solo terminal: zod compiled a validator with `new Function` for each object schema it parsed. It now runs `jitless` (`packages/protocol/src/zod-config.ts`, imported first by the protocol and the daemon): the fresh-HOME prompt (`tmux` 160 by 45, 12 s) 152 → 149 MB RSS and footprint 91 → 89 MB in three alternating pairs, with client and daemon CPU while an 18 KB reply streams inside the range of three pairs of `scripts/perf-real.ts` (2026-11-02). Where the rest is, same build: the runtime with nothing evaluated 25 MB RSS (9 MB footprint); evaluating protocol (zod 7 MB of it), store, engine, daemon and terminal 82 MB (52); the prompt 149 MB (89), its footprint peaking at 107 MB within the first 340 ms of startup work and the RSS staying near that peak. The live JS heap at the prompt is 30 MB (code 8.5, module records 6.1, closures 2.3, 181 prepared SQLite statements 1.3). Tried, no gain on RSS: caching the validated settings (CPU only), discarding old code blocks (`useEagerCodeBlockJettisonTiming`, `forceCodeBlockToJettisonDueToOldAge`: footprint 82 to 85 MB, RSS unchanged), heap growth factors and sizes, no concurrent GC. Every JIT tier off but `useJIT` on: 137 MB, every function in the interpreter. `BUN_JSC_useJIT=0` for the whole solo process: 122 MB (footprint 54), but the daemon used about four times the CPU while a reply streamed (1.9 → 7.4 s) and 6.5 s instead of 0.05 s in the 10 s after it, so it is not the default. `PERF_CLIENT_ENV` gives `scripts/perf-real.ts` a terminal's JSC options as `PERF_DAEMON_ENV` does the daemon's.
- Superseded, client: with `BUN_JSC_useJIT=0` the whole client settles at 46 / 73 MB instead of 63 / 104 (and the daemon at 78 / 83), with frames still under 7 ms p95 on an empty session. JSC options are read from the environment before any code runs; `bun build --compile-exec-argv` takes Bun flags, not JSC options, and `--smol` changed nothing. Using it would need a launcher that re-executes the binary, which doubles the process count and startup, so it stays a user's choice (`BUN_JSC_useDFGJIT=0 BUN_JSC_useFTLJIT=0 mendcode` saves about 25 MB). `bun scripts/perf.ts --exec-argv --smol` and `scripts/build.ts --exec-argv` exist to measure such flags.
- Fixed, client: every streamed delta laid out the growing answer twice inside the event handler, only to tell the scroll position how much the transcript grew, which nothing uses while the reader follows the bottom. A delta now costs a follower no layout; the next frame lays the block out once for all the deltas it covers. The real CLI in a pseudo-terminal, 120 by 40, one 18 KB reply (median of five alternating pairs against the build before, 2026-11-02): client CPU 5.5 to 4.2 s, 60 s at rest after it 3.1 to 2.5 s (the range overlaps), probe stream frame p95 3.9 to 3.2 ms at 0 messages and 5.4 to 5.1 at 10,000. A reader scrolled up still measures every delta.
- Fixed, client: the pinned prompt row (the newest prompt, shown under the top bar once it scrolled out of view) collapsed whitespace and cut the whole prompt text on every frame; a pasted log of some kilobytes made that the largest cost of each frame of the answer under it. It is built once per prompt text and width.
- Tried, no gain: one collection in the client after 10 s without a frame. Client footprint 60 s after a reply went from 31.3 to 29.4 MB, inside the range of five runs of the build without it (28.9 to 32.6 MB); RSS moved between 43 and 91 MB in either build. Not kept.
- Tried, no gain: drawing a streaming reply four times a second while the terminal reports (DEC 1004) that it lost focus, with an immediate frame when focus returns. Frames and bytes written fell by 82 % (574 to 101 frames, 4.2 to 0.7 MB), but the client CPU did not follow (about 5 s in both): most of it is handling the 2,250 deltas, not drawing, and the daemon used about 65 % more CPU in that case, because a client that is not busy drawing takes each delta as it arrives instead of in batches. Net CPU was the same or worse, so it was not kept; the saving would be on the terminal's side only.
- Audit, start-up of the real CLI against a running daemon (instrumented build, cold launches in a pseudo-terminal, 120 by 40, median of 8, load 3 to 4): about 145 ms to the first frame and 8 ms more until a typed key shows. Roughly 90 ms of that is two runtime starts (the terminal restarts itself once without the DFG and FTL tiers, see "JIT tiers"); then the terminal's own modules load while the process connects (the connection waits for the module evaluation on the same thread, about 23 ms for both), the app is created (5 ms), `app.start` runs (3 ms) and the first frame is drawn (8 ms). Nothing before the first frame is waiting on work that could move behind it without changing what is drawn: the daemon round trips take under 1 ms each once connected (`--pure` adds a `daemon.info` round trip of about 75 ms to a launch, which is why `perf-real.ts --no-pure` is the realistic start). Left as it is.
- Fixed, solo terminal: start-up garbage. A fresh prompt held 41 MB of JS heap of which 24 survived a full collection, and
  nothing collected it, because the daemon's idle collection only followed a finished turn and the screen's every eighth
  frame. Its footprint stayed at 87 MB for good; the pages freed after the start peak (104 MB) stayed in RSS as reclaimable
  memory (22 MB, `footprint PID`). Three changes: the daemon collects once 10 s after start (`STARTUP_GC_MS`,
  `packages/daemon/src/idle-gc.ts`), the solo terminal collects once (about 5 ms) between hosting the daemon and building
  its screen (`apps/cli/src/solo.ts`), and the screen collects every second frame during its first 24
  (`STARTUP_FRAMES`, `apps/cli/src/ui/memory-governor.ts`; an explicit `MENDCODE_GC_FRAMES` keeps its own cadence). A plain
  `mendcode` no longer evaluates the subcommand parsers (`automation.ts` and what it reaches, about 300 KB of source). The
  prompt in a pseudo-terminal, clean HOME, 12 s, three launches each, alternating: 148 → 136 MB RSS, footprint 88 → 72,
  peak 105 → 93 (pi measured the same way: 131 MB RSS, 79 footprint, 94 peak). `scripts/perf-real.ts` (two processes, an
  18 KB reply): first frame, keystroke p95 and client and daemon CPU inside the range of two pairs (2026-11-03).
- Tried, no gain: JSC heap sizing (`BUN_JSC_forceRAMSize` 256 and 512 MB; `largeHeapSize` 4 to 16 MB lowered the prompt 3
  to 4 MB alone and nothing on top of the collections above), a second collection before the daemon starts, and
  `useConcurrentJIT=0` (1 to 2 MB). Each 300 KB of source not evaluated at start is worth about 1 MB of footprint, so
  lazy-loading the daemon's rarely used subsystems (about 600 KB) is worth a few MB at most.
- Fixed, daemon and solo terminal: a turn's garbage. Measured the way a user runs it: logged in, a clean HOME with only
  the login copied, the prompt in a pseudo-terminal (160 by 45), one read-only question on gpt-6-luna, memory at the prompt
  (12 s), right after the reply and 30 s later. A first turn took a solo terminal from 145 to about 200 MB RSS (footprint
  74 → 81). Five causes, five changes:
  - The settings were read over a thousand times between start and the end of a first turn, each read parsing the stored
    JSON, validating every key with zod and reading `acp-agents.json`: bursts of about 45 MB of heap capacity at the prompt
    and at the end of the turn. `store.settings.get` and the ACP file keep their validated view until the stored text changes
    (`packages/store/src/store.ts`, `acp-settings.ts`); the row is still read on every call. After a turn: 200 → 160 MB RSS.
  - Bun hands each chunk of a fetch body in a 256 KB buffer of its own, freed only by a collection: the 70 deltas of a short
    answer held about 32 MB. `sseData` releases each read buffer once it is decoded (`chunk-buffers.ts`, only buffers of
    at least 64 KB that the chunk fills less than a quarter of; a caller's own bytes are never touched). A headless daemon
    after one turn: 163 → 148 MB RSS.
  - The first turn converted the 81 schemas of the main toolset with zod (about 7 MB of short-lived allocations in 18 ms, the
    turn's largest burst). The daemon now builds them before the first turn, eight at a time with a young collection between
    (`warm` on the engine port, run by the start-up collection in `idle-gc.ts`). Built in one go at start instead, the prompt
    rose 6 MB and the turn fell 3: that was not kept.
  - An idle moment pushed the start-up collection from 10 s to the 30 s idle wait; it no longer does.
  - The idle and start-up collections, and the screen's start-up frame collections, call `Bun.shrink()` after `Bun.gc(true)`,
    which hands the freed pages back (`collectAndRelease`). Footprint at the prompt 72 → 65 MB, after a turn 77 → 68.
  Three alternating launches per tier, medians, against pi measured the same way (2026-11-03): balanced 136 / 64 MB (RSS /
  footprint) at the prompt, 145 / 66 after the reply; minimalist 135 / 64 and 145 / 68; full 137 / 65 and 148 / 67; pi
  133 / 81 and 141 / 88.
- Fixed, solo terminal: the DFG tier. A terminal that hosts the daemon now restarts with the terminal's own JIT profile (no
  DFG, no FTL; `leanClientEnv`, apps/cli/src/launcher.ts). The one hot loop of the daemon that needed DFG is scanning files
  for the code graph (this repository, 3,288 files: 1.7 s with it, 2.3 s without). A refresh with at least 256 files to scan
  now scans them in a process of its own, the binary with `__codegraph-scan` under the user's environment, every tier on
  (`packages/codegraph/src/scan-host.ts`); its records come back one line per file, in order, and a host that cannot start or
  dies leaves the files left to the daemon. Indexing this repository from a process without DFG: 2.6 s scanning in it, 1.8 s
  with the host (1.9 s before, with DFG), and the indexing process ends about 50 MB lower. Logged in, balanced, three
  alternating launches: 135 → 130 MB RSS at the prompt, 145 → 138 after the reply (pi: 133 and 141), footprint and turn CPU
  the same. `perf.ts --mode solo`: idle 6 MB lower, after scrolling and streaming 12 to 38 MB lower, stream frames p95
  4.5 / 6.2 / 6.3 → 5.1 / 6.8 / 6.8 ms (0 / 1,000 / 10,000 messages), first frame the same.
- Fixed, solo terminal: idle CPU. Counting every timer that fired in an idle minute (a `--preload` that wraps `setTimeout` and
  `setInterval`) left four: the hand-off check every 5 s, the relaunch check every 20 s, the quota schedule and the mflow
  heartbeat every 30 s. The hand-off check asked the hosted daemon for its full `daemon.status` (settings, loops, jobs,
  keep-alive) only to learn whether another client was attached; it now reads the daemon's client count first
  (`clients()`, apps/cli/src/main.ts) and asks for the status only then. CPU in the second 30 s at rest: 0.09 → 0.04 s
  (two pairs, with `MENDCODE_PROCESS=solo` as the bound: 0.04 to 0.05 s); pi: 0.
- Measured, solo terminal: CPU of a turn. The same question takes 1.1 to 1.5 s of CPU against pi's 0.2 s, with about as many
  frames (136 against 144, counted by their synchronized-output marks) and as many bytes written (66 to 81 KB against 64 to
  72). Per thread (`ps -M`), about 1 s is the main thread and 0.3 s three runtime threads. A profile of the compiled binary
  (`BUN_OPTIONS=--cpu-prof`) puts about a third of the main thread in `render`, spread over a dozen pieces of about 1 % each
  (footer, sidebar, comments, transcript lines, encoding, the frame collections): each frame rebuilds every row, about 7 ms
  where pi's differential renderer spends about 1. Young collections in the frame governor instead of full ones (one full
  in four) did not lower it (1.17 to 1.31 s against 1.14 to 1.28) and left 1 to 4 MB more after the reply: not kept.
- Tried, not kept: `BUN_JSC_libpasScavengeContinuously=1` lowers the prompt to 130 MB and 65 footprint but keeps a core busy
  at rest. `Bun.shrink()` after every collection of a turn gains 1 MB more for about a third more CPU during the turn.
  `--smol` and `Malloc=1` changed nothing or made it worse.
- Measured, memory per extra terminal (`perf-real.ts --scenario clients`, real CLI, each terminal in its own project and session, empty sessions, median of five runs): 1, 2, 4 and 8 terminals hold 30, 60, 120 and 232 MB of footprint (464 MB of RSS at 8), about 29 MB of footprint and 58 MB of RSS each; the one daemon goes from 73 to 78 MB of footprint, about 0.7 MB per terminal.
- Still open: the transcript keeps every loaded event and block of the history it has scrolled through (`history`, `all`, `byItem`); at 10,000 messages that is about 20 MB of heap after a deep scroll, kept until the session changes. Dropping far pages would need the paging protocol to refetch them.
- A 60 MB `bun --compile` binary starts at 42 MB RSS before any of our code runs (a plain `bun` process: 22 MB). `--bytecode` needs CommonJS output in Bun 1.3.13 and the entries use top-level await.

## Comparison with pi and Codex (manual)

The harness never launches pi or Codex because they write to `~/.pi` and `~/.codex`. To compare, run each with a throwaway `HOME` (`HOME=$(mktemp -d)`), let it reach its idle prompt, and read `ps -o rss= -p PID` for the client and its server or helper processes; then load a 1,000 and a 10,000 message session the same way each tool imports transcripts and read RSS again. Compare against the table above (client plus daemon), the same way: resident set, idle, after loading, after scrolling to the top.

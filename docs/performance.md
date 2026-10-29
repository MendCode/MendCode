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

`bun scripts/perf.ts --mode daemon,solo` runs both shapes (`--mode solo` alone works too); solo hosts the daemon inside the probe, like a terminal started with no daemon (`--process solo`; the setting `processMode: auto`, which the minimalist tier selects, does the same; the default is `daemon`, see [the design](design/memory-single-process.md)). The program prints the load average before and after and asks for a repeat above 3. The run below, 2026-10-05, had load 5.5 to 5.7 on a shared machine, after `--splitting` and the store paging change:

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
- Fixed, daemon: after hours of real turns (2 sessions, Claude Code and native) the daemon stood at 305 MB RSS and 216 MB physical footprint (387 MB peak), with 60 MB of live heap; one full collection brought RSS to 164 MB. Turns leave their requests and streams as garbage that JavaScriptCore collects late. The daemon now runs one full collection 30 s after it goes idle (no turn, job or engine task running; a new idle moment restarts the wait; `packages/daemon/src/idle-gc.ts`). An empty daemon is 64 MB of physical footprint; about 172 MB of any daemon's RSS is the binary's own code pages, clean and shared.
- Tried, no gain: a full collection in the daemon two seconds after a burst of commands (RSS unchanged; commands leave little garbage, turns do), and SQLite `cache_size` 1, 2 and 8 MB (no signal above the noise at load 8 to 9). Both left as they were.
- Fixed, daemon: the code graph kept the whole text of every scanned file. The names the scanner returns are slices of the file, and a slice keeps its source alive; on a 2,873-file repository the records held 73 MB of heap after the scan (the cache file is 7 MB) and indexing peaked at 419 MB RSS. Each record is now copied through JSON (`scanFile`, `packages/codegraph/src/indexer.ts`): 17 MB after the scan, 32 MB with the graph built, 274 MB peak. Only the two most recently asked projects stay built in memory (`MAX_PROJECTS_IN_MEMORY`) and one nobody asked for in 10 minutes is dropped (`IDLE_DROP_MS`); the next question rebuilds it from its cache file.
- Fixed, both: JIT tiers. A terminal restarts itself once at start, in place (`execve`, the same pid and terminal, before anything is drawn), without the DFG and FTL tiers; the daemon starts without FTL only (`LEAN_JIT`, apps/cli/src/launcher.ts). Measured (compiled, 0 / 10,000 messages): client idle 63 / 69 → 52 / 59 MB and after use 126 / 155 → 93 / 111 MB with stream p95 under 8 ms; daemon idle 92 → 88 MB; a cold index of 2,873 files 1.7 → 1.8 s and its peak about 40 MB lower (without DFG too it took 2.5 to 3.9 s, so the daemon keeps it). A terminal that hosts the daemon (solo) takes the daemon's setting. Each process drops the variables once started, so the daemon, agent shells and editors get the user's environment. `MENDCODE_V2_JIT=1` keeps every tier, `MENDCODE_V2_JIT=0` turns the JIT off.
- Fixed, client: an imported pet. A 30-frame, 352-pixel pet was kept fully inflated (14 MB of RGBA), its cache was inflated whole and then copied frame by frame, and finding the box every frame shares read all of them. The cache (format 4, `apps/cli/src/pets/sprite.ts`) now deflates each frame on its own, records the shared box, and a frame inflates only when read (the last 4 stay); a crop that is the whole frame is not copied. A format-3 cache is rewritten from its own frames without the sheet decoder, and a pet's older caches are removed. Measured with such a pet (compiled, fresh session): idle 121 → 97 MB, start peak 146 → 122 MB (94 / 118 without a pet); the first start after a sheet change 228 → 188 MB.
- Superseded, client: with `BUN_JSC_useJIT=0` the whole client settles at 46 / 73 MB instead of 63 / 104 (and the daemon at 78 / 83), with frames still under 7 ms p95 on an empty session. JSC options are read from the environment before any code runs; `bun build --compile-exec-argv` takes Bun flags, not JSC options, and `--smol` changed nothing. Using it would need a launcher that re-executes the binary, which doubles the process count and startup, so it stays a user's choice (`BUN_JSC_useDFGJIT=0 BUN_JSC_useFTLJIT=0 mendcode` saves about 25 MB). `bun scripts/perf.ts --exec-argv --smol` and `scripts/build.ts --exec-argv` exist to measure such flags.
- Still open: the transcript keeps every loaded event and block of the history it has scrolled through (`history`, `all`, `byItem`); at 10,000 messages that is about 20 MB of heap after a deep scroll, kept until the session changes. Dropping far pages would need the paging protocol to refetch them.
- A 60 MB `bun --compile` binary starts at 42 MB RSS before any of our code runs (a plain `bun` process: 22 MB). `--bytecode` needs CommonJS output in Bun 1.3.13 and the entries use top-level await.

## Comparison with pi and Codex (manual)

The harness never launches pi or Codex because they write to `~/.pi` and `~/.codex`. To compare, run each with a throwaway `HOME` (`HOME=$(mktemp -d)`), let it reach its idle prompt, and read `ps -o rss= -p PID` for the client and its server or helper processes; then load a 1,000 and a 10,000 message session the same way each tool imports transcripts and read RSS again. Compare against the table above (client plus daemon), the same way: resident set, idle, after loading, after scrolling to the top.

# Lazy daemon services

Baseline: `1e37c0fe`, branch `perf/lazy-services`. Bun 1.3.13.

## Loading boundaries

- MCP: empty status/catalog/tool/prompt discovery reads config without constructing the manager. A configured server (including a held-back server whose trust status must be reported), or an explicit server operation, loads the manager, clients and OAuth. Invalidation and suspension clear the config cache without loading an unused service.
- LSP: query/diagnostics or permitted after-write warm-up loads the manager. Passive status, live-server searches, late notes and shutdown stay cold. Formatter status/file requests and after-write processing load the formatter. Tool schemas stay available; tool implementations load on execution.
- Loops: saved loops load before startup timers, then recover/start at the original recovery boundary. An empty store stays cold through list/status/session checks; loop commands and first creation initialize one shared service. Observers see it before recovery starts. Development mode still does not start the scheduler.
- Dream: the existing dynamic `runDream`/meter paths now actually isolate the runtime, rather than sharing a statically imported package barrel with digest helpers.
- Code graph: tools, overview and enabled autopilot share one lazily constructed indexer. Tool discovery and gate checks do not load the scanner/indexer. Disabled autopilot, state reads and shutdown stay cold.

## Bundle evidence

Both before and after:

```sh
bun build --splitting --minify --target=bun --metafile=dist/probe/meta.json --outdir dist/probe/split apps/cli/src/entry.ts
```

Local artifacts: `dist/probe/before.json`, `dist/probe/meta.json`, `dist/probe/comparison.json` (ignored, not committed). Later builds redirected the build listing to `dist/probe/build-after.txt`.

Important: `entry.ts` already dispatches through dynamic imports; its literal static closure is only 906 source bytes before and after. For a useful solo-startup comparison, the measurement also roots `apps/cli/src/main.ts` and `packages/daemon/src/main.ts`, following only non-dynamic output imports. This catches shared chunks that would still be evaluated when the daemon starts. It does not count conditional dynamic imports as unconditionally loaded.

| Implementation | Before chunk | After chunk(s), outside all three static closures |
|---|---|---|
| MCP manager/OAuth | `entry-92jjgf7f.js` | `index-hjds85qa.js` |
| MCP client/prompts | `entry-92jjgf7f.js` | `entry-evdv7xm9.js` |
| LSP manager/client | `main-vd1rcwxz.js` | `manager-bwd92drk.js` |
| LSP diagnostics/after-write bodies | `main-vd1rcwxz.js` | `tool-933cbcxs.js` |
| Formatter | `main-vd1rcwxz.js` | `formatter-xhhx23tt.js` |
| Loop service/verifier | `entry-bjvwf78j.js` | `entry-tnpf1a4e.js` |
| Dream runtime | `entry-8zgxyvdh.js` | `index-aykwpf26.js` |
| Graph tools/autopilot/overview | `entry-y28hfq37.js` | `entry-cc904cv8.js` |
| Graph indexer/scanner | `entry-nc113fy7.js` | `entry-zwmy2r7z.js` |

Source totals are raw metafile input bytes, counted once per reachable input, not emitted/minified size. About **656.1 KB net source** leaves the expanded static closure; **540.9 KB** is target-package files that leave it. The other removed files are workflow runtime code previously dragged in through validation's barrel. New adapters/shared definitions are included in the net figure. Emitted minified JavaScript falls **304,785 bytes** (4,287,052 to 3,982,267).

Still eager by contract: MCP config validation and credential-environment filtering; loop input/schedule/template/check helpers used synchronously by the tool and workflow validation; Dream digest helpers used by synchronous memory/resume paths; graph gate/walker and tool schemas needed for the existing footer and discovery behavior; LSP tool schemas. None of these imports the deferred service implementations. Configured graph autopilot and saved loops may load at startup, as required.

## Verification

- `bun run typecheck`: final pass. Intermediate incomplete-split failures were corrected.
- `bun test packages/daemon/test/lazy-services.test.ts`: 10 passing cases (empty services, concurrent initialization, real first use, shutdown, tool-definition parity, graph sharing and autopilot).
- `bun test packages/daemon/test/lazy-services-graph.test.ts`: 2 passing cases: actual split-build closure assertions and fresh-process module-cache checks after passive probes. The probe imports daemon code but does not start the daemon or CLI.
- Focused existing tests passed: daemon loops/loop-parity/loop-smart, Dream, MCP/content/trust/pending, LSP, memory-extraction/memory-tier, precedence, setup-import, shell-hooks, extension-registrations, config-bundle, workflow-files, evolution-promotion, compound, loop-interpret, graph-autopilot-daemon, codegraph-overview, pr-review-engine; codegraph scan/graph/search/impact/overview/index-gate/autopilot/across-projects/savings; LSP navigation/warm-up/after-write/lsp/formatter; loops loops/smart/parity; workflows plan/b78-composition. Each invocation named its test files; no full suite was run.
- `git diff --check`: pass.
- **Failed/out of bounds:** `packages/daemon/test/restart-resume-e2e.test.ts` was mistakenly selected and launched the real CLI through its fixture, contrary to the no-MendCode-launch instruction. Two cases timed out waiting for background-child events; two passed. It was not rerun, repaired or treated as proof of a regression. The fixture used temporary data/project directories but inherited the process environment, so this run is not claimed to prove isolation from login state.
- No live terminal footprint measurement, provider calls or publication was requested or used as acceptance evidence. Bundle-byte savings are not a measured RAM result.

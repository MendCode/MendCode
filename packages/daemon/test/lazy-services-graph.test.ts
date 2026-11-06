import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

type Meta = { outputs: Record<string, { inputs: Record<string, unknown>; imports: Array<{ path: string; kind: string }> }> }

test("passive probes do not evaluate service modules in a fresh process", () => {
  const script = `
    await import("./packages/daemon/src/daemon");
    const { createLazyMcp } = await import("./packages/daemon/src/lazy-mcp");
    const { createLazyLsp } = await import("./packages/daemon/src/lazy-lsp");
    const { createLazyCodegraph } = await import("./packages/daemon/src/lazy-codegraph");
    const mcp = createLazyMcp({ configLoader: () => ({ servers: {}, errors: [] }), load: async () => { throw new Error("unexpected load") } });
    const lsp = createLazyLsp({ cacheDir: "unused", warmUp: () => false });
    const graph = createLazyCodegraph({ cacheDir: "unused", mode: () => "off", enabled: () => false, publish() {}, log() {} });
    await mcp.status("unused"); await mcp.catalog("unused"); await mcp.listTools("unused");
    lsp.lsp.status("unused"); lsp.afterWrite.late("unused");
    await lsp.lsp.workspaceSymbols({ cwd: "unused", query: "unused" });
    graph.autopilot.note({ cwd: "unused", reason: "session" }); await graph.autopilot.idle("unused");
    graph.autopilot.stop(); await mcp.stop(); await lsp.lsp.stop(); await lsp.formatter.stop();
    console.log(JSON.stringify(Object.keys(require.cache).filter((file) => /packages\\/(mcp|lsp|loops|dream|codegraph)\\/src\\/(manager|client|oauth|service|verifier|dream|runner|indexer|scan|tools|tool|autopilot|formatter)\\.ts$/.test(file))));
  `
  const probe = Bun.spawnSync([process.execPath, "-e", script], { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" })
  expect(probe.exitCode).toBe(0)
  expect(probe.stderr.toString()).toBe("")
  expect(JSON.parse(probe.stdout.toString())).toEqual([])
})

test("the CLI and hosted-daemon static chunks exclude unused service implementations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-service-graph-"))
  const metaFile = join(dir, "meta.json")
  const root = resolve(import.meta.dir, "../../..")
  const build = Bun.spawnSync([process.execPath, "build", "--splitting", "--minify", "--target=bun", `--metafile=${metaFile}`, "--outdir", join(dir, "split"), "apps/cli/src/entry.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  expect(build.exitCode).toBe(0)
  const meta = await Bun.file(metaFile).json() as Meta
  const seen = new Set<string>()
  const visit = (chunk: string) => {
    const output = meta.outputs[chunk]
    if (!output || seen.has(chunk)) return
    seen.add(chunk)
    for (const edge of output.imports) if (edge.kind !== "dynamic-import") visit(edge.path)
  }
  // entry.ts dispatches dynamically even before this change. Include both mains so that a
  // move into the daemon's still-eager shared chunks cannot produce a false saving.
  for (const source of ["apps/cli/src/entry.ts", "apps/cli/src/main.ts", "packages/daemon/src/main.ts"]) {
    const chunks = Object.entries(meta.outputs).filter(([, output]) => source in output.inputs)
    expect(chunks.length).toBeGreaterThan(0)
    for (const [chunk] of chunks) visit(chunk)
  }
  for (const source of [
    "mcp/src/manager.ts", "mcp/src/client.ts", "mcp/src/oauth.ts",
    "lsp/src/manager.ts", "lsp/src/formatter.ts", "lsp/src/tool.ts",
    "loops/src/service.ts", "loops/src/verifier.ts",
    "dream/src/dream.ts", "dream/src/runner.ts",
    "codegraph/src/indexer.ts", "codegraph/src/scan.ts", "codegraph/src/tools.ts", "codegraph/src/autopilot.ts",
  ]) {
    const chunks = Object.entries(meta.outputs).filter(([, output]) => `packages/${source}` in output.inputs).map(([chunk]) => chunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.filter((chunk) => seen.has(chunk))).toEqual([])
  }
}, 15_000)

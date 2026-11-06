import { expect, test } from "bun:test"
import path from "node:path"

type Output = { inputs: Record<string, { bytesInOutput: number }>; imports: Array<{ path: string; kind: string }> }
type Meta = { outputs: Record<string, Output> }

/** Check the emitted graph, not source import spelling: barrels can silently undo a dynamic import. No app is run. */
test("optional engines, provider transports and code mode stay outside the startup chunks", async () => {
  const root = path.resolve(import.meta.dir, "../../..")
  const metaPath = "dist/probe/lazy-test/meta.json"
  const built = Bun.spawnSync([process.execPath, "build", "--splitting", "--minify", "--target=bun", `--metafile=${metaPath}`, "--outdir", "dist/probe/lazy-test/split", "apps/cli/src/entry.ts"], { cwd: root, stdout: "ignore", stderr: "pipe" })
  expect(built.exitCode).toBe(0)
  const meta = await Bun.file(path.join(root, metaPath)).json() as Meta
  // entry.ts chooses main dynamically, and solo mode loads the daemon dynamically at startup.
  // Include both main modules as roots so the check cannot pass merely because entry.ts is a tiny dispatcher.
  const roots = ["apps/cli/src/entry.ts", "apps/cli/src/main.ts", "packages/daemon/src/main.ts"]
  const eager = new Set<string>()
  const visit = (chunk: string) => {
    if (eager.has(chunk)) return
    eager.add(chunk)
    for (const edge of meta.outputs[chunk]?.imports ?? []) if (edge.kind !== "dynamic-import") visit(edge.path)
  }
  for (const root of roots) {
    const chunks = Object.entries(meta.outputs).filter(([, output]) => root in output.inputs)
    expect(chunks.length).toBeGreaterThan(0)
    for (const [chunk] of chunks) visit(chunk)
  }
  const files = [
    ...["pi", "acp", "claude"].flatMap((engine) => ["engine", "transport"].map((name) => `packages/engine-${engine}/src/${name}.ts`)),
    ...["amazon-bedrock", "aws-credentials", "gitlab-workflow", "anthropic-messages", "anthropic-thinking", "anthropic-threads", "google-gemini", "google-models", "google-vertex", "google-adc", "azure-openai", "azure-entra", "vertex-anthropic", "code-runtime", "code-library", "code-parser"].map((name) => `packages/engine-native/src/${name}.ts`),
  ]
  for (const file of files) {
    const chunks = Object.entries(meta.outputs).filter(([, output]) => file in output.inputs)
    expect(chunks.length, `${file} must still be bundled`).toBeGreaterThan(0)
    expect(chunks.filter(([chunk]) => eager.has(chunk)).map(([chunk]) => chunk), `${file} loads at startup`).toEqual([])
  }
})

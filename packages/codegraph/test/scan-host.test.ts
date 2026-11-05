import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createIndexer } from "../src/indexer"
import { HOSTED_SCAN_FILES, scanHostCommand } from "../src/scan-host"
import { project, put, useTempDirs } from "./helpers"

const temp = useTempDirs()

/** A project just past the hosted-scan size: modules that call each other, one unreadable binary and one file that changes. */
function bigProject() {
  const files: Record<string, string> = {}
  for (let i = 0; i < HOSTED_SCAN_FILES + 10; i++) {
    files[`src/m${i}.ts`] = `import { f${i + 1} } from "./m${i + 1}"\nexport function f${i}() { return f${i + 1}() }\nexport class C${i} { run() { f${i}() } }\n`
  }
  files["src/blob.ts"] = "binary\u0000content"
  return project({ root: temp(), files })
}

const graphOf = async (cwd: string, scanHost?: string[]) => {
  const scans: string[] = []
  const indexer = createIndexer({ cacheDir: temp(), now: () => 1_700_000_000_000, onScan: (path) => scans.push(path), scanHost })
  const graph = await indexer.graph({ cwd, signal: new AbortController().signal })
  return { indexer, graph, scans }
}
const shape = (graph: Awaited<ReturnType<typeof graphOf>>["graph"]) => ({ files: [...graph.files.keys()], nodes: graph.nodes, callees: [...graph.callees] })

describe("hosted scan", () => {
  test("a first build scanned in its own process gives the same graph, scan order and file count as one scanned in this process", async () => {
    const cwd = bigProject()
    const local = await graphOf(cwd)
    // The host leaves a mark, so a silent fallback to this process cannot pass for it.
    const mark = join(temp(), "started")
    const host = scanHostCommand()[1]!
    const hosted = await graphOf(cwd, [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "1"); await (await import(${JSON.stringify(host)})).runScanHost()`])
    expect(existsSync(mark)).toBe(true)
    expect(hosted.scans).toEqual(local.scans)
    expect(shape(hosted.graph)).toEqual(shape(local.graph))
    expect(hosted.graph.files.size).toBe(HOSTED_SCAN_FILES + 11)
  })

  test("a host that cannot start or dies leaves the scan to this process, with the same graph", async () => {
    const cwd = bigProject()
    const local = await graphOf(cwd)
    for (const command of [["/nonexistent/mendcode-scan-host"], ["false"], [process.execPath, "-e", 'console.log(JSON.stringify({ path: "elsewhere.ts", rec: null }))']]) {
      const failed = await graphOf(cwd, command)
      expect(shape(failed.graph)).toEqual(shape(local.graph))
      expect(failed.scans).toEqual(local.scans)
    }
  })

  test("a refresh with fewer files to scan than the threshold never starts a host", async () => {
    const cwd = bigProject()
    const { indexer } = await graphOf(cwd, scanHostCommand())
    put({ root: cwd, path: "src/m0.ts", content: "export function changed() {}\n", mtime: 1_800_000_000_000 })
    const graph = await indexer.graph({ cwd, signal: new AbortController().signal })
    expect(graph.nodes.some((node) => node.name === "changed")).toBe(true)
    const never = createIndexer({ cacheDir: temp(), now: Date.now, scanHost: ["/nonexistent/would-throw"] })
    const small = project({ root: temp(), files: { "a.ts": "export function a() {}\n" } })
    expect((await never.graph({ cwd: small, signal: new AbortController().signal })).files.size).toBe(1)
  })

  test("aborting a hosted build stops it with an abort error", async () => {
    const cwd = bigProject()
    const controller = new AbortController()
    const indexer = createIndexer({ cacheDir: temp(), now: Date.now, scanHost: scanHostCommand(), onScan: () => controller.abort() })
    await expect(indexer.graph({ cwd, signal: controller.signal })).rejects.toThrow("aborted")
  })
})

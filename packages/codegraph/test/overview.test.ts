import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { CODEGRAPH_OVERVIEW } from "@mendcode/protocol/wire"
import { createCodeOverview, createIndexer, fileOverview } from "../src"
import { project, useTempDirs } from "./helpers"

const temp = useTempDirs()
const signal = () => new AbortController().signal
const indexer = (cacheDir: string, scans: string[] = []) => createIndexer({ cacheDir, now: () => 1_700_000_000_000, onScan: (path) => scans.push(path) })

const FILES = {
  "src/hub.ts": "export function hub() { return 1 }\n",
  "src/a.ts": "import { hub } from \"./hub\"\nimport { b } from \"./b\"\nexport function a() { return hub() + b() }\n",
  "src/b.ts": "import { hub } from \"./hub\"\nexport function b() { return hub() }\n",
  "src/lonely.ts": "export const lonely = 1\n",
}

describe("the overview of a built graph", () => {
  test("files are ranked by imports, importers and crossing calls, with the links among them", async () => {
    const root = project({ root: temp(), files: FILES })
    const report = fileOverview({ graph: await indexer(temp()).graph({ cwd: root, signal: signal() }) })
    // Every connected file here is joined to the other two (an import and a call to the same file count once), so the path decides; the
    // file nothing imports or calls still holds a symbol, so it comes after them with no links.
    expect(report.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts", "src/hub.ts", expect.any(String)])
    expect(report.files[3]).toMatchObject({ degree: 0, imports: 0, importedBy: 0 })
    expect(report.files[0]).toEqual({ path: "src/a.ts", imports: 2, importedBy: 0, calls: 2, degree: 2, symbols: 1, topImports: ["src/b.ts", "src/hub.ts"], topImportedBy: [] })
    expect(report.files[1]).toMatchObject({ path: "src/b.ts", imports: 1, importedBy: 1, calls: 2, degree: 2, topImports: ["src/hub.ts"], topImportedBy: ["src/a.ts"] })
    expect(report.files[2]).toMatchObject({ path: "src/hub.ts", imports: 0, importedBy: 2, calls: 2, degree: 2, topImportedBy: ["src/a.ts", "src/b.ts"] })
    expect(report.edges).toEqual([[0, 1], [0, 2], [1, 2]])
    expect(report.total).toEqual({ files: 4, symbols: 4 })
    expect(report).toMatchObject({ state: "ready", omittedEdges: 0, partial: false, builtAt: 1_700_000_000_000 })
  })

  test("a project whose files never link still lists them, the most symbols first, so the galaxy is never empty next to an indexed graph", async () => {
    const root = project({ root: temp(), files: { "solo.ts": "export const a = 1\nexport const b = 2\n", "one.ts": "export const c = 3\n" } })
    const report = fileOverview({ graph: await indexer(temp()).graph({ cwd: root, signal: signal() }) })
    expect(report.files.map((file) => [file.path, file.degree, file.symbols])).toEqual([["solo.ts", 0, 2], ["one.ts", 0, 1]])
    expect(report.edges).toEqual([])
  })

  test("the reply is bounded whatever the project holds: files, edges, neighbours and path length", async () => {
    const names = Array.from({ length: 40 }, (_, index) => `m${String(index).padStart(2, "0")}`)
    const long = `${"deep/".repeat(60)}long.ts`
    const files: Record<string, string> = { [long]: `${names.map((name) => `import { ${name} } from "${"../".repeat(60)}${name}"`).join("\n")}\nexport const long = 1\n` }
    for (const name of names) files[`${name}.ts`] = `${names.filter((other) => other !== name).map((other) => `import { ${other} } from "./${other}"`).join("\n")}\nexport const ${name} = 1\n`
    const root = project({ root: temp(), files })
    const graph = await indexer(temp()).graph({ cwd: root, signal: signal() })
    expect(long.length).toBeGreaterThan(CODEGRAPH_OVERVIEW.path)
    expect(graph.files.get(long)?.imports.length).toBe(40)
    const report = fileOverview({ graph, limit: 999 })
    expect(report.files).toHaveLength(CODEGRAPH_OVERVIEW.files)
    expect(report.edges).toHaveLength(CODEGRAPH_OVERVIEW.edges)
    expect(report.omittedEdges).toBe(30 * 29 - CODEGRAPH_OVERVIEW.edges)
    for (const [from, to] of report.edges) expect(from !== to && from >= 0 && to >= 0 && from < 30 && to < 30).toBe(true)
    for (const file of report.files) {
      expect(file.path.length).toBeLessThanOrEqual(CODEGRAPH_OVERVIEW.path)
      expect(file.path.startsWith("/")).toBe(false)
      expect(file.topImports.length).toBeLessThanOrEqual(CODEGRAPH_OVERVIEW.neighbours)
      expect(file.topImportedBy.length).toBeLessThanOrEqual(CODEGRAPH_OVERVIEW.neighbours)
      expect([...file.topImports, ...file.topImportedBy]).not.toContain(long)
    }
    expect(report.files.some((file) => file.path === long)).toBe(false)
    expect(fileOverview({ graph, limit: 5 }).files).toHaveLength(5)
    expect(JSON.stringify(report).length).toBeLessThan(40_000)
  })
})

describe("codegraph.overview for a daemon", () => {
  test("the home folder and the directories above it are refused and nothing is read or written", async () => {
    const home = project({ root: temp(), files: FILES })
    const cacheDir = join(temp(), "cache")
    const scans: string[] = []
    const overview = createCodeOverview({ indexer: indexer(cacheDir, scans), home })
    expect(await overview({ directory: home, signal: signal() })).toEqual({ state: "off", reason: "not a project" })
    expect(await overview({ directory: join(home, ".."), signal: signal() })).toMatchObject({ state: "off" })
    expect(scans).toEqual([])
    expect(existsSync(cacheDir)).toBe(false)
  })

  test("a project inside the home folder is built on the request and refreshed without re-reading unchanged files", async () => {
    const home = temp()
    const root = project({ root: join(home, "app"), files: FILES })
    const cacheDir = join(temp(), "cache")
    const scans: string[] = []
    const overview = createCodeOverview({ indexer: indexer(cacheDir, scans), home })
    expect(scans).toEqual([])
    const first = await overview({ directory: root, signal: signal() })
    expect(first).toMatchObject({ state: "ready", total: { files: 4 } })
    expect(scans.sort()).toEqual(Object.keys(FILES).sort())
    expect(readdirSync(cacheDir)).toHaveLength(1)
    expect(await overview({ directory: root, signal: signal() })).toEqual(first)
    expect(scans).toHaveLength(4)
  })

  test("a failed or cancelled build is one bounded reason, never a throw", async () => {
    const root = project({ root: join(temp(), "app"), files: FILES })
    const home = temp()
    const gone = new AbortController()
    gone.abort()
    expect(await createCodeOverview({ indexer: indexer(temp()), home })({ directory: root, signal: gone.signal })).toEqual({ state: "failed", reason: "cancelled" })
    expect(await createCodeOverview({ indexer: indexer(temp()), home })({ directory: "relative/app", signal: signal() })).toEqual({ state: "failed", reason: "the directory is not an absolute path" })
    const broken = { ...indexer(temp()), graph: () => Promise.reject(new Error(`disk\n${"x".repeat(500)}`)) }
    const failed = await createCodeOverview({ indexer: broken, home })({ directory: root, signal: signal() })
    expect(failed.state).toBe("failed")
    expect(failed.state === "failed" && failed.reason.length).toBe(CODEGRAPH_OVERVIEW.reason)
    expect(failed.state === "failed" && failed.reason.startsWith("disk x")).toBe(true)
    mkdirSync(join(home, "empty"))
    expect(await createCodeOverview({ indexer: indexer(temp()), home })({ directory: join(home, "empty"), signal: signal() })).toMatchObject({ state: "ready", files: [], edges: [] })
  })
})

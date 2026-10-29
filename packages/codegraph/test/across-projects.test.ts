import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { TS_PROJECT } from "./fixtures"
import { harness, project, useTempDirs } from "./helpers"

const tmp = useTempDirs()

describe("a path in another project", () => {
  test("is answered from that project's graph when it was indexed before, its paths relative to it", async () => {
    const cacheDir = tmp()
    const other = harness({ root: project({ root: tmp(), files: TS_PROJECT }), cacheDir })
    expect((await other.call("graph_find", { query: "helper" })).isError).toBe(false)
    const here = harness({ root: project({ root: tmp(), files: { "src/own.ts": "export function own() { return 1 }\n" } }), cacheDir })
    const found = await here.call("graph_find", { query: "helper", path: other.root })
    expect(found.isError).toBe(false)
    expect(found.output).toStartWith(`From the code graph of ${other.root} (its paths are relative to that folder):\n`)
    expect(found.output).toContain("helper")
    const map = await here.call("graph_map", { path: join(other.root, "src") })
    expect(map.output).toStartWith(`From the code graph of ${other.root}`)
  })

  test("of a folder nobody indexed is outside the project, and that folder is not indexed for it", async () => {
    const cacheDir = tmp()
    const here = harness({ root: project({ root: tmp(), files: TS_PROJECT }), cacheDir })
    const outside = project({ root: tmp(), files: TS_PROJECT })
    const found = await here.call("graph_find", { query: "helper", path: outside })
    expect(found).toMatchObject({ isError: true, output: expect.stringContaining("outside the project, and no code graph of another project covers it") })
    expect(readdirSync(cacheDir)).toEqual([])
  })
})

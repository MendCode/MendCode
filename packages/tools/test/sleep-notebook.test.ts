import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { notebookEdit, runTool, sleep } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tempDir = useTempDir()

describe("sleep", () => {
  test("waits for the requested time and a turn cancel ends it at once", async () => {
    const dir = tempDir()
    const t0 = Date.now()
    const waited = await runTool(sleep, { ms: 120, reason: "boot" }, makeContext({ cwd: dir }))
    expect(waited).toMatchObject({ isError: false, title: expect.stringContaining("boot") })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)

    const controller = new AbortController()
    const pending = runTool(sleep, { ms: 60_000 }, makeContext({ cwd: dir, signal: controller.signal }))
    setTimeout(() => controller.abort(), 30)
    const t1 = Date.now()
    expect(await pending).toMatchObject({ isError: true, output: "cancelled" })
    expect(Date.now() - t1).toBeLessThan(2_000)
  })

  test("a wait over the cap or under 1 ms is refused", async () => {
    const context = makeContext({ cwd: tempDir() })
    expect((await runTool(sleep, { ms: 300_001 }, context)).isError).toBe(true)
    expect((await runTool(sleep, { ms: 0 }, context)).isError).toBe(true)
    expect(sleep.permission).toBe("read")
  })
})

const NOTEBOOK = {
  cells: [
    { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Title\n", "text"] },
    { cell_type: "code", id: "calc", metadata: { tags: ["keep"] }, execution_count: 4, outputs: [{ output_type: "stream", name: "stdout", text: ["3\n"] }], source: ["print(1 + 2)"] },
    { cell_type: "code", id: "tail", metadata: {}, execution_count: null, outputs: [], source: [] },
  ],
  metadata: { kernelspec: { name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
}

function notebook(dir: string) {
  writeFileSync(join(dir, "n.ipynb"), `${JSON.stringify(NOTEBOOK, null, 1)}\n`)
  return () => JSON.parse(readFileSync(join(dir, "n.ipynb"), "utf8")) as typeof NOTEBOOK
}

describe("notebook_edit", () => {
  test("replace changes one cell's source, clears a code cell's outputs and keeps everything else", async () => {
    const dir = tempDir()
    const load = notebook(dir)
    const result = await runTool(notebookEdit, { path: "n.ipynb", action: "replace", cellId: "calc", source: "x = 1\nprint(x)" }, makeContext({ cwd: dir }))
    expect(result).toMatchObject({ isError: false, output: expect.stringContaining("replaced [1] code calc") })
    const after = load()
    expect(after.cells[1]).toMatchObject({ id: "calc", source: ["x = 1\n", "print(x)"], outputs: [], execution_count: null, metadata: { tags: ["keep"] } })
    expect(after.cells[0]).toEqual(NOTEBOOK.cells[0])
    expect(after.metadata).toEqual(NOTEBOOK.metadata)
    expect(after.nbformat_minor).toBe(5)
  })

  test("insert adds a cell by index or after an id, with an id of its own in nbformat 4.5", async () => {
    const dir = tempDir()
    const load = notebook(dir)
    await runTool(notebookEdit, { path: "n.ipynb", action: "insert", cellIndex: 0, cellType: "markdown", source: "first" }, makeContext({ cwd: dir }))
    await runTool(notebookEdit, { path: "n.ipynb", action: "insert", cellId: "calc", source: "after calc" }, makeContext({ cwd: dir }))
    await runTool(notebookEdit, { path: "n.ipynb", action: "insert", source: "last" }, makeContext({ cwd: dir }))
    const cells = load().cells as Array<{ cell_type: string; id: string; source: string[]; outputs?: unknown[] }>
    expect(cells.map((cell) => cell.source.join(""))).toEqual(["first", "# Title\ntext", "print(1 + 2)", "after calc", "", "last"])
    expect(cells[0]).toMatchObject({ cell_type: "markdown" })
    expect(cells[0]).not.toHaveProperty("outputs")
    expect(cells[3]).toMatchObject({ cell_type: "code", outputs: [] })
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(cells.length)
  })

  test("delete removes a cell, and a change of type drops code-only fields", async () => {
    const dir = tempDir()
    const load = notebook(dir)
    await runTool(notebookEdit, { path: "n.ipynb", action: "delete", cellIndex: 2 }, makeContext({ cwd: dir }))
    await runTool(notebookEdit, { path: "n.ipynb", action: "replace", cellId: "calc", cellType: "markdown" }, makeContext({ cwd: dir }))
    const cells = load().cells
    expect(cells).toHaveLength(2)
    expect(cells[1]).toMatchObject({ cell_type: "markdown", source: ["print(1 + 2)"] })
    expect(cells[1]).not.toHaveProperty("outputs")
    expect(cells[1]).not.toHaveProperty("execution_count")
  })

  test("bad targets and files are reported without writing", async () => {
    const dir = tempDir()
    const load = notebook(dir)
    const context = makeContext({ cwd: dir })
    expect(await runTool(notebookEdit, { path: "n.ipynb", action: "replace", cellId: "nope", source: "x" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("no cell with id nope") })
    expect(await runTool(notebookEdit, { path: "n.ipynb", action: "delete", cellIndex: 9 }, context)).toMatchObject({ isError: true, output: expect.stringContaining("out of range") })
    expect(await runTool(notebookEdit, { path: "n.ipynb", action: "replace", source: "x" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("cellId or cellIndex") })
    expect(await runTool(notebookEdit, { path: "n.ipynb", action: "insert" }, context)).toMatchObject({ isError: true })
    writeFileSync(join(dir, "plain.txt"), "x")
    expect(await runTool(notebookEdit, { path: "plain.txt", action: "delete", cellIndex: 0 }, context)).toMatchObject({ isError: true, output: expect.stringContaining(".ipynb") })
    writeFileSync(join(dir, "broken.ipynb"), "{nope")
    expect(await runTool(notebookEdit, { path: "broken.ipynb", action: "delete", cellIndex: 0 }, context)).toMatchObject({ isError: true, output: expect.stringContaining("not valid JSON") })
    expect(await runTool(notebookEdit, { path: "missing.ipynb", action: "delete", cellIndex: 0 }, context)).toMatchObject({ isError: true })
    expect(load()).toEqual(NOTEBOOK)
    expect(notebookEdit.permission).toBe("write")
  })

  test("the approval preview says what would change and writes nothing", async () => {
    const dir = tempDir()
    const load = notebook(dir)
    const preview = await notebookEdit.preview?.({ path: "n.ipynb", action: "delete", cellId: "intro" }, makeContext({ cwd: dir }))
    expect(preview).toContain("deleted [0] markdown intro")
    expect(await notebookEdit.preview?.({ path: "n.ipynb", action: "delete", cellId: "nope" }, makeContext({ cwd: dir }))).toBeUndefined()
    expect(load()).toEqual(NOTEBOOK)
  })
})

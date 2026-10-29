import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { defineTool } from "../tool"
import { atomicWrite, boundPreview, displayPath, errorMessage, fail, resolvePath, succeed, withFileLock } from "../util"

type Cell = { cell_type: "code" | "markdown" | "raw"; id?: string; metadata: Record<string, unknown>; source: string | string[]; outputs?: unknown[]; execution_count?: number | null }
type Notebook = { cells: Cell[]; nbformat?: number; nbformat_minor?: number; [key: string]: unknown }
type Plan = { notebook: Notebook; summary: string }

const MAX_NOTEBOOK_BYTES = 20 * 1024 * 1024

/** Jupyter stores source as a list of lines, each keeping its newline. */
function toLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/)
}

const sourceText = (cell: Cell) => (Array.isArray(cell.source) ? cell.source.join("") : cell.source)

function describe(cell: Cell, index: number) {
  const first = sourceText(cell).split("\n")[0]!.trim()
  return `[${index}] ${cell.cell_type}${cell.id ? ` ${cell.id}` : ""}${first ? ` · ${first.slice(0, 60)}` : ""}`
}

function parse(text: string): Notebook | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return "not valid JSON; is it a .ipynb file?"
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as Notebook).cells)) return "not a notebook: no cells list"
  return value as Notebook
}

function locate({ notebook, cellId, cellIndex }: { notebook: Notebook; cellId?: string | undefined; cellIndex?: number | undefined }): number | string {
  if (cellId !== undefined) {
    const found = notebook.cells.findIndex((cell) => cell.id === cellId)
    return found === -1 ? `no cell with id ${cellId}` : found
  }
  if (cellIndex === undefined) return "give cellId or cellIndex"
  return cellIndex >= notebook.cells.length ? `cellIndex ${cellIndex} is out of range (the notebook has ${notebook.cells.length} cells)` : cellIndex
}

const ARGS = z.object({
  path: z.string().describe("Notebook (.ipynb) path, absolute or relative to the project root"),
  action: z.enum(["replace", "insert", "delete"]).describe("replace a cell's source, insert a new cell, or delete a cell"),
  cellId: z.string().optional().describe("Target cell id (replace/delete), or the cell to insert after (insert)"),
  cellIndex: z.number().int().min(0).optional().describe("Target cell position, 0-based (replace/delete), or the position to insert at (insert; default: the end)"),
  cellType: z.enum(["code", "markdown", "raw"]).optional().describe("insert: type of the new cell (default code); replace: change the cell type"),
  source: z.string().optional().describe("replace/insert: the new cell source"),
})

async function plan(args: z.infer<typeof ARGS>, abs: string): Promise<Plan | string> {
  const { action, cellId, cellIndex, cellType, source } = args
  if (!abs.endsWith(".ipynb")) return "notebook_edit only edits .ipynb files; use edit for other files"
  const raw = await readFile(abs, "utf8")
  if (raw.length > MAX_NOTEBOOK_BYTES) return "notebook is too large to edit"
  const notebook = parse(raw)
  if (typeof notebook === "string") return notebook
  const cells = notebook.cells
  if (action === "insert") {
    if (source === undefined) return "insert needs source"
    let at = cells.length
    if (cellId !== undefined) {
      const found = cells.findIndex((cell) => cell.id === cellId)
      if (found === -1) return `no cell with id ${cellId}`
      at = found + 1
    } else if (cellIndex !== undefined) {
      if (cellIndex > cells.length) return `cellIndex ${cellIndex} is out of range (the notebook has ${cells.length} cells)`
      at = cellIndex
    }
    const type = cellType ?? "code"
    const cell: Cell = { cell_type: type, metadata: {}, source: toLines(source) }
    if (type === "code") {
      cell.execution_count = null
      cell.outputs = []
    }
    if ((notebook.nbformat ?? 4) >= 4 && (notebook.nbformat_minor ?? 0) >= 5) cell.id = randomBytes(4).toString("hex")
    cells.splice(at, 0, cell)
    return { notebook, summary: `inserted ${describe(cell, at)}` }
  }
  const at = locate({ notebook, cellId, cellIndex })
  if (typeof at === "string") return at
  const cell = cells[at]!
  if (action === "delete") {
    cells.splice(at, 1)
    return { notebook, summary: `deleted ${describe(cell, at)}` }
  }
  if (source === undefined && cellType === undefined) return "replace needs source or cellType"
  const before = describe(cell, at)
  if (source !== undefined) cell.source = toLines(source)
  if (cellType !== undefined && cellType !== cell.cell_type) {
    cell.cell_type = cellType
    if (cellType === "code") {
      cell.execution_count = null
      cell.outputs = []
    } else {
      delete cell.execution_count
      delete cell.outputs
    }
  } else if (cell.cell_type === "code" && source !== undefined) {
    // Stale outputs of the old code would mislead the next reader.
    cell.outputs = []
    cell.execution_count = null
  }
  return { notebook, summary: `replaced ${before}\n  now ${describe(cell, at)}` }
}

export default defineTool({
  name: "notebook_edit",
  description:
    "Edit a Jupyter notebook (.ipynb) by cell: replace a cell's source (and optionally its type), insert a new cell, or delete one. Address cells by cellId or 0-based cellIndex. Replacing a code cell clears its outputs. Other cells, metadata and outputs are left untouched; read the notebook first to find the cells.",
  permission: "write",
  args: ARGS,
  async execute(args, context) {
    const abs = resolvePath({ cwd: context.cwd, path: args.path })
    const shown = displayPath({ cwd: context.cwd, path: abs })
    const title = `NotebookEdit ${shown}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      const planned = await withFileLock([abs], async () => {
        const planned = await plan(args, abs)
        if (typeof planned !== "string") await atomicWrite({ path: abs, content: `${JSON.stringify(planned.notebook, null, 1)}\n` })
        return planned
      })
      if (typeof planned === "string") return fail({ title, message: `${shown}: ${planned}` })
      return succeed({ title, output: `${shown}: ${planned.summary}\n${planned.notebook.cells.length} cells`, truncated: false, meta: { path: abs, cells: planned.notebook.cells.length } })
    } catch (error) {
      return fail({ title, message: `cannot edit ${shown}: ${errorMessage(error)}` })
    }
  },
  async preview(args, context) {
    try {
      const abs = resolvePath({ cwd: context.cwd, path: args.path })
      const planned = await plan(args, abs)
      return typeof planned === "string" ? undefined : boundPreview(`${displayPath({ cwd: context.cwd, path: abs })}: ${planned.summary}${args.source ? `\n\n${args.source}` : ""}`)
    } catch {
      return undefined
    }
  },
})

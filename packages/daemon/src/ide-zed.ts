import { Database } from "bun:sqlite"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { IdePosition, IdeReport, IdeSelection } from "@mendcode/protocol/wire"

const MAX_BUFFER_BYTES = 1024 * 1024
const MAX_SELECTED_CHARS = 32 * 1024
export type ZedResult = Pick<IdeReport, "status" | "selection" | "message">
type Active = { kind: string; item: number | null; workspace: number; paths: string | null; timestamp: string; file: string | null }

export function contains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function roots(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && path.isAbsolute(item))
  } catch {}
  return value.split(/\r?\n/).filter((item) => path.isAbsolute(item))
}

/** Zed offsets are UTF-8 bytes; reported columns are one-based UTF-16 positions, like v1. */
export function zedPosition(text: string, byteOffset: number): { index: number; position: IdePosition } {
  let index = 0, bytes = 0, line = 1, character = 1
  for (const point of text) {
    if (bytes >= byteOffset) break
    bytes += Buffer.byteLength(point, "utf8")
    index += point.length
    if (point === "\n") { line++; character = 1 }
    else character += point.length
  }
  return { index, position: { line, character } }
}

export function zedDbPath(override?: string) {
  if (override) return override
  if (process.env.MENDCODE_ZED_DB) return process.env.MENDCODE_ZED_DB
  return [
    path.join(homedir(), "Library", "Application Support", "Zed", "db", "0-stable", "db.sqlite"),
    path.join(homedir(), ".local", "share", "zed", "db", "0-stable", "db.sqlite"),
  ].find((candidate) => { try { return statSync(candidate).isFile() } catch { return false } })
}

/** One read transaction keeps editor, ranges and unsaved contents from different snapshots apart. */
export async function readZedSelection(directory: string, configuredPath?: string): Promise<ZedResult> {
  const dbPath = zedDbPath(configuredPath)
  if (!dbPath) return { status: "unavailable", message: "Zed database not found" }
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    db.exec("BEGIN")
    const active = db.query<Active, []>(`select i.kind as kind, e.item_id as item, i.workspace_id as workspace,
      w.paths as paths, w.timestamp as timestamp, e.buffer_path as file
      from items i join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id
      join workspaces w on w.workspace_id = i.workspace_id
      left join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id
      where i.active = 1 and p.active = 1 order by w.timestamp desc limit 256`).all()
    const best = active.map((row) => ({ row, score: Math.max(0, ...roots(row.paths).filter((root) => contains(root, directory)).map((root) => path.resolve(root).length)) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.row.timestamp.localeCompare(a.row.timestamp))[0]?.row
    if (!best) return { status: "empty" }
    if (best.kind !== "Editor") return { status: "unavailable", message: "Zed active pane is not an editor" }
    if (!best.file || best.item === null) return { status: "empty" }
    if (!path.isAbsolute(best.file) || !contains(directory, best.file)) return { status: "empty" }
    const ranges = db.query<{ start: number | null; end: number | null }, [number, number]>("select start, end from editor_selections where editor_id = ? and workspace_id = ? limit 65").all(best.item, best.workspace)
    if (!ranges.length || ranges.length > 64 || ranges.some(({ start, end }) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 0 || end! < 0)) return { status: "unavailable", message: "Zed selection is unavailable" }
    // Older database versions lack contents. Use disk only when the editor has no saved buffer snapshot.
    let contents: string | null = null
    try { contents = db.query<{ contents: string | null }, [number, number]>("select contents from editors where item_id = ? and workspace_id = ?").get(best.item, best.workspace)?.contents ?? null } catch {}
    db.exec("COMMIT")
    db.close()
    db = undefined
    if (contents === null) {
      const target = realpathSync(best.file)
      if (!contains(realpathSync(directory), target)) return { status: "empty" }
      const file = Bun.file(target)
      if (file.size > MAX_BUFFER_BYTES) return { status: "unavailable", message: "Zed buffer exceeds 1 MiB" }
      contents = await file.text()
    }
    if (Buffer.byteLength(contents, "utf8") > MAX_BUFFER_BYTES) return { status: "unavailable", message: "Zed buffer exceeds 1 MiB" }
    const bytes = Buffer.byteLength(contents, "utf8")
    if (ranges.some(({ start, end }) => start! > bytes || end! > bytes)) return { status: "unavailable", message: "Zed selection is outside the buffer" }
    const selection: IdeSelection = { filePath: best.file, source: "zed", ranges: ranges.map(({ start, end }) => {
      const from = zedPosition(contents!, Math.min(start!, end!))
      const to = zedPosition(contents!, Math.max(start!, end!))
      return { text: contents!.slice(from.index, to.index), selection: { start: from.position, end: to.position } }
    }).sort((a, b) => a.selection.start.line - b.selection.start.line || a.selection.start.character - b.selection.start.character) }
    if (selection.ranges.reduce((total, range) => total + range.text.length, 0) > MAX_SELECTED_CHARS) return { status: "unavailable", message: "Zed selection exceeds 32 KiB" }
    return { status: "connected", selection }
  } catch { return { status: "unavailable", message: "Zed database cannot be read" } }
  finally { db?.close() }
}

export async function openZedFile(file: string, line: number, character: number) {
  const program = Bun.which("zed")
  if (!program) return { opened: false, message: "zed is not installed in the daemon PATH" }
  try {
    const child = Bun.spawn([program, `${file}:${line}:${character}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), 5_000)
    try { return (await child.exited) === 0 ? { opened: true } : { opened: false, message: "Zed could not open the file" } }
    finally { clearTimeout(timer) }
  } catch { return { opened: false, message: "Zed could not start" } }
}

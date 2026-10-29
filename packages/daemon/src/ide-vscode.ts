import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { IdeReport, IdeSelection } from "@mendcode/protocol/wire"
import { contains } from "./ide-zed"

/**
 * VS Code adapter. The extension in `editors/vscode` publishes the active editor's selection to
 * `<data dir>/ide/vscode/<workspace hash>.json` (mode 600, replaced whole); the daemon only reads those files,
 * and only for a project that opted in. Nothing here talks to the editor over the network.
 */
export const VSCODE_STALE_MS = 90_000
const MAX_FILES = 64
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_RANGES = 64
const MAX_SELECTED_CHARS = 32 * 1024
const position = z.strictObject({ line: z.number().int().positive(), character: z.number().int().positive() })
export const VscodeRecord = z.object({
  v: z.literal(1),
  app: z.string().max(100).optional(),
  workspace: z.string().min(1).max(4096),
  updatedAt: z.number().int().nonnegative(),
  filePath: z.string().min(1).max(4096).optional(),
  ranges: z.array(z.object({ text: z.string(), selection: z.strictObject({ start: position, end: position }) })).max(1_000).optional(),
})
type VscodeRecord = z.infer<typeof VscodeRecord>
type Result = Pick<IdeReport, "status" | "selection" | "message">
type Match = { record: VscodeRecord } | { result: Result }

/** Editor family reported by `vscode.env.appName` mapped to the command-line launcher that opens a file there. */
export function vscodeLauncher(app: string | undefined) {
  const name = (app ?? "").toLowerCase()
  if (name.includes("cursor")) return "cursor"
  if (name.includes("windsurf")) return "windsurf"
  if (name.includes("vscodium")) return "codium"
  if (name.includes("insiders")) return "code-insiders"
  return "code"
}

function realOrNull(target: string) {
  try { return realpathSync(target) } catch { return null }
}

function records(dir: string): VscodeRecord[] | undefined {
  const folder = path.join(dir, "ide", "vscode")
  let names: string[]
  try { names = readdirSync(folder).filter((name) => name.endsWith(".json")).slice(0, MAX_FILES) } catch { return undefined }
  const found: VscodeRecord[] = []
  for (const name of names) {
    try {
      const file = path.join(folder, name)
      if (statSync(file).size > MAX_FILE_BYTES) continue
      const parsed = VscodeRecord.safeParse(JSON.parse(readFileSync(file, "utf8")))
      if (parsed.success) found.push(parsed.data)
    } catch { /* a half-written or foreign file never breaks the bridge */ }
  }
  return found
}

function match(dir: string, directory: string, now: number): Match {
  const all = records(dir)
  if (!all) return { result: { status: "unavailable", message: "VS Code extension has not published yet; install editors/vscode and enable mendcode.shareContext" } }
  const root = realOrNull(directory) ?? directory
  const candidates = all.map((record) => ({ record, workspace: realOrNull(record.workspace) ?? record.workspace }))
    .filter(({ workspace }) => path.isAbsolute(workspace) && (contains(workspace, root) || contains(root, workspace)))
    .sort((a, b) => (contains(b.workspace, root) ? b.workspace.length : 0) - (contains(a.workspace, root) ? a.workspace.length : 0) || b.record.updatedAt - a.record.updatedAt)
  const best = candidates[0]?.record
  if (!best) return { result: { status: "empty" } }
  if (now - best.updatedAt > VSCODE_STALE_MS) return { result: { status: "unavailable", message: "VS Code stopped publishing; reload the window or check mendcode.shareContext" } }
  return { record: best }
}

export async function readVscodeSelection(dir: string, directory: string, now = Date.now()): Promise<Result> {
  const found = match(dir, directory, now)
  if ("result" in found) return found.result
  const { record } = found
  const root = realOrNull(directory)
  if (!root || !record.filePath || !record.ranges?.length) return { status: "empty" }
  const file = realOrNull(record.filePath)
  // An external file, a symlink out of the project or an unsaved buffer is never attached.
  if (!file || !path.isAbsolute(record.filePath) || !contains(root, file)) return { status: "empty" }
  try { if (!statSync(file).isFile()) return { status: "empty" } } catch { return { status: "empty" } }
  if (record.ranges.length > MAX_RANGES) return { status: "unavailable", message: "VS Code selection has more than 64 ranges" }
  if (record.ranges.some((range) => range.text.length > MAX_SELECTED_CHARS)) return { status: "unavailable", message: "VS Code selection is larger than 32 KiB" }
  const selection: IdeSelection = { filePath: file, source: "vscode", ranges: record.ranges }
  return { status: "connected", selection }
}

export async function openVscodeFile(dir: string, directory: string, file: string, line: number, character: number) {
  const found = match(dir, directory, Date.now())
  const launcher = process.env.MENDCODE_VSCODE_BIN ?? vscodeLauncher("record" in found ? found.record.app : undefined)
  const program = Bun.which(launcher)
  if (!program) return { opened: false, message: `${launcher} is not installed in the daemon PATH` }
  try {
    const child = Bun.spawn([program, "--goto", `${file}:${line}:${character}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), 5_000)
    try { return (await child.exited) === 0 ? { opened: true } : { opened: false, message: "VS Code could not open the file" } }
    finally { clearTimeout(timer) }
  } catch { return { opened: false, message: "VS Code could not start" } }
}

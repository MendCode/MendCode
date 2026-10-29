import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { IdeConfiguration } from "@mendcode/protocol"
import type { IdeEditorName, IdeOpenReport, IdeReport } from "@mendcode/protocol/wire"
import { contains, openZedFile, readZedSelection, type ZedResult } from "./ide-zed"
import { openVscodeFile, readVscodeSelection } from "./ide-vscode"

export type IdeAdapter = {
  selection(directory: string, dbPath?: string): Promise<ZedResult>
  open(file: string, line: number, character: number): Promise<IdeOpenReport>
  /** VS Code (and forks) through the published-selection files of the extension; tests supply a fake. */
  vscode?: {
    selection(directory: string): Promise<ZedResult>
    open(directory: string, file: string, line: number, character: number): Promise<IdeOpenReport>
  }
}

export function createIdeBridge(dir: string, adapter: IdeAdapter = { selection: readZedSelection, open: openZedFile }) {
  const vscode = adapter.vscode ?? { selection: (directory: string) => readVscodeSelection(dir, directory), open: (directory: string, file: string, line: number, character: number) => openVscodeFile(dir, directory, file, line, character) }
  const project = (directory: string) => realpathSync(directory)
  const configFile = (directory: string) => path.join(dir, "ide", `${createHash("sha256").update(project(directory)).digest("hex")}.json`)
  function configuration(directory: string) {
    try { return IdeConfiguration.parse(JSON.parse(readFileSync(configFile(directory), "utf8"))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false }; throw new Error("IDE configuration cannot be read") }
  }
  const editorOf = (config: { editor?: IdeEditorName | undefined }): IdeEditorName => config.editor ?? "zed"
  async function query(directory: string): Promise<IdeReport> {
    const config = configuration(directory)
    const editor = editorOf(config)
    if (!config.enabled) return { editor, enabled: false, status: "off" }
    return { editor, enabled: true, ...(editor === "vscode" ? await vscode.selection(project(directory)) : await adapter.selection(project(directory), config.dbPath)) }
  }
  async function configure(directory: string, enabled: boolean, dbPath?: string, editor?: IdeEditorName) {
    const previous = configuration(directory)
    if (dbPath && !path.isAbsolute(dbPath)) throw new Error("Zed database path must be absolute")
    const chosen = editor ?? editorOf(previous)
    if (dbPath && chosen !== "zed") throw new Error("A database path only applies to Zed")
    // A database path belongs to Zed; switching editors drops it.
    const { dbPath: previousPath } = previous
    const config = IdeConfiguration.parse({ enabled, ...(chosen === "vscode" ? { editor: chosen } : {}), ...(chosen === "zed" && (dbPath ?? previousPath) ? { dbPath: dbPath ?? previousPath } : {}) })
    const file = configFile(directory)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(config), { mode: 0o600 })
    renameSync(temp, file)
    return query(directory)
  }
  async function open(directory: string, file: string, line = 1, character = 1): Promise<IdeOpenReport> {
    const config = configuration(directory)
    if (!config.enabled) return { opened: false, message: "IDE bridge is off" }
    const root = project(directory)
    let target: string
    try { target = realpathSync(path.resolve(root, file)) } catch { return { opened: false, message: "File not found" } }
    if (!contains(root, target) || !statSync(target).isFile()) return { opened: false, message: "File must be inside the project" }
    return editorOf(config) === "vscode" ? vscode.open(root, target, line, character) : adapter.open(target, line, character)
  }
  return { query, configure, open }
}

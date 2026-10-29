import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { WorkspaceInfo } from "@mendcode/protocol"

/** Local provisioner registers existing directories; removing a workspace never deletes its files. */
export function createWorkspaces(dir: string, defaultDirectory: string) {
  const file = path.join(dir, "http-workspaces.json")
  const root = canonical(defaultDirectory)
  let items: WorkspaceInfo[] = []
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(value) || value.length > 1000 || value.some((item) => !item || !/^ws_[a-f0-9]{24}$/.test(item.id) || typeof item.name !== "string" || item.name.length > 100 || typeof item.directory !== "string" || !path.isAbsolute(item.directory) || item.type !== "local")) throw new Error("invalid HTTP workspace store")
    items = value
  }
  function save() {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(items)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }
  function canonical(directory: string) {
    const resolved = realpathSync(directory)
    if (!statSync(resolved).isDirectory()) throw new Error("workspace directory is not a directory")
    return resolved
  }
  return {
    list: () => items.map((item) => ({ ...item })),
    adapters: () => [{ type: "local", name: "Local directory", provision: "existing-directory" }],
    status: () => items.map((item) => ({ workspaceID: item.id, status: existsSync(item.directory) ? "connected" : "disconnected" })),
    create(name: string, directory: string, id?: string): WorkspaceInfo {
      const resolved = canonical(directory)
      if (items.length >= 1000) throw new Error("workspace limit reached")
      if (items.some((item) => item.directory === resolved || item.name === name)) throw new Error("workspace already registered")
      if (id && (!/^ws_[a-f0-9]{24}$/.test(id) || items.some((item) => item.id === id))) throw new Error("workspace ID already registered or invalid")
      const item: WorkspaceInfo = { id: id ?? `ws_${randomBytes(12).toString("hex")}`, type: "local", name, directory: resolved }
      items.push(item)
      try { save() } catch (error) { items.pop(); throw error }
      return { ...item }
    },
    remove(id: string) {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) throw new Error("unknown workspace")
      const previous = [...items]
      const [item] = items.splice(index, 1)
      try { save() } catch (error) { items = previous; throw error }
      return item
    },
    resolve(input: { directory?: string | undefined; workspaceId?: string | undefined }) {
      if (input.workspaceId) {
        const workspace = items.find((item) => item.id === input.workspaceId)
        if (!workspace) throw new Error("unknown workspace")
        if (input.directory && canonical(input.directory) !== workspace.directory) throw new Error("workspace directory mismatch")
        return canonical(workspace.directory)
      }
      const directory = input.directory ? canonical(input.directory) : root
      if (directory !== root && !items.some((item) => item.directory === directory)) throw new Error("directory is not a registered workspace")
      return directory
    },
  }
}

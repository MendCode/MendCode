import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { record } from "@mendcode/extension-api/plugin-files"

/** Plugin-owned session metadata, separate from conversation history and provider credentials. */
export function createPluginMetadata(dataDir: string) {
  const file = path.join(dataDir, "plugin-metadata.json")
  const read = (): Record<string, unknown> => {
    try { const value: unknown = JSON.parse(readFileSync(file, "utf8")); return record(value) ? value : {} } catch { return {} }
  }
  const key = (plugin: string, sessionId: string) => `${plugin}:${sessionId}`
  return {
    get(plugin: string, sessionId: string) {
      const value = read()[key(plugin, sessionId)]
      return record(value) ? value : {}
    },
    list(plugin: string, sessionIds: string[]) {
      const values = read()
      return sessionIds.flatMap((sessionId) => record(values[key(plugin, sessionId)]) ? [{ sessionID: sessionId, metadata: values[key(plugin, sessionId)] }] : [])
    },
    patch(plugin: string, sessionId: string, patch: Record<string, unknown>) {
      if (Object.keys(patch).some((name) => ["__proto__", "prototype", "constructor"].includes(name))) throw new Error("invalid metadata key")
      const values = read()
      const current = values[key(plugin, sessionId)]
      const metadata = { ...(record(current) ? current : {}), ...patch }
      for (const [name, value] of Object.entries(patch)) if (value === null) delete metadata[name]
      if (JSON.stringify(metadata).length > 32_768) throw new Error("plugin metadata exceeds 32 KB")
      mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${randomUUID()}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ ...values, [key(plugin, sessionId)]: metadata })}\n`, { mode: 0o600 })
      renameSync(tmp, file)
      return metadata
    },
  }
}

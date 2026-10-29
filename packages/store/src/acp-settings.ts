import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AcpAgentName, AcpAgentSettings, type Settings } from "@mendcode/protocol"

type Config = { command: string; args?: string[]; env?: Record<string, string> }

/** Bridge settings patches to the existing ACP file, keeping env values out of replies and the settings table. */
export function createAcpSettings(dir: string) {
  const file = join(dir, "acp-agents.json")
  function read(): Record<string, unknown> {
    try {
      const json = JSON.parse(readFileSync(file, "utf8"))
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid ACP config")
      return json
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw new Error("cannot read acp-agents.json; repair the config before editing")
    }
  }
  function metadata(raw: Record<string, unknown>): NonNullable<Settings["acpAgents"]> {
    const result: NonNullable<Settings["acpAgents"]> = {}
    for (const [name, value] of Object.entries(raw)) {
      if (!AcpAgentName.safeParse(name).success || !value || typeof value !== "object") continue
      const config = value as Config
      const parsed = AcpAgentSettings.safeParse({ command: config.command, ...(config.args ? { args: config.args } : {}), envKeys: Object.keys(config.env ?? {}) })
      if (parsed.success) result[name] = parsed.data
    }
    return result
  }
  return {
    get() {
      try { return metadata(read()) } catch { return {} }
    },
    prepare(patch: unknown) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("acpAgents must be an agent patch")
      const raw = read()
      for (const [name, value] of Object.entries(patch)) {
        AcpAgentName.parse(name)
        if (value === null) { delete raw[name]; continue }
        const config = AcpAgentSettings.parse(value)
        const previous = raw[name] as Config | undefined
        const env = Object.fromEntries((config.envKeys ?? []).map((key) => [key, previous?.env?.[key] ?? `\${${key}}`]))
        raw[name] = { command: config.command, ...(config.args ? { args: config.args } : {}), ...(Object.keys(env).length ? { env } : {}) }
      }
      return () => {
        const temporary = `${file}.tmp`
        writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
        renameSync(temporary, file)
      }
    },
  }
}

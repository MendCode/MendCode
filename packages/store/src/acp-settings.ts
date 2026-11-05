import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AcpAgentName, AcpAgentSettings, type Settings } from "@mendcode/protocol"

type Config = { command: string; args?: string[]; env?: Record<string, string> }

/** Bridge settings patches to the existing ACP file, keeping env values out of replies and the settings table. */
export function createAcpSettings(dir: string) {
  const file = join(dir, "acp-agents.json")
  function parsed(text: string): Record<string, unknown> {
    const json = JSON.parse(text)
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid ACP config")
    return json
  }
  function read(): Record<string, unknown> {
    try {
      return parsed(readFileSync(file, "utf8"))
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
  /** The agents of the last text read, so the settings reads of a turn validate the file only when it changed. */
  let view: { text: string | undefined; agents: NonNullable<Settings["acpAgents"]> } | undefined
  function text(): string | undefined {
    try { return readFileSync(file, "utf8") } catch { return undefined }
  }
  return {
    get(): NonNullable<Settings["acpAgents"]> {
      const current = text()
      if (!view || view.text !== current) {
        let agents: NonNullable<Settings["acpAgents"]> = {}
        try { agents = current === undefined ? {} : metadata(parsed(current)) } catch { /* An invalid file reads as no agents, as before. */ }
        view = { text: current, agents }
      }
      return structuredClone(view.agents)
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
        raw[name] = { ...previous, command: config.command, args: config.args, env: Object.keys(env).length ? env : undefined }
      }
      return () => {
        const temporary = `${file}.tmp`
        writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
        renameSync(temporary, file)
      }
    },
  }
}

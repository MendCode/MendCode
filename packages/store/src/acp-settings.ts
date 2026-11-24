import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AcpAgentName, AcpAgentSettings, fileSignature, type Settings } from "@mendcode/protocol"

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
  /**
   * The agents of the last version read. Every settings read asks for them (thousands a second while sessions stream), so the
   * file is read again only when its signature (inode, size, times) changed; one stat instead of open, read and decode.
   */
  let view: { signature: string; agents: NonNullable<Settings["acpAgents"]> } | undefined
  function signature(): string {
    const info = statSync(file, { throwIfNoEntry: false })
    return info ? fileSignature(info) : "missing"
  }
  function text(): string | undefined {
    try { return readFileSync(file, "utf8") } catch { return undefined }
  }
  return {
    get(): NonNullable<Settings["acpAgents"]> {
      const current = signature()
      if (!view || view.signature !== current) {
        const content = current === "missing" ? undefined : text()
        let agents: NonNullable<Settings["acpAgents"]> = {}
        try { agents = content === undefined ? {} : metadata(parsed(content)) } catch { /* An invalid file reads as no agents, as before. */ }
        view = { signature: current, agents }
      }
      for (const _ in view.agents) return structuredClone(view.agents)
      return {}
    },
    prepare(patch: unknown) {
      // null resets the key like any other setting: no agents. One agent goes with `{ "<name>": null }`.
      if (patch !== null && (!patch || typeof patch !== "object" || Array.isArray(patch))) throw new Error("acpAgents must be an agent patch: { \"<name>\": { command, args?, envKeys? } } adds or replaces one, { \"<name>\": null } removes one, null removes them all")
      const raw: Record<string, unknown> = patch === null ? {} : read()
      for (const [name, value] of Object.entries(patch ?? {})) {
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

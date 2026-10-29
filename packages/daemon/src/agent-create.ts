import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseAgentFile, RESERVED_AGENTS } from "@mendcode/packages"
import type { AgentCreateReport, Command } from "@mendcode/protocol"
import { AGENT_CREATE_PERMISSIONS, agentName } from "@mendcode/protocol/wire"
import { canonicalDir } from "@mendcode/tools"
import type { AgentContent } from "./agent-generate"

type Outcome = { generated?: AgentContent; fallback?: string; calledProvider?: boolean }

export async function createAgentFile(dir: string, command: Extract<Command, { type: "agent.create" }>, outcome: Outcome = {}): Promise<AgentCreateReport> {
  const content: AgentContent = outcome.generated ?? { name: command.name ?? agentName(command.description), description: command.description, prompt: command.description }
  if (RESERVED_AGENTS.includes(content.name)) throw new Error(`Agent ${content.name} is built in and cannot be replaced`)
  const base = command.path ? path.resolve(command.directory, command.path) : command.scope === "project" ? path.join(canonicalDir(command.directory), ".mendcode") : dir
  const file = path.join(base, "agents", `${content.name}.md`)
  const denied = AGENT_CREATE_PERMISSIONS.filter((permission) => !command.permissions.includes(permission))
  const text = ["---", `description: ${JSON.stringify(content.description)}`, `mode: ${command.mode}`,
    ...(command.model ? [`model: ${JSON.stringify(command.model)}`] : []),
    ...(denied.length ? ["permission:", ...denied.map((permission) => `  ${permission}: deny`)] : []),
    "---", content.prompt, ""].join("\n")
  const parsed = parseAgentFile({ text, stem: content.name, file, source: command.scope })
  if ("problem" in parsed) throw new Error(parsed.problem)
  // Exclusive creation refuses both an existing agent and a final symlink; never overwrite one.
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, text, { flag: "wx", mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Agent file already exists: ${file}`)
    throw error
  }
  const { prompt: _prompt, ...agent } = parsed.agent
  return { file, agent: { ...agent, trusted: command.scope === "user" && !command.path }, generation: outcome.generated ? "model" : "deterministic", callsProviders: outcome.calledProvider ?? false, ...(outcome.fallback ? { fallback: outcome.fallback } : {}) }
}

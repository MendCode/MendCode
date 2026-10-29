import type { AcpRegistryEntry, AcpRegistryReport, Settings } from "@mendcode/protocol"

type Preset = Omit<AcpRegistryEntry, "installed" | "configured">

// Curated from the official ACP registry on 2026-10-04. No downloads, package runners or auth probes.
const CATALOG: readonly Preset[] = [
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], install: "pnpm add -g @google/gemini-cli", website: "https://geminicli.com" },
  { id: "devin", name: "Devin", command: "devin", args: ["acp"], install: "Install Devin CLI from the website; put devin on PATH", website: "https://docs.devin.ai/cli" },
  { id: "cline", name: "Cline", command: "cline", args: ["--acp"], install: "pnpm add -g cline", website: "https://cline.bot/cli" },
  { id: "kimi", name: "Kimi CLI", command: "kimi", args: ["acp"], install: "Install Kimi CLI from the website; put kimi on PATH", website: "https://moonshotai.github.io/kimi-cli/" },
  { id: "droid", name: "Factory Droid", command: "droid", args: ["exec", "--output-format", "acp-daemon"], install: "pnpm add -g droid", website: "https://factory.ai/product/cli" },
  { id: "codex-acp", name: "codex-acp", command: "codex-acp", args: [], install: "pnpm add -g @agentclientprotocol/codex-acp", website: "https://github.com/agentclientprotocol/codex-acp" },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], install: "pnpm add -g opencode-ai", website: "https://opencode.ai" },
  { id: "claude-code-acp", name: "Claude Agent", command: "claude-agent-acp", args: [], install: "pnpm add -g @agentclientprotocol/claude-agent-acp", website: "https://github.com/agentclientprotocol/claude-agent-acp" },
]

/** A registry agent's own name ("OpenCode" for `opencode`); undefined for an agent the registry does not list. */
export const acpAgentName = (id: string): string | undefined => CATALOG.find((agent) => agent.id === id)?.name

export function createAcpRegistry(input: {
  settings(): Settings
  save(patch: { acpAgents: NonNullable<Settings["acpAgents"]> }): Settings
  // PATH lookup only: never run a binary just to detect it. Injected in tests.
  which?: (command: string) => string | null
}) {
  const which = input.which ?? ((command: string) => Bun.which(command))
  function list(): AcpRegistryReport {
    const configured = input.settings().acpAgents ?? {}
    return { agents: CATALOG.map((agent) => ({ ...agent, args: [...agent.args], installed: which(agent.command) !== null, configured: Object.hasOwn(configured, agent.id) })) }
  }
  return {
    list,
    add(id: string): Settings {
      const agent = CATALOG.find((entry) => entry.id === id)
      if (!agent) throw new Error("Unknown ACP registry agent")
      if (Object.hasOwn(input.settings().acpAgents ?? {}, id)) throw new Error("Agent already configured; edit it in /acp")
      return input.save({ acpAgents: { [id]: { command: agent.command, args: [...agent.args], envKeys: [] } } })
    },
  }
}

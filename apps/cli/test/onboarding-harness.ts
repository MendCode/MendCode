import type { CommandInput, CommandReply } from "@mendcode/client"
import { appHarness, type Harness, type HarnessOptions } from "./session-ui-harness"

/** What a fresh machine could hold. Each field maps to the answer of one read-only daemon query. */
export type Machine = {
  /** Models the catalog lists: Claude Code models appear only when `claude` answered, pi's only when pi is installed. */
  claude?: boolean
  codex?: boolean
  pi?: boolean
  /** Provider ids whose key is present (from the environment or providers.json). */
  keys?: string[]
  /** MCP servers and commands `/import setup` would take over. */
  importable?: { mcp: number; commands: number; tool?: "claude-code" | "codex" }
  /** The native catalog (the ChatGPT login's models) answers. */
  chatgpt?: boolean
  /** A model is already selected as main. */
  selected?: string
}

const NATIVE = [
  { id: "gpt-5.5", name: "GPT-5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gpt-5.5-mini", name: "GPT-5.5 mini", efforts: ["low", "medium"], defaultEffort: "low" },
]

export function modelsFor(machine: Machine) {
  const models: Array<Record<string, unknown>> = []
  if (machine.chatgpt) models.push(...NATIVE)
  if (machine.claude) models.push({ id: "claude-sonnet", name: "Claude Sonnet", engine: "claude", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "claude-opus", name: "Claude Opus", engine: "claude", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" })
  if (machine.codex) models.push({ id: "codex-default", name: "Codex", engine: "codex", efforts: [] })
  if (machine.pi) models.push({ id: "pi:default", name: "pi", engine: "pi", efforts: [] })
  for (const key of machine.keys ?? []) models.push({ id: `${key}:default`, name: `${key} default`, provider: key, efforts: [] })
  return models
}

/** The daemon's answers for a machine, shaped like the real replies the app already consumes. */
export function machineReply(machine: Machine, extra?: HarnessOptions["reply"]): NonNullable<HarnessOptions["reply"]> {
  return (command: CommandInput) => {
    const override = extra?.(command)
    if (override) return override
    const c = command as unknown as Record<string, unknown>
    const ok = (result: unknown) => ({ ok: true, result }) as CommandReply
    switch (c.type) {
      case "models.list": {
        const models = modelsFor(machine)
        return ok({ engine: machine.claude ? "native" : "native", selectable: true, models, defaults: { model: models[0]?.id ?? "gpt-5.5" }, roles: machine.selected ? { main: { model: machine.selected } } : {}, ...(machine.selected ? { effective: { model: machine.selected } } : {}) })
      }
      case "providers.list":
        return ok({ providers: (machine.keys ?? []).map((id) => ({ id, type: "openai-compatible", baseUrl: "https://example.invalid", enabled: true, hasKey: true, source: "env", models: [], authReady: true })) })
      case "setup.import": {
        const found = machine.importable
        if (!found) return ok({ applied: false, found: [], items: [], inPlace: [], notImported: [] })
        const tool = found.tool ?? "claude-code"
        return ok({
          applied: false,
          found: [{ tool, file: "~/.claude.json" }],
          items: [
            ...Array.from({ length: found.mcp }, (_, i) => ({ kind: "mcp", name: `server-${i + 1}`, tool, scope: "user", status: "new" })),
            ...Array.from({ length: found.commands }, (_, i) => ({ kind: "command", name: `command-${i + 1}`, tool, scope: "user", status: "new" })),
          ],
          inPlace: [], notImported: [],
        })
      }
      case "setup.status":
        return ok({ engine: "native", aiReady: Boolean(machine.chatgpt || machine.claude || machine.codex || machine.keys?.length), helper: { ready: false, model: "none" }, preset: "default", prompt: { mode: "focus", focusID: "default" }, roles: [], budget: { policy: { mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false, prices: {}, suppliedUsd: null }, enforcement: { state: "not-enforced", enforced: false, pricingKnown: false, model: "", currentKnownUsd: 0, warnings: [], blockers: [] }, telemetry: { knownCalls: 0, unknownCalls: 0, recordedUsd: 0, suppliedUsd: null } }, blockers: [], warnings: [] })
      case "daemon.info":
        return ok({ engine: "native", model: "gpt-5.5", dataDir: "/tmp/mendcode-demo", pid: 7, buildId: "deadbeefcafe" })
      case "mcp.status":
        return ok({ servers: [], issues: [] })
      case "memory.list":
        return ok({ memories: [] })
      case "settings.get":
        return ok({ settings: {} })
      default:
        return undefined
    }
  }
}

export function onboardingHarness(machine: Machine, options: HarnessOptions = {}): Harness & { sets(): Array<Record<string, unknown>> } {
  const harness = appHarness({ ...options, reply: machineReply(machine, options.reply) })
  return Object.assign(harness, { sets: () => harness.sentOf("settings.set").map((c) => (c as unknown as { patch: Record<string, unknown> }).patch) })
}

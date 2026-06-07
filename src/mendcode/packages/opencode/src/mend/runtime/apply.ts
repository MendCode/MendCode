import path from "path"
import { syncProject } from "../config/project"
import type { RuntimePack } from "./pack"

export type RuntimePackSubsystem =
  | "models"
  | "focus"
  | "commands"
  | "agents"
  | "skills"
  | "mcp"
  | "prompts"
  | "context"
  | "budget"
  | "tui"
  | "worktree"
  | "generated"

export type RuntimePackAdapterChange = {
  subsystem: RuntimePackSubsystem
  target: string
  action: "write" | "replace" | "sync" | "noop"
  reason: string
}

export type RuntimePackApplyResult = {
  subsystem: RuntimePackSubsystem
  ok: boolean
  writes: string[]
  warnings: string[]
}

function count(items: unknown[] | Record<string, unknown> | undefined) {
  if (Array.isArray(items)) return items.length
  if (items && typeof items === "object") return Object.keys(items).length
  return 0
}

export function runtimePackAdapterPreview(pack: RuntimePack): RuntimePackAdapterChange[] {
  return [
    {
      subsystem: "models",
      target: ".mendcode/models.yaml",
      action: "noop",
      reason: `Pack carries ${count(pack.models.roles)} model roles; local apply currently persists the resolved pack snapshot and generated projection.`,
    },
    {
      subsystem: "focus",
      target: ".mendcode/mendcode.json",
      action: "noop",
      reason: `Pack default focus is ${pack.focus.default}; local apply currently preserves existing focus config.`,
    },
    {
      subsystem: "commands",
      target: ".mendcode/commands",
      action: "noop",
      reason: `Pack references ${pack.commands.length} command files using runtime loader-compatible globs.`,
    },
    {
      subsystem: "agents",
      target: ".mendcode/agents",
      action: "noop",
      reason: `Pack references ${pack.agents.length} agent files using runtime loader-compatible globs.`,
    },
    {
      subsystem: "skills",
      target: ".mendcode/skills",
      action: "noop",
      reason: `Pack references ${pack.skills.length} skill files using **/SKILL.md.`,
    },
    {
      subsystem: "mcp",
      target: ".mendcode/mcp",
      action: count(pack.mcp.config) || pack.mcp.files.length ? "sync" : "noop",
      reason: `Pack carries ${count(pack.mcp.config)} projected MCP servers and ${pack.mcp.files.length} MCP definition files.`,
    },
    {
      subsystem: "prompts",
      target: ".mendcode/prompts",
      action: pack.prompts.templates.length ? "noop" : "noop",
      reason: `Pack prompt mode is ${pack.prompts.mode}; ${pack.prompts.templates.length} user prompt templates are referenced.`,
    },
    {
      subsystem: "context",
      target: ".mendcode/context",
      action: "noop",
      reason: `Pack references ${pack.context.include.length} context inputs.`,
    },
    {
      subsystem: "budget",
      target: ".mendcode/mendcode.json",
      action: "noop",
      reason: `Pack budget keys: ${Object.keys(pack.budget).join(", ") || "none"}.`,
    },
    {
      subsystem: "tui",
      target: ".mendcode/tui/profile.json",
      action: "noop",
      reason: "TUI profile remains passive metadata; visible customization is still deferred.",
    },
    {
      subsystem: "worktree",
      target: ".mendcode/worktree",
      action: "noop",
      reason: `Pack worktree mode: ${(pack.worktree as any).mode || "off"}.`,
    },
    {
      subsystem: "generated",
      target: ".mendcode/generated/opencode.json",
      action: "sync",
      reason: "Regenerate donor compatibility config after runtime-pack apply.",
    },
  ]
}

export async function applyRuntimePackAdapters(pack: RuntimePack, root: string): Promise<RuntimePackApplyResult[]> {
  const results = runtimePackAdapterPreview(pack).map((change): RuntimePackApplyResult => ({
    subsystem: change.subsystem,
    ok: true,
    writes: change.action === "sync" ? [change.target] : [],
    warnings: change.action === "noop" ? [change.reason] : [],
  }))
  const sync = await syncProject(root)
  const generated = results.find((result) => result.subsystem === "generated")
  if (generated) generated.writes = [sync.generatedConfig, path.join(".mendcode", "generated", "model-role-projection.json")]
  return results
}

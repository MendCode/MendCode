import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { FEATURES, featureState, type FeatureId, type TierSettings } from "@mendcode/protocol/wire"
import type { LiveContext } from "./docs-live"

/**
 * The live lines of the cards about a feature (sub-agents, the Git page, the code graph ...): is it on here, why, what turns it on, and the
 * values of its settings. Everything comes from the settings a running daemon holds; without one the lines say so and print nothing else.
 */
type Provider = (context: LiveContext) => string[]

const NO_DAEMON = "(no daemon running: tier, switches and settings not shown)"

/** One feature: `label: on (why)`, or `label: off · what turns it on`. A feature a tier only allows also names its own switch, which must be on. */
export function featureLine(settings: Record<string, unknown>, id: FeatureId): string {
  const spec = FEATURES[id]
  const state = featureState(settings as TierSettings, id)
  const why = { tier: `tier ${String(settings.tier)}`, legacy: "no tier set: its default", override: `your features.${id}`, setting: `your ${spec.flag ?? "flag"} switch`, "safe-mode": "safe mode" }[state.why]
  if (state.on && spec.mode === "permit" && spec.flag) {
    const experimental = (settings.experimental ?? {}) as Record<string, unknown>
    return experimental[spec.flag] === true ? `${spec.label}: on (${why}, and experimental.${spec.flag} is on)` : `${spec.label}: allowed (${why}) but off · the user turns it on with /experimental ${spec.flag} on`
  }
  if (spec.optIn) return state.on ? `${spec.label}: on (${why})` : `${spec.label}: off · the user turns it on with /tier ${id} on`
  if (state.on && spec.mode === "permit") return `${spec.label}: allowed (${why}); it also needs ${spec.own}`
  if (state.on) return `${spec.label}: on (${why})`
  return `${spec.label}: off (${why}) · /tier ${spec.tier} includes it${spec.mode === "permit" ? `, then ${spec.own}` : `; or /tier ${id} on`}`
}

/** `key value` for each setting, with the built-in default when it is not set. */
export function settingsLine(settings: Record<string, unknown>, defaults: Record<string, string | number | boolean>): string {
  return Object.entries(defaults).map(([key, fallback]) => {
    const value = settings[key]
    return value === undefined || value === null ? `${key} ${fallback} (default)` : `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`
  }).join(" · ")
}

/** The names in a folder (a file `a.md` and a folder `a/` both count as `a`), or none. */
export function namesIn(folder: string): string[] {
  try { return readdirSync(folder).filter((name) => !name.startsWith(".")).map((name) => name.replace(/\.(?:ts|js|json|md)$/, "")).sort() } catch { return [] }
}

/** `data dir and project: a, b`-style line for a folder kind, or "none". */
export function folderLine(context: LiveContext, kind: string): string {
  const user = namesIn(path.join(context.dataDir, kind))
  const project = path.resolve(context.cwd) === path.resolve(context.dataDir) ? [] : namesIn(path.join(context.cwd, ".mendcode", kind))
  const parts = [...user, ...project.map((name) => `${name} (project)`)]
  return `${kind}/: ${parts.length ? parts.join(", ") : "none"}`
}

export const fileLine = (file: string, label = path.basename(file)) => `${label}: ${existsSync(file) ? file : "none"}`

/** The lines of a feature card: the features it is about, then its settings, or the daemon note when none runs. */
export function withSettings(context: LiveContext, build: (settings: Record<string, unknown>) => string[]): string[] {
  return context.settings ? build(context.settings) : [NO_DAEMON]
}

/** A card about some features: one line each, then the values of the settings it names (with their defaults) when there are any. */
const aboutFeatures = (ids: readonly FeatureId[], defaults: Record<string, string | number | boolean> = {}, extra: (context: LiveContext, settings: Record<string, unknown>) => string[] = () => []): Provider => (context) =>
  withSettings(context, (settings) => [...ids.map((id) => featureLine(settings, id)), ...(Object.keys(defaults).length ? [settingsLine(settings, defaults)] : []), ...extra(context, settings)])

/** The names of the keys an object setting holds, or none: a setting that may carry secrets is never printed, only its shape. */
const keysOf = (settings: Record<string, unknown>, key: string) => {
  const value = settings[key]
  return value && typeof value === "object" ? Object.keys(value as object) : []
}

export const FEATURE_PROVIDERS: Record<string, Provider> = {
  subagents: (context) => withSettings(context, (settings) => [
    featureLine(settings, "subagents"),
    featureLine(settings, "task_worktree"),
    featureLine(settings, "task_fork"),
    settingsLine(settings, { subagentDepth: 1, subagentMaxChildren: 4, subagentMaxDescendants: 16, subagentOwnerWake: true, subagentCatalog: 6, agentMentions: "address" }),
    folderLine(context, "agents"),
  ]),
  git: aboutFeatures(["git_hub", "git_actions", "worktree_tool", "pr_watch", "review_order"], { worktreeGcDays: "off" }),
  codegraph: aboutFeatures(["codegraph", "graph_context", "orientation", "lean_tools"]),
  computer: aboutFeatures(["computer", "browser"]),
  web: aboutFeatures(["webfetch_modes", "web_routing"], {}, (_context, settings) => [
    `web rules: ${keysOf(settings, "web").join(", ") || "none"} · proxy: ${keysOf(settings, "proxy").length ? "set" : "none"}`,
  ]),
  engines: aboutFeatures(["pi", "thread_mcp", "acp_registry"], {}, (_context, settings) => [`acp agents: ${keysOf(settings, "acpAgents").join(", ") || "none"} · threadMcp: ${keysOf(settings, "threadMcp").join(", ") || "off"}`]),
  reasoning: aboutFeatures(["jev"]),
  pet: aboutFeatures(["pets", "pet_generator"]),
  tools: aboutFeatures(["lean_tools", "tool_discovery", "code_mode", "output_filters"]),
  packages: aboutFeatures(["packages", "package_tools", "package_capabilities", "official_packages"]),
  memory: aboutFeatures(["memory_ux"], { memoryEnabled: true, memoryUse: false, memoryGenerate: false, memoryRequireApproval: true, memoryMaxEntries: 50, memoryMaxPromptTokens: 10_000, dreamAt: "off" }),
  goals: aboutFeatures(["plan_tools"]),
  threads: aboutFeatures(["threads", "handoff"]),
  compaction: aboutFeatures(["snip", "limit_checkpoint"]),
  sessions: aboutFeatures(["session_meta"]),
  viewer: aboutFeatures(["file_viewer"]),
  workflows: aboutFeatures(["script_workflows", "fanout"]),
  attachments: aboutFeatures(["voice"]),
  budgets: aboutFeatures(["usage_resume"]),
  troubleshooting: aboutFeatures(["single_process", "storage_compact"], { autoupdate: "off" }),
  remote: aboutFeatures([], { share: "disabled" }, (_context, settings) => [`console origin: ${keysOf(settings, "enterprise").includes("url") ? "set" : "none"}`]),
  loops: aboutFeatures(["autoresearch"]),
}

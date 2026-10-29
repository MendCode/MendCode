import path from "node:path"
import { PROMPT_FILES } from "@mendcode/extension-api"
import { createSkillLoader } from "@mendcode/engine-native"
import { loadMcpConfig } from "@mendcode/mcp"
import { emptyDiagnostics, layerLabel, readLayerAgents, readLayerThemes, type ExtensionLayer, type ResourceDiagnostics, type ResourceKindName } from "@mendcode/packages"
import type { PrecedenceClaim, PrecedenceFacts, PrecedenceSurface } from "@mendcode/protocol/wire"
import { createCustomToolRegistry } from "@mendcode/tools"
import { loadCustomCommands } from "./custom-commands"
import { createPromptFiles } from "./extensions/prompt-files"
import { readRecipes } from "./recipes"
import { readShellHooks } from "./shell-hooks"
import { readContracts, readWorkflowPlans, readWorkflowScripts } from "./workflow-files"

/**
 * The file-derived half of the precedence report (the terminal adds what is registered in it). Skills, commands and agents are
 * not decided here: their loaders already say which entry another layer overrides (`ResourceDiagnostics.overridden`), and those
 * findings become claims as they are. The other surfaces are read layer by layer by the loader that owns them, so the report
 * cannot disagree with a loader. The ranking comes from the layer order the daemon itself uses. Names only; nothing is run and no file is shown.
 */
const MAX_CLAIMS = 2000
export const MAX_PRECEDENCE_CLAIMS = MAX_CLAIMS

export async function fileClaims(input: { layers: readonly ExtensionLayer[]; directory: string; userDir: string; projectTrusted: boolean }): Promise<PrecedenceFacts> {
  const claims: PrecedenceClaim[] = []
  let truncated = false
  const layers = input.layers.map((layer) => layerLabel(layer))
  const seen = new Set<string>()
  const addLabeled = (surface: PrecedenceSurface, name: string, layer: string, rank: number, extra: { note?: string; inactive?: boolean } = {}) => {
    const key = `${surface}\u0000${name}\u0000${layer}`
    if (seen.has(key)) return
    seen.add(key)
    if (claims.length >= MAX_CLAIMS) { truncated = true; return }
    claims.push({ surface, name, layer, rank, ...extra })
  }
  const add = (surface: PrecedenceSurface, name: string, layer: ExtensionLayer, rank: number, extra: { note?: string; inactive?: boolean } = {}) => addLabeled(surface, name, layerLabel(layer), rank, extra)
  /** A label the loaders report that is not one of the layers (a built-in command) wins over every layer. */
  const rankOf = (label: string, unknown: number) => layers.indexOf(label) >= 0 ? layers.indexOf(label) : unknown
  const fromDiagnostics = (surface: PrecedenceSurface, report: ResourceDiagnostics, kind: ResourceKindName, winners: ReadonlyArray<{ name: string; layer: string }>) => {
    for (const winner of winners) addLabeled(surface, winner.name, winner.layer, rankOf(winner.layer, 0))
    for (const entry of report.overridden) if (entry.kind === kind) {
      addLabeled(surface, entry.name, entry.layer, rankOf(entry.layer, -1))
      addLabeled(surface, entry.name, entry.by, rankOf(entry.by, 1_000_000))
    }
  }
  const skills = createSkillLoader({ userDir: input.userDir, layers: () => input.layers as ExtensionLayer[] }).inspect(input.directory)
  fromDiagnostics("skills", skills.diagnostics, "skill", skills.skills)
  const commandReport = emptyDiagnostics()
  await loadCustomCommands({ directory: input.directory, userDir: input.userDir, layers: input.layers as ExtensionLayer[], report: commandReport }).catch(() => [])
  fromDiagnostics("commands", commandReport, "command", [])
  const agents = readLayerAgents(input.layers, { projectTrusted: input.projectTrusted })
  fromDiagnostics("agents", { ...emptyDiagnostics(), overridden: agents.overridden }, "agent", [])
  for (const [rank, layer] of input.layers.entries()) {
    const alone = [layer]
    // Project code only runs where the project is trusted: its claims are listed but never effective.
    const waiting = layer.source === "project" && !input.projectTrusted ? { inactive: true, note: "needs project trust" } : {}
    // An agent file of a project nobody trusted is listed, never in force: the loader flags it and it overrides nothing.
    if (!input.projectTrusted && layer.source === "project") for (const agent of readLayerAgents(alone, { projectTrusted: false }).agents) add("agents", agent.name, layer, rank, { inactive: true, note: "needs project trust" })
    if (!layer.foreign) {
      const tools = await createCustomToolRegistry({ userDir: input.userDir, trustedDirs: () => [], layers: () => alone }).list(input.directory)
      for (const tool of tools.tools) add("tools", tool.name, layer, rank, waiting)
      const hooks = new Map<string, number>()
      for (const hook of readShellHooks(alone).hooks) hooks.set(hook.event, (hooks.get(hook.event) ?? 0) + 1)
      for (const [event, count] of hooks) add("hooks", event, layer, rank, { note: `${count} hook${count === 1 ? "" : "s"}`, ...waiting })
      for (const name of Object.keys((await loadMcpConfig({ directory: input.directory, userDir: input.userDir, layers: alone }).catch(() => ({ servers: {} }))).servers)) add("mcp", name, layer, rank)
      for (const theme of readLayerThemes(alone)) add("themes", theme.name, layer, rank)
      for (const recipe of readRecipes(alone)) add("recipes", recipe.name, layer, rank)
      for (const plan of readWorkflowPlans(alone)) add("workflows", plan.name, layer, rank)
      for (const script of readWorkflowScripts(alone)) add("workflows", script.name, layer, rank, waiting)
      for (const contract of readContracts(alone)) add("contracts", contract.name, layer, rank)
      const prompts = createPromptFiles({ layersFor: () => alone, enabled: true }).read(input.directory)
      for (const [kind, file] of Object.entries(PROMPT_FILES) as Array<[keyof typeof PROMPT_FILES, string]>) if (prompts[kind] !== undefined) add("promptFiles", path.basename(file), layer, rank)
    }
  }
  return { claims, layers, truncated }
}

import { claudeFastModel, findModel } from "@mendcode/protocol/wire"

/** What the footer knows of the catalog: `ModelsReport` fits. */
type Catalog = { engine?: string | undefined; models?: readonly { id: string; name: string; provider?: string | undefined; engine?: string | undefined }[] | undefined }

/** The engine that runs a model's whole session (Claude Code, Codex, pi, ACP) and so owns its reasoning and its service tier, or undefined for a model of the daemon's own engine. */
export function externalEngine(id: string | undefined, catalog: Catalog | undefined): string | undefined {
  return id ? findModel(catalog?.models ?? [], id)?.engine : undefined
}

/**
 * Whether priority processing (`/fast`, `serviceTier: "fast"`) reaches a model: the ChatGPT subscription's models (no provider, served by the
 * native engine), the OpenAI API provider's, Codex's, and Claude Code's Opus models that have its fast mode. Others ignore the setting.
 */
export function fastApplies(id: string | undefined, catalog: Catalog | undefined): boolean {
  return fastReach(id, catalog).applies
}

const ENGINE_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "pi" }

/** Whether `/fast` reaches a model, and when it does not, who runs or serves the model instead: what `/fast` and the footer say. */
export function fastReach(id: string | undefined, catalog: Catalog | undefined): { applies: boolean; why?: string } {
  const model = id ? findModel(catalog?.models ?? [], id) : undefined
  if (!model) return { applies: false, why: id ? "a model it does not know" : "no model yet" }
  // Codex starts with its fast service tier; Claude Code with its fast mode, which only some Opus models have.
  if (model.engine === "codex") return { applies: true }
  if (model.engine === "claude") return claudeFastModel(model.id) ? { applies: true } : { applies: false, why: "Claude Code's fast mode is for Opus 5.5, 5 and 4.8" }
  if (model.engine) return { applies: false, why: `${ENGINE_NAMES[model.engine] ?? model.engine.replace(/^acp:/, "")} runs it` }
  if (model.provider === undefined) return catalog?.engine === "native" ? { applies: true } : { applies: false, why: "its engine has no priority tier" }
  return model.provider === "openai" ? { applies: true } : { applies: false, why: `${model.provider} has no priority tier` }
}

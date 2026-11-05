import type { ModelChoice } from "@mendcode/protocol"
import { catalogId, catalogModel, type ModelCatalog } from "../models"

/**
 * The only models a PR review's reader may run on (docs/pr-review.md, "Data files and readers"): an explicit list of each
 * provider's small tier, cheapest first. A reader summarizes data files for the review pass, so it never needs a large model, and
 * a config that names one is refused rather than paid for. The list is checked before every reader call, not only when the
 * reader is chosen.
 */
export const CHEAP_READER_MODELS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: "Claude Haiku", pattern: /^claude-haiku(?:-\d[\w.-]*)?$/i },
  { family: "Gemini Flash", pattern: /^gemini-[\d.]+-flash(?:-lite)?(?:-[\w.-]*)?$/i },
  { family: "GPT mini", pattern: /^gpt-[\d.]+(?:-codex)?-mini(?:-[\w.-]*)?$/i },
  { family: "DeepSeek chat or Flash", pattern: /^deepseek-(?:chat|v[\d.]+-flash|flash)(?:-[\w.-]*)?$/i },
  { family: "Grok mini", pattern: /^grok-[\d.]+-mini(?:-[\w.-]*)?$/i },
  { family: "Mistral small", pattern: /^(?:mistral|ministral)-(?:small|\d+b)(?:-[\w.-]*)?$/i },
  { family: "GPT luna", pattern: /^gpt-[\d.]+-luna$/i },
  { family: "GPT nano", pattern: /^gpt-[\d.]+-nano(?:-[\w.-]*)?$/i },
]

/** The model part of a catalog id: `deepseek:deepseek-chat` and `codex:gpt-5.2-mini` are `deepseek-chat` and `gpt-5.2-mini`. */
const modelPart = (id: string) => id.slice(Math.max(id.lastIndexOf(":"), id.lastIndexOf("/")) + 1)

/** The family of `model` in `CHEAP_READER_MODELS`, or undefined when it is not a cheap reader model. */
export function cheapReaderFamily(model: string): string | undefined {
  const part = modelPart(model.trim())
  return CHEAP_READER_MODELS.find((entry) => entry.pattern.test(part))?.family
}
export const isCheapReaderModel = (model: string) => cheapReaderFamily(model) !== undefined
export const cheapReaderList = () => CHEAP_READER_MODELS.map((entry) => entry.family).join(", ")

export type ReaderModelPick = { ok: true; model: string; family: string } | { ok: false; reason: string }

/**
 * The reader model for a reviewer whose children run on `owner`: the cheapest model of the list on the same transport (the same
 * engine, Claude Code or Codex, and the same provider), so a reader goes out exactly the way the reviewer does. `requested`
 * (`readers.model`) is taken only when it is on the list and on that transport; otherwise the reason says why, and the caller
 * falls back to the automatic pick. A reviewer already on a cheap model reads with it.
 */
export function chooseReaderModel({ owner, catalog, requested }: { owner: ModelChoice | undefined; catalog: ModelCatalog; requested?: string | undefined }): ReaderModelPick {
  const info = owner ? catalogModel(catalog, owner.model) : undefined
  if (!info) return { ok: false, reason: `the reviewer's model${owner ? ` ${owner.model}` : ""} is not in the catalog, so no cheap model of its provider is known` }
  if (info.id.startsWith("acp:") || info.engine === "pi" || info.engine === "opencode" || info.engine === "cursor") return { ok: false, reason: `${info.id} runs on an external agent that picks its own model, so no cheap reader model can be chosen` }
  // An `acp:` model is another agent's harness (its own credentials and prompt), never the reviewer's own transport.
  const sameTransport = (id: string) => { const peer = catalogModel(catalog, id); return !!peer && !peer.id.startsWith("acp:") && peer.engine === info.engine && peer.provider === info.provider && catalog.allows?.(peer.id) !== false }
  if (requested) {
    const id = catalogId(catalog, requested)
    const family = cheapReaderFamily(id ?? requested)
    if (!family) return { ok: false, reason: `readers.model ${requested} is not a cheap reader model (${cheapReaderList()})` }
    if (!id || !sameTransport(id)) return { ok: false, reason: `readers.model ${requested} is not a model of the reviewer's own provider (${info.engine ? `${info.engine === "claude" ? "Claude Code" : "Codex"}` : info.provider ?? "the ChatGPT login"})` }
    return { ok: true, model: id, family }
  }
  const own = cheapReaderFamily(info.id)
  if (own) return { ok: true, model: info.id, family: own }
  const peers = catalog.list().filter((model) => model.id !== info.id && sameTransport(model.id))
  for (const entry of CHEAP_READER_MODELS) {
    const found = peers.find((model) => entry.pattern.test(modelPart(model.id)))
    if (found) return { ok: true, model: found.id, family: entry.family }
  }
  return { ok: false, reason: `${info.id}'s provider has no cheap reader model in the catalog (${cheapReaderList()})` }
}

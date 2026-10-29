/**
 * The one place that decides how a model is shown to a person. A model's id is for programs (config, wire, `--json`,
 * logs, `/model <id>`); the label is for the screen:
 *   1. the catalog's display name (`ModelInfo.name`, the part before its " · server" tag) when the model is in the catalog;
 *   2. otherwise a deterministic prettifier of the id, which needs no table to keep up with releases;
 *   3. an id of a shape it does not know is returned unchanged.
 * Two models of one catalog that would read the same carry their provider, so they stay distinguishable.
 * Imports nothing: this module is on the startup path and must load no schema.
 */

/** What the label needs of a catalog: `ModelsReport` and the onboarding's detected models both fit. */
type CatalogModel = { id: string; name?: string | undefined;provider?: string | undefined; engine?: string | undefined; resolved?: string | undefined }
type Catalog = { models: readonly CatalogModel[] }

const words = (rest: string, joiner = " ") => rest.split("-").filter(Boolean).map((word) => (/^[a-z]/.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word)).join(joiner)
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/
const FAMILY = [
  // claude-opus-5-5, claude-haiku-4-5, claude-sonnet-4, claude-opus
  { match: /^claude-([a-z]+)(?:-(\d{1,2})(?:[-.](\d{1,2}))?)?$/, show: (m: RegExpMatchArray) => `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ""}` : ""}` },
  // claude-3-5-sonnet, claude-3-opus
  { match: /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)$/, show: (m: RegExpMatchArray) => `${m[3]![0]!.toUpperCase()}${m[3]!.slice(1)} ${m[1]}${m[2] ? `.${m[2]}` : ""}` },
  // gpt-6.1-sol, gpt-6-luna, gpt-4o-mini: hyphenated like the Codex catalog's own display names (GPT-6-Luna), so a model reads the same with or without a catalog entry
  { match: /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z0-9.]+)*)$/, show: (m: RegExpMatchArray) => `GPT-${m[1]}${m[2] ? `-${words(m[2], "-")}` : ""}` },
  // gemini-3-pro, gemini-2.5-flash-lite
  { match: /^gemini-(\d+(?:\.\d+)?)((?:-[a-z0-9.]+)*)$/, show: (m: RegExpMatchArray) => `Gemini ${m[1]}${m[2] ? ` ${words(m[2])}` : ""}` },
] as const

/** The model name inside an id: no `provider:` or `vendor/` routing prefix, no `@date`, `-date` or `-latest` suffix. */
function bareName(id: string): string {
  let name = id.trim()
  const colon = name.indexOf(":")
  if (colon > 0 && /^[a-z][a-z0-9-]*$/i.test(name.slice(0, colon))) name = name.slice(colon + 1)
  const slash = name.lastIndexOf("/")
  if (slash >= 0) name = name.slice(slash + 1)
  return name.replace(/\[[^\]]*\]$/, "").replace(/@\d{8}$/, "").replace(/-latest$/, "").replace(DATE_SUFFIX, "")
}

/** `claude-opus-5-5` → `Opus 5.5`, `gpt-6.1-sol` → `GPT-6.1-Sol`, `gemini-3-pro` → `Gemini 3 Pro`; anything else, including a name that is already a display name, comes back unchanged. */
export function prettyModelId(id: string): string {
  const name = bareName(id)
  for (const family of FAMILY) {
    const found = name.match(family.match)
    if (found) return family.show(found)
  }
  return id
}

type Entry = { label: string; qualifier?: string }
const tables = new WeakMap<object, Map<string, Entry>>()

const providerOfId = (id: string) => /^([a-z][a-z0-9-]*):/i.exec(id)?.[1]
const qualifierOf = (model: CatalogModel) => model.provider ?? model.engine ?? providerOfId(model.id) ?? "chatgpt"
const headOf = (model: CatalogModel) => (model.name ?? "").split(" · ")[0]!.trim()
/** The family is the name: a catalog's `Claude Opus 5.5` reads `Opus 5.5`, like the prettified id of the same model. */
const labelOf = (model: CatalogModel) => {
  // The id an alias last resolved to names it better (`Opus 5.5` for `Claude Opus`) when it is a shape the prettifier knows.
  const resolved = model.resolved ? prettyModelId(model.resolved) : undefined
  return (resolved && resolved !== model.resolved ? resolved : prettyModelId(headOf(model) || model.id)).replace(/^Claude (?=[A-Z])/, "")
}

/** Every catalog model's label; models whose labels collide get their provider (and, if even that is shared, their id). */
function table(catalog: Catalog): Map<string, Entry> {
  const cached = tables.get(catalog.models)
  if (cached) return cached
  const entries = new Map<string, Entry>(catalog.models.map((model) => [model.id, { label: labelOf(model) }]))
  const byLabel = new Map<string, CatalogModel[]>()
  for (const model of catalog.models) byLabel.set(labelOf(model), [...(byLabel.get(labelOf(model)) ?? []), model])
  for (const group of byLabel.values()) {
    if (group.length < 2) continue
    const distinct = new Set(group.map(qualifierOf)).size === group.length
    for (const model of group) entries.set(model.id, { label: labelOf(model), qualifier: distinct ? qualifierOf(model) : model.id })
  }
  tables.set(catalog.models, entries)
  return entries
}

/** The catalog entry for an id as the app knows it, or as a usage event reports it (without its `provider:` prefix) when exactly one model matches. */
function lookup(id: string, catalog: Catalog | undefined): Entry | undefined {
  if (!catalog?.models) return undefined
  const entries = table(catalog)
  const exact = entries.get(id)
  if (exact) return exact
  const suffixed = catalog.models.filter((model) => model.id.endsWith(`:${id}`) || model.id.endsWith(`/${id}`))
  return suffixed.length === 1 ? entries.get(suffixed[0]!.id) : undefined
}

/** The label and, when another model reads the same, the provider to show muted next to it. */
export function modelParts(id: string, catalog?: Catalog): { label: string; qualifier?: string } {
  return lookup(id, catalog) ?? { label: prettyModelId(id) }
}

/** The label alone, for a status line, toast or card: the provider is shown beside it or known from the context. */
export function modelLabel(id: string, catalog?: Catalog): string {
  return modelParts(id, catalog).label
}

/** The label for a list that does not show ids: `Opus 5.5`, or `Opus 5.5 (openrouter)` where two entries would read the same. */
export function modelListLabel(id: string, catalog?: Catalog): string {
  const { label, qualifier } = modelParts(id, catalog)
  return qualifier ? `${label} (${qualifier})` : label
}

/**
 * What to name the session's model. A harness engine (Claude Code) takes an alias such as `claude-opus` that always means its
 * newest of the family, and reports what it resolved to (`claude-opus-5-5`) in the usage of the first answer. Until then the
 * alias is all there is and reads as `Opus`; after it the resolved name reads `Opus 5.5`. Nothing here knows a version.
 */
export function sessionModelId(effective: string | undefined, used: string | undefined, catalog?: Catalog): string | undefined {
  if (!effective) return used
  if (!used || used === effective) return effective
  const alias = catalog?.models?.find((model) => model.id === effective)
  return alias?.engine && used.startsWith(`${effective}-`) ? used : effective
}

/** The session's model as a person reads it: see `sessionModelId`. */
export function sessionModelLabel(input: { effective?: string | undefined; used?: string | undefined; catalog?: Catalog | undefined }): string | undefined {
  const id = sessionModelId(input.effective, input.used, input.catalog)
  return id ? modelLabel(id, input.catalog) : undefined
}

/** The id the native engine serves a model without a namespace under: the ChatGPT subscription (`/connect chatgpt`). */
const SUBSCRIPTION_PROVIDER = "chatgpt"

/**
 * The provider or engine that serves a model: its provider, else the engine that runs it (Claude Code), else the ChatGPT
 * subscription for a plain model of the native engine, else the catalog's engine ("native" is the daemon's engine, not a service).
 */
export function servedByProvider(id: string | undefined, catalog: (Catalog & { engine?: string | undefined }) | undefined): string | undefined {
  // An ACP agent's model runs on that agent's own loop: it is named by the agent's catalog entry (`OpenCode harness`), not by the
  // native engine's providers, so it is told apart from the same model on MendCode's harness (`opencode`, Zen).
  const agent = id?.startsWith("acp:") ? id.slice(0, id.indexOf("/") === -1 ? undefined : id.indexOf("/")) : undefined
  if (agent) return catalog?.models?.find((candidate) => candidate.id === agent)?.name ?? agent.slice("acp:".length)
  const model = id ? catalog?.models?.find((candidate) => candidate.id === id) : undefined
  return model?.provider ?? model?.engine ?? (model && catalog?.engine === "native" ? SUBSCRIPTION_PROVIDER : catalog?.engine)
}

/** A `[model, effort]` pair as the human surfaces join it. */
export const modelWithEffort = (id: string, effort: string | undefined, catalog?: Catalog) => [modelLabel(id, catalog), effort].filter(Boolean).join(" · ")

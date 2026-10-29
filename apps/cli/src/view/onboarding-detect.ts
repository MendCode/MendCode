import { setupImportKey } from "@mendcode/protocol/wire"
import { modelListLabel } from "./model-label"
import { CONNECT_PRESETS } from "./provider-presets"

/**
 * First-run detection, from answers the daemon already gives (`models.list`, `providers.list`, `daemon.info`,
 * `setup.import` preview). Nothing here probes the machine, calls a provider or reads a credential file: a Claude Code
 * model is in the catalog only when `claude` answered, a provider has a key only when the daemon says so.
 */
export type DetectModel = { id: string; name: string; engine?: string | undefined; provider?: string | undefined }
export type DetectProvider = { id: string; enabled: boolean; hasKey: boolean; authReady?: boolean | undefined }
export type DetectImportItem = { kind: string; status: string; tool: string; name?: string | undefined; scope?: string | undefined; enabled?: boolean | undefined; needs?: readonly string[] | undefined }
export type DetectImport = { found: Array<{ tool: string }>; items: DetectImportItem[]; inPlace?: readonly string[] | undefined; notImported?: readonly string[] | undefined }
export type DetectInput = {
  /** False when the engine picks its own model (codex, faux): there is nothing to choose. */
  selectable: boolean
  models: readonly DetectModel[]
  providers: readonly DetectProvider[]
  /** `daemon.info.login`: absent for engines without a subscription login. */
  login?: { ok: boolean; message?: string } | undefined
  imports?: DetectImport | undefined
  /** The model already chosen as `main`, when there is one. */
  selected?: string | undefined
}

export type ReadyItem = {
  id: "chatgpt" | "claude" | "codex" | "pi" | "keys"
  label: string
  ok: boolean
  /** What was found, or why it is missing. */
  detail: string
  /** The one command or variable that fixes a missing item. */
  fix?: string
}
export type ModelSource = "chatgpt" | "claude" | "codex" | "pi" | "api"
export type ModelOption = { id: string; label: string; source: ModelSource; recommended: boolean; current: boolean; /** One line: what it uses and what it costs. */ line: string }
/** One thing the setup could bring over: what the picker lists and what `setup.import` is asked to write. */
export type ImportChoice = {
  /** `setupImportKey` of the item: the daemon matches it. */
  key: string
  kind: "mcp" | "command"
  name: string
  tool: "claude-code" | "codex"
  scope: "user" | "project"
  /** Why it would arrive switched off, one short phrase; absent when it arrives enabled. */
  reason?: string
}
export type ImportRow = {
  tool: "claude-code" | "codex"
  mcp: number
  commands: number
  /** "3 MCP servers, 2 commands" */
  counts: string
  summary: string
  /** Every item the picker lists, in the order the daemon reported them. */
  choices: ImportChoice[]
  /** Facts shown under the picker: what is read where it is, and what is never imported. */
  inPlace: string[]
  notImported: string[]
}
export type Detected = {
  items: ReadyItem[]
  options: ModelOption[]
  recommended?: string
  /** True when at least one way to talk to a model exists: Enter can start chatting. */
  usable: boolean
  importRow?: ImportRow
}

const TOOL_NAME: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" }
const LINES: Record<ModelSource, string> = {
  chatgpt: "your ChatGPT subscription · no per-token charge",
  claude: "your Claude Code login · no per-token charge",
  codex: "your Codex login · no per-token charge",
  pi: "your own pi install · billed by whatever pi uses",
  api: "your API key · billed per token",
}
/** Best first: the product's own subscription engine, then the logins of other tools, then keys, then pi. */
const ORDER: ModelSource[] = ["chatgpt", "claude", "codex", "api", "pi"]
/** Among API providers, the ones with a first-party model come first. */
const PROVIDER_ORDER = ["anthropic", "openai", "google", "openrouter"]

const sourceOf = (model: DetectModel): ModelSource => model.engine === "claude" ? "claude" : model.engine === "codex" ? "codex" : model.engine === "pi" ? "pi" : model.provider ? "api" : "chatgpt"

const keyEnvOf = (id: string) => CONNECT_PRESETS.find((preset) => preset.id === id)?.keyEnv

/** The ready list, the model options (best first) and the recommended one. Pure: the same answers give the same result. */
export function detectReady(input: DetectInput): Detected {
  const bySource = new Map<ModelSource, DetectModel[]>()
  for (const model of input.models) bySource.set(sourceOf(model), [...(bySource.get(sourceOf(model)) ?? []), model])
  const keyed = input.providers.filter((provider) => provider.enabled && provider.hasKey && provider.authReady !== false)
  const loggedIn = input.login?.ok !== false
  const native = bySource.get("chatgpt") ?? []

  const items: ReadyItem[] = [
    native.length || input.login
      ? loggedIn && native.length
        ? { id: "chatgpt", label: "ChatGPT login", ok: true, detail: "signed in" }
        : { id: "chatgpt", label: "ChatGPT login", ok: false, detail: "not signed in", fix: "/connect" }
      : { id: "chatgpt", label: "ChatGPT login", ok: false, detail: "not used by this engine" },
    bySource.has("claude")
      ? { id: "claude", label: "Claude Code", ok: true, detail: "installed, signed in" }
      : { id: "claude", label: "Claude Code", ok: false, detail: "not found", fix: "claude auth login" },
    bySource.has("codex")
      ? { id: "codex", label: "Codex CLI", ok: true, detail: "found" }
      : { id: "codex", label: "Codex CLI", ok: false, detail: "not found", fix: "codex login" },
    bySource.has("pi")
      ? { id: "pi", label: "pi", ok: true, detail: "found" }
      : { id: "pi", label: "pi", ok: false, detail: "not found" },
    keyed.length
      ? { id: "keys", label: "API keys", ok: true, detail: keyed.map((provider) => keyEnvOf(provider.id) ?? provider.id).join(", ") }
      : { id: "keys", label: "API keys", ok: false, detail: "none in the environment", fix: "export ANTHROPIC_API_KEY=…" },
  ]
  const options: ModelOption[] = []
  if (input.selectable) {
    const usableNative = loggedIn ? native : []
    const picks: Record<ModelSource, DetectModel[]> = { chatgpt: usableNative.slice(0, 2), claude: (bySource.get("claude") ?? []).slice(0, 2), codex: (bySource.get("codex") ?? []).slice(0, 1), pi: (bySource.get("pi") ?? []).slice(0, 1), api: apiPicks(bySource.get("api") ?? [], keyed) }
    for (const source of ORDER) for (const model of picks[source]) options.push({ id: model.id, label: modelListLabel(model.id, input), source, recommended: false, current: model.id === input.selected, line: LINES[source] })
  }
  const first = options[0]
  const current = options.find((option) => option.current)
  const recommended = current?.id ?? first?.id
  const marked = options.map((option) => ({ ...option, recommended: option.id === recommended }))

  const taken = (input.imports?.items ?? []).filter((item) => item.status === "new")
  const tool = (input.imports?.found[0]?.tool ?? taken[0]?.tool) as ImportRow["tool"] | undefined
  const mcp = taken.filter((item) => item.kind === "mcp").length
  const commands = taken.filter((item) => item.kind === "command").length
  const parts = [mcp ? `${mcp} MCP ${mcp === 1 ? "server" : "servers"}` : "", commands ? `${commands} ${commands === 1 ? "command" : "commands"}` : ""].filter(Boolean)
  const choices = taken.flatMap((item): ImportChoice[] => item.name && (item.kind === "mcp" || item.kind === "command") ? [importChoice({ ...item, name: item.name, kind: item.kind })] : [])
  const importRow: ImportRow | undefined = tool && parts.length ? { tool, mcp, commands, counts: parts.join(", "), summary: `${TOOL_NAME[tool] ?? tool}: ${parts.join(", ")}`, choices, inPlace: [...(input.imports?.inPlace ?? [])], notImported: [...(input.imports?.notImported ?? [])] } : undefined

  return { items, options: marked, ...(recommended ? { recommended } : {}), usable: marked.length > 0 || !input.selectable, ...(importRow ? { importRow } : {}) }
}

function importChoice(item: DetectImportItem & { name: string; kind: "mcp" | "command" }): ImportChoice {
  const tool: ImportChoice["tool"] = item.tool === "codex" ? "codex" : "claude-code"
  const scope: ImportChoice["scope"] = item.scope === "project" ? "project" : "user"
  const reason = item.needs?.length ? `needs ${item.needs.map((name) => `$${name}`).join(", ")}` : item.kind === "mcp" && item.enabled === false ? "disabled in its own config" : undefined
  return { key: setupImportKey({ kind: item.kind, tool, scope, name: item.name }), kind: item.kind, name: item.name, tool, scope, ...(reason ? { reason } : {}) }
}

/** One model per keyed provider, the first-party providers first, so a long catalog never fills the row. */
function apiPicks(models: DetectModel[], keyed: readonly DetectProvider[]): DetectModel[] {
  const ids = keyed.map((provider) => provider.id).sort((a, b) => rank(a) - rank(b))
  return ids.flatMap((id) => models.filter((model) => model.provider === id).slice(0, 1)).slice(0, 2)
}
const rank = (id: string) => { const index = PROVIDER_ORDER.indexOf(id); return index < 0 ? PROVIDER_ORDER.length : index }

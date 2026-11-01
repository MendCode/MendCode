import { setupImportKey } from "@mendcode/protocol/wire"
import { modelLabel, modelListLabel } from "./model-label"
import { CONNECT_PRESETS, providerName } from "./provider-presets"

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
  /** `daemon.info.harnesses`: Claude Code and Codex as their own status commands report them. Absent from an older daemon. */
  harnesses?: readonly DetectHarness[] | undefined
  /** `daemon.info.ownLogins`: MendCode signs in for itself and uses no other tool's login. */
  ownLogins?: boolean | undefined
}
export type DetectHarness = { id: "claude" | "codex"; installed: boolean; signedIn?: boolean | undefined; plan?: string | undefined; login?: string | undefined }

export type ReadyItem = {
  id: "chatgpt" | "claude" | "codex" | "pi" | "keys"
  label: string
  ok: boolean
  /** What was found, or why it is missing. */
  detail: string
  /** The one command or variable that fixes a missing item. */
  fix?: string
}
export type ModelSource = "chatgpt" | "claude" | "codex" | "pi" | "api" | "acp"
export type ModelOption = {
  id: string
  /** The list label, with its provider when another option reads the same (`GPT-6.1-Sol (codex)`). */
  label: string
  /** The label alone, for a row under its group's heading (`GPT-6.1-Sol`). */
  name: string
  source: ModelSource
  /** `ModelGroupInfo.key` of the group it is listed under. */
  group: string
  recommended: boolean
  current: boolean
  /** One line: what it uses and what it costs. */
  line: string
}
/** One group of the model list: who runs its models and whose login or key pays. */
export type ModelGroupInfo = {
  key: string
  source: ModelSource
  /** `ChatGPT subscription`, `Anthropic · API key`, `Claude Code harness`. */
  title: string
  /** The name beside a model on the Model row: `ChatGPT`, `Anthropic`, `Claude Code`. */
  short: string
  /** MendCode's own engine (ChatGPT, API keys) or an external harness on its own login. */
  native: boolean
  line: string
}
/** A harness or provider that was found but offers no model yet, and the one thing that would list its models. */
export type UnavailableSource = { source: ModelSource; title: string; native: boolean; reason: string }
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
  /** Every model usable from what was found, grouped (`groups`, in that order) and in catalog order inside a group. */
  options: ModelOption[]
  /** The groups that have options, in the order the list shows them: MendCode's own engine first, then the harnesses. */
  groups: ModelGroupInfo[]
  /** What was found but lists no model yet, and how to change that. */
  unavailable: UnavailableSource[]
  recommended?: string
  /** True when at least one way to talk to a model exists: Enter can start chatting. */
  usable: boolean
  importRow?: ImportRow
}

const TOOL_NAME: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" }
/** Who runs the model and whose login pays, so a Claude model in Claude Code is never mistaken for one behind an API key. */
const LINES: Record<ModelSource, string> = {
  chatgpt: "MendCode's own engine · your ChatGPT subscription · no per-token charge",
  claude: "runs in Claude Code, hosted by MendCode · your Claude login · no per-token charge",
  codex: "runs in Codex · your Codex login · no per-token charge",
  pi: "your own pi install · billed by whatever pi uses",
  api: "your API key · billed per token",
  acp: "runs in that agent over ACP · its own login",
}
/** The recommendation, best first: the product's own subscription engine, then the logins of other tools, then keys, then pi and ACP agents. */
const ORDER: ModelSource[] = ["chatgpt", "claude", "codex", "api", "pi", "acp"]
/** The order the list shows: MendCode's own engine (ChatGPT, then each keyed provider), then the external harnesses. */
const LIST_ORDER: ModelSource[] = ["chatgpt", "api", "claude", "codex", "pi", "acp"]
/** Among API providers, the ones with a first-party model come first. */
const PROVIDER_ORDER = ["anthropic", "openai", "google", "openrouter"]
const ACP_PREFIX = "acp:"

/** An ACP model is `acp:<agent>` or `acp:<agent>/<model>`: it has no engine field and must not read as the ChatGPT subscription. */
const sourceOf = (model: DetectModel): ModelSource => model.id.startsWith(ACP_PREFIX) ? "acp" : model.engine === "claude" ? "claude" : model.engine === "codex" ? "codex" : model.engine === "pi" ? "pi" : model.provider ? "api" : model.engine ? "acp" : "chatgpt"
/** The group of a model: one per API provider and per ACP agent, one for each other source. */
const groupKeyOf = (model: DetectModel, source: ModelSource) => source === "api" ? `api:${model.provider}` : source === "acp" ? `acp:${acpAgentOf(model)}` : source
const acpAgentOf = (model: DetectModel) => model.id.startsWith(ACP_PREFIX) ? model.id.slice(ACP_PREFIX.length).split("/")[0]! : model.engine ?? "agent"

/** The heading of a group, from its first model: an ACP agent's catalog entry names its harness (`OpenCode harness`). */
function groupInfo(key: string, source: ModelSource, model: DetectModel, catalog: readonly DetectModel[]): ModelGroupInfo {
  if (source === "api") {
    const name = providerName(model.provider ?? "")
    return { key, source, title: `${name} · API key`, short: name, native: true, line: `your ${name} key · billed per token` }
  }
  if (source === "acp") {
    const agent = acpAgentOf(model)
    const entry = catalog.find((candidate) => candidate.id === `${ACP_PREFIX}${agent}`)
    const harness = (entry?.name ?? model.name.split(" · ").pop() ?? agent).trim()
    const short = harness.replace(/ harness$/, "")
    return { key, source, title: `${harness} · ACP`, short, native: false, line: `runs in ${short} over ACP · its own login` }
  }
  const fixed: Record<Exclude<ModelSource, "api" | "acp">, Omit<ModelGroupInfo, "key" | "source" | "line">> = {
    chatgpt: { title: "ChatGPT subscription", short: "ChatGPT", native: true },
    claude: { title: "Claude Code harness", short: "Claude Code", native: false },
    codex: { title: "Codex harness", short: "Codex", native: false },
    pi: { title: "pi harness", short: "pi", native: false },
  }
  return { key, source, ...fixed[source], line: LINES[source] }
}

const keyEnvOf = (id: string) => CONNECT_PRESETS.find((preset) => preset.id === id)?.keyEnv

/** The ready list, the model options (best first) and the recommended one. Pure: the same answers give the same result. */
export function detectReady(input: DetectInput): Detected {
  const bySource = new Map<ModelSource, DetectModel[]>()
  for (const model of input.models) bySource.set(sourceOf(model), [...(bySource.get(sourceOf(model)) ?? []), model])
  const keyed = input.providers.filter((provider) => provider.enabled && provider.hasKey && provider.authReady !== false)
  const loggedIn = input.login?.ok !== false
  const native = bySource.get("chatgpt") ?? []
  const claude = input.harnesses?.find((harness) => harness.id === "claude")
  const codex = input.harnesses?.find((harness) => harness.id === "codex")

  const items: ReadyItem[] = [
    native.length || input.login
      ? loggedIn && native.length
        ? { id: "chatgpt", label: "ChatGPT login", ok: true, detail: "signed in" }
        : { id: "chatgpt", label: "ChatGPT login", ok: false, detail: input.ownLogins ? "not signed in for MendCode" : "not signed in", fix: "/connect chatgpt" }
      : { id: "chatgpt", label: "ChatGPT login", ok: false, detail: "not used by this engine" },
    claudeItem(claude, bySource.has("claude")),
    codexItem(codex, bySource.has("codex"), input.ownLogins === true && !usableHarness(codex, bySource.has("codex"))),
    bySource.has("pi")
      ? { id: "pi", label: "pi", ok: true, detail: "found" }
      : { id: "pi", label: "pi", ok: false, detail: "not found" },
    keyed.length
      ? { id: "keys", label: "API keys", ok: true, detail: keyed.map((provider) => keyEnvOf(provider.id) ?? provider.id).join(", ") }
      : { id: "keys", label: "API keys", ok: false, detail: "none in the environment", fix: "export ANTHROPIC_API_KEY=…" },
  ]
  const options: ModelOption[] = []
  const groups: ModelGroupInfo[] = []
  if (input.selectable) {
    // Every model each source can run, not a sample: the Model row and its list are the whole real catalog of what was found.
    const usable: Record<ModelSource, DetectModel[]> = {
      chatgpt: loggedIn ? native : [],
      api: apiModels(bySource.get("api") ?? [], keyed),
      claude: usableHarness(claude, bySource.has("claude")) ? bySource.get("claude") ?? [] : [],
      // The Codex harness runs `codex` on the Codex CLI's own login, as Claude Code runs on its own: `ownLogins` is about MendCode's engine.
      codex: usableHarness(codex, bySource.has("codex")) ? bySource.get("codex") ?? [] : [],
      pi: bySource.get("pi") ?? [],
      acp: bySource.get("acp") ?? [],
    }
    for (const source of LIST_ORDER) {
      for (const model of usable[source]) {
        const key = groupKeyOf(model, source)
        let group = groups.find((entry) => entry.key === key)
        if (!group) groups.push(group = groupInfo(key, source, model, input.models))
        options.push({ id: model.id, label: modelListLabel(model.id, input), name: modelLabel(model.id, input), source, group: key, recommended: false, current: model.id === input.selected, line: group.line })
      }
    }
  }
  const current = options.find((option) => option.current)
  const recommended = current?.id ?? ORDER.map((source) => options.find((option) => option.source === source)).find(Boolean)?.id
  const marked = options.map((option) => ({ ...option, recommended: option.id === recommended }))
  const unavailable = input.selectable ? unavailableSources({ input, loggedIn, native, keyed, claude, codex, listed: (source) => marked.some((option) => option.source === source) }) : []

  const taken = (input.imports?.items ?? []).filter((item) => item.status === "new")
  const tool = (input.imports?.found[0]?.tool ?? taken[0]?.tool) as ImportRow["tool"] | undefined
  const mcp = taken.filter((item) => item.kind === "mcp").length
  const commands = taken.filter((item) => item.kind === "command").length
  const parts = [mcp ? `${mcp} MCP ${mcp === 1 ? "server" : "servers"}` : "", commands ? `${commands} ${commands === 1 ? "command" : "commands"}` : ""].filter(Boolean)
  const choices = taken.flatMap((item): ImportChoice[] => item.name && (item.kind === "mcp" || item.kind === "command") ? [importChoice({ ...item, name: item.name, kind: item.kind })] : [])
  const importRow: ImportRow | undefined = tool && parts.length ? { tool, mcp, commands, counts: parts.join(", "), summary: `${TOOL_NAME[tool] ?? tool}: ${parts.join(", ")}`, choices, inPlace: [...(input.imports?.inPlace ?? [])], notImported: [...(input.imports?.notImported ?? [])] } : undefined

  return { items, options: marked, groups, unavailable, ...(recommended ? { recommended } : {}), usable: marked.length > 0 || !input.selectable, ...(importRow ? { importRow } : {}) }
}

/** A harness can run its models unless its own status says it is not installed or not signed in; without a status, a listed one can. */
const usableHarness = (harness: DetectHarness | undefined, listed: boolean) => listed && harness?.installed !== false && harness?.signedIn !== false

/**
 * What was found but lists no model yet, each with the one step that lists its models: MendCode's ChatGPT login, an API key,
 * a harness's own sign-in, and the Codex harness, whose models a native daemon lists only with its thread bridge (full tier).
 */
function unavailableSources(input: { input: DetectInput; loggedIn: boolean; native: readonly DetectModel[]; keyed: readonly DetectProvider[]; claude: DetectHarness | undefined; codex: DetectHarness | undefined; listed(source: ModelSource): boolean }): UnavailableSource[] {
  const out: UnavailableSource[] = []
  const { claude, codex } = input
  if ((input.native.length || input.input.login) && !input.listed("chatgpt")) out.push({ source: "chatgpt", title: "ChatGPT subscription", native: true, reason: `${input.input.ownLogins ? "not signed in for MendCode" : "not signed in"} · /connect chatgpt` })
  if (!input.keyed.length) out.push({ source: "api", title: "API-key providers", native: true, reason: "no key yet · /connect saves one" })
  if (claude?.installed && !input.listed("claude")) out.push({ source: "claude", title: "Claude Code harness", native: false, reason: claude.signedIn === false ? `not signed in · ${claude.login ?? "claude auth login"}` : "installed · no models listed yet · r checks again" })
  if (codex?.installed && !input.listed("codex")) out.push({ source: "codex", title: "Codex harness", native: false, reason: codex.signedIn === false ? `not signed in · ${codex.login ?? "codex login"}` : "full tier · /tier thread_mcp on codex lists its models" })
  return out
}

/**
 * Claude Code as `claude auth status` reports it: installed, signed in, and the plan only when it says so. Without the daemon's
 * report (an older daemon) a catalog that has Claude Code models says only that it is installed, never that it is signed in.
 */
function claudeItem(harness: DetectHarness | undefined, listed: boolean): ReadyItem {
  const label = "Claude Code"
  if (!harness) return listed ? { id: "claude", label, ok: true, detail: "installed · sign-in not checked" } : { id: "claude", label, ok: false, detail: "not found", fix: CLAUDE_INSTALL }
  if (!harness.installed) return { id: "claude", label, ok: false, detail: "not installed", fix: CLAUDE_INSTALL }
  if (harness.signedIn === false) return { id: "claude", label, ok: false, detail: "installed · not signed in", fix: harness.login ?? "claude auth login" }
  if (harness.signedIn === undefined) return { id: "claude", label, ok: true, detail: "installed · sign-in not confirmed" }
  return { id: "claude", label, ok: true, detail: `signed in · ${harness.plan ? `${harness.plan} plan` : "plan not reported"}` }
}

/** The Codex CLI: with `ownLogins` it is only reported, since MendCode signs in to ChatGPT for itself (`/connect chatgpt`). */
function codexItem(harness: DetectHarness | undefined, listed: boolean, ownLogins: boolean): ReadyItem {
  const label = "Codex CLI"
  if (!harness) return listed ? { id: "codex", label, ok: true, detail: "found" } : { id: "codex", label, ok: false, detail: "not found", fix: "codex login" }
  if (!harness.installed) return { id: "codex", label, ok: false, detail: "not installed" }
  // A note, not a fix: the ChatGPT row already says how MendCode signs in.
  if (ownLogins) return { id: "codex", label, ok: false, detail: `${harness.signedIn ? "signed in" : "installed"} · its login is not used` }
  return harness.signedIn ? { id: "codex", label, ok: true, detail: "installed · signed in" } : { id: "codex", label, ok: false, detail: "installed · not signed in", fix: harness.login ?? "codex login" }
}
/** Not installed: where to get it (signing in comes after, and the page says how once it is there). */
const CLAUDE_INSTALL = "claude.com/claude-code"

function importChoice(item: DetectImportItem & { name: string; kind: "mcp" | "command" }): ImportChoice {
  const tool: ImportChoice["tool"] = item.tool === "codex" ? "codex" : "claude-code"
  const scope: ImportChoice["scope"] = item.scope === "project" ? "project" : "user"
  const reason = item.needs?.length ? `needs ${item.needs.map((name) => `$${name}`).join(", ")}` : item.kind === "mcp" && item.enabled === false ? "disabled in its own config" : undefined
  return { key: setupImportKey({ kind: item.kind, tool, scope, name: item.name }), kind: item.kind, name: item.name, tool, scope, ...(reason ? { reason } : {}) }
}

/** Every model of each keyed provider, the first-party providers first; a provider without a key lists nothing. */
function apiModels(models: DetectModel[], keyed: readonly DetectProvider[]): DetectModel[] {
  const ids = keyed.map((provider) => provider.id).sort((a, b) => rank(a) - rank(b))
  return ids.flatMap((id) => models.filter((model) => model.provider === id))
}
const rank = (id: string) => { const index = PROVIDER_ORDER.indexOf(id); return index < 0 ? PROVIDER_ORDER.length : index }

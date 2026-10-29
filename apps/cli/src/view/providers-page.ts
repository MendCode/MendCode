import type { ColorName, Glyphs, Line } from "../ui/theme"
import { glyphs as defaultGlyphs } from "../ui/theme"
import type { ProviderInfo } from "@mendcode/protocol"
import { panelGrid, clip, deck, deckChrome, fit, spread } from "./deck"
import { presetOf, providerName } from "./provider-presets"
import { truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * `/providers`: the API-key providers the daemon knows (`providers.list`): name, wire format, where it was configured, the
 * key's masked tail, on/off, how many models, and why it cannot be used. Keys act on the selected row: `e` toggles it,
 * `t` tests it, `r` refreshes its model list, `d` removes it (after `y`), `a` adds one through /connect. The key is never
 * shown: the daemon only ever sends `hasKey` and a tail.
 */

export type ProvidersPageState = { selected: number; detail: boolean; /** Provider id waiting for `y` to be removed. */ confirm?: string }

export type ProvidersPageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "connect" }
  | { type: "toggle"; provider: string; enabled: boolean }
  | { type: "test"; provider: string }
  | { type: "refresh"; provider: string }
  | { type: "remove"; provider: string }

/** What the last action on a provider said (shown in its row), and what is still running. */
export type ProviderNote = { text: string; tone: "success" | "error" | "muted" }

const NONE: ProvidersPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const HINTS = "↑↓ select · enter details · e toggle · t test · r refresh models · d remove · a add · esc back"
const CONFIRM_HINTS = "y remove · n cancel"
const MAX_MODELS_SHOWN = 8

export function createProvidersPageState(): ProvidersPageState {
  return { selected: 0, detail: false }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

/** Handles one raw key. Returns the same state object when nothing changed. */
export function providersPageKey(state: ProvidersPageState, key: string, providers: readonly ProviderInfo[]): { state: ProvidersPageState; action: ProvidersPageAction } {
  const selected = clamp(state.selected, providers.length)
  const target = providers[selected]
  if (state.confirm) {
    if (key === "y" || key === "Y") return { state: { selected: state.selected, detail: state.detail }, action: { type: "remove", provider: state.confirm } }
    if (key === "n" || key === "N" || key === "\x1b") return { state: { selected: state.selected, detail: state.detail }, action: NONE }
    return { state, action: NONE }
  }
  if (key === "\x1b" || key === "q") return state.detail ? { state: { ...state, detail: false }, action: NONE } : { state, action: { type: "close" } }
  if (key === "a") return { state, action: { type: "connect" } }
  const go = (index: number) => {
    const next = clamp(index, providers.length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next }, action: NONE }
  }
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (!target) return { state, action: NONE }
  if (key === "\r" || key === " ") return { state: { ...state, detail: !state.detail }, action: NONE }
  if (key === "e") return { state, action: { type: "toggle", provider: target.id, enabled: !target.enabled } }
  if (key === "t") return { state, action: { type: "test", provider: target.id } }
  if (key === "r") return { state, action: { type: "refresh", provider: target.id } }
  if (key === "d") return { state: { ...state, confirm: target.id }, action: NONE }
  return { state, action: NONE }
}

/** The key column: the masked tail, `set` for a short key, `env` when only the environment holds it, `none` for a local server. */
export function keyLabel(info: ProviderInfo): { text: string; tone: ColorName } {
  if (info.vertex) return { text: info.authReady ? "ADC" : "missing", tone: info.error || !info.authReady ? "warning" : "text" }
  if (info.azure?.auth === "entra") return { text: "Entra", tone: info.error ? "warning" : "text" }
  if (info.bedrock) return { text: info.hasKey ? "bearer" : info.authReady ? "chain" : "missing", tone: info.error || !info.authReady ? "warning" : "text" }
  if (info.keyTail) return { text: info.keyTail, tone: "text" }
  if (info.hasKey) return { text: info.source === "env" ? "env" : "set", tone: "text" }
  if (presetOf(info.id)?.keyless) return { text: "none", tone: "muted" }
  return { text: "missing", tone: "warning" }
}

type Column = { text: string; fg: ColorName; width: number }

function providerRow(input: { info: ProviderInfo; selected: boolean; note?: ProviderNote | undefined; width: number; nameWidth: number; glyphs: Glyphs }): Line {
  const { info, note, width } = input
  const key = keyLabel(info)
  const models = `${info.models.length}`
  const last: Column | undefined = note
    ? { text: note.text, fg: note.tone === "success" ? "success" : note.tone === "error" ? "error" : "muted", width: 0 }
    : info.error
      ? { text: info.error, fg: "error", width: 0 }
      : undefined
  const cells: Column[] = [
    { text: info.type, fg: "muted", width: 17 },
    { text: info.source, fg: "muted", width: 6 },
    { text: key.text, fg: key.tone, width: 8 },
    { text: info.enabled ? "on" : "off", fg: info.enabled ? "success" : "muted", width: 3 },
    { text: models, fg: "text", width: 6 },
  ]
  const row: Line = [
    input.selected ? { text: `${input.glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: truncateEnd(providerName(info.id), input.nameWidth).padEnd(input.nameWidth), fg: input.selected ? "primary" : "text", bold: input.selected },
  ]
  let used = 2 + input.nameWidth
  for (const cell of cells) {
    if (used + 1 + cell.width > width) break
    row.push({ text: " " }, { text: truncateEnd(cell.text, cell.width).padEnd(cell.width), fg: cell.fg })
    used += 1 + cell.width
  }
  if (last && width - used > 6) row.push({ text: " " }, { text: truncateEnd(last.text.replace(/\s+/g, " "), width - used - 1), fg: last.fg })
  return fit(row, width)
}

function headerRow(nameWidth: number, width: number, auth = false): Line {
  const columns = [["type", 17], ["source", 6], [auth ? "auth" : "key", 8], ["on", 3], ["models", 6]] as const
  const row: Line = [{ text: "  " }, { text: "provider".padEnd(nameWidth), fg: "muted", dim: true }]
  let used = 2 + nameWidth
  for (const [label, columnWidth] of columns) {
    if (used + 1 + columnWidth > width) break
    row.push({ text: ` ${label.padEnd(columnWidth)}`, fg: "muted", dim: true })
    used += 1 + columnWidth
  }
  return clip(row, width)
}

function detailLines(info: ProviderInfo, note: ProviderNote | undefined, width: number): Line[] {
  const indent = "    "
  const line = (label: string, value: string, fg: ColorName = "text"): Line => clip([{ text: indent }, { text: label.padEnd(10), fg: "muted" }, { text: truncateEnd(value, Math.max(1, width - indent.length - 10)), fg }], width)
  const key = keyLabel(info)
  const rows: Line[] = [line("id", info.id), line("endpoint", info.baseUrl), line("key", key.text === "missing" ? "missing" : info.hasKey ? `${key.text}${info.source === "env" ? " · from the environment" : ""}` : key.text, key.tone)]
  if (info.azure) rows.push(line("auth", info.azure.auth === "entra" ? "Entra · daemon environment" : "API key"), line("API", info.azure.useCompletionUrls ? "Chat Completions" : "Responses"), line("version", info.azure.apiVersion ?? "v1"), line("URLs", info.azure.useDeploymentBasedUrls ? "deployment" : "v1"))
  if (info.error) for (const text of wrap(info.error, Math.max(1, width - indent.length - 10)).slice(0, 3)) rows.push(clip([{ text: indent }, { text: "error".padEnd(10), fg: "muted" }, { text, fg: "error" }], width))
  if (note) rows.push(line("last", note.text, note.tone === "success" ? "success" : note.tone === "error" ? "error" : "muted"))
  const shown = info.models.slice(0, MAX_MODELS_SHOWN)
  shown.forEach((model, index) => {
    const facts = [model.effort ? "effort" : "", model.images === false ? "no images" : "", model.context ? `${Math.round(model.context / 1000)}k` : ""].filter(Boolean).join(" · ")
    rows.push(clip([{ text: indent }, { text: (index === 0 ? "models" : "").padEnd(10), fg: "muted" }, { text: model.id, fg: "text" }, ...(facts ? [{ text: `  ${facts}`, fg: "muted" as const, dim: true }] : [])], width))
  })
  if (info.models.length > shown.length) rows.push(line("", `+ ${info.models.length - shown.length} more`, "muted"))
  if (info.models.length === 0) rows.push(line("models", "none listed · r asks the provider for its list", "muted"))
  return rows
}

export type ProvidersPageInput = {
  state: ProvidersPageState
  providers?: readonly ProviderInfo[] | undefined
  error?: string | undefined
  /** By provider id: what the last action said, or a running one (`testing…`). */
  notes?: Readonly<Record<string, ProviderNote>>
  width: number
  height: number
  glyphs?: Glyphs
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderProvidersPage(input: ProvidersPageInput): Line[] {
  const { state, providers, error, width, height } = input
  if (height <= 0) return []
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)
  const confirming = state.confirm !== undefined
  const hints = confirming ? CONFIRM_HINTS : HINTS
  const room = Math.max(0, height - deckChrome(hints, width, confirming ? { mode: true } : {}))
  if (providers?.length === 0) {
    const header = spread([{ text: "Providers", fg: "primary", bold: true }], [{ text: "a add · esc back", fg: "muted" }], inner)
    const grid = panelGrid({ width: inner, compact: false, padding: true, maxColumns: 1, heights: [Math.max(0, height - 4)], rows: [[{ title: "No providers", body: (w) => ["no API-key providers · press a (or /connect) to add one", "", "A key in OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, GROQ_API_KEY or DEEPSEEK_API_KEY in the daemon's environment enables its provider without any entry."].flatMap((value) => wrap(value, w).map((text): Line => [{ text, fg: "muted" }])) }]] })
    const rows: Line[] = [header, [{ text: "─".repeat(inner), fg: "border" }], [], ...grid]
    while (rows.length < height) rows.push([])
    return rows.slice(0, height).map((line) => fit([{ text: " " }, ...line], width))
  }
  if (providers?.some((info) => info.type === "google" || info.type === "github-copilot" || info.type === "amazon-bedrock" || (info.type === "google-vertex" || info.type === "google-vertex-anthropic") || info.type === "xai" || info.type === "mistral" || info.id === "perplexity" || info.id === "alibaba" || info.id === "opencode" || info.id === "llmgateway" || info.id === "nvidia" || info.id === "zenmux" || info.id === "gitlab" || info.id === "togetherai" || info.id === "kilo" || info.id === "deepinfra" || info.id === "cerebras" || info.type === "cohere" || info.id === "cloudflare-workers-ai" || info.id === "cloudflare-ai-gateway")) {
    const selected = clamp(state.selected, providers.length)
    const info = providers[selected]!
    const nameWidth = Math.max(8, Math.min(18, Math.max(...providers.map((entry) => providerName(entry.id).length))))
    const details = (w: number): Line[] => {
      const field = (label: string, value: string, fg: ColorName = "text") => wrap(`${label}: ${value}`, w).map((text): Line => [{ text, fg }])
      const note = input.notes?.[info.id]
      return [
        ...(confirming ? [[{ text: `Remove ${providerName(state.confirm!)}?`, fg: "warning" } as const], []] : []),
        ...field("State", `${info.enabled ? "on" : "off"} · ${info.id === "gitlab" ? "GitLab native" : info.type} · ${info.source}`),
        ...field("Endpoint", info.baseUrl, "muted"),
        ...field(info.vertex || info.bedrock ? "Auth" : "Key", info.vertex ? `Google ADC · ${info.authReady ? "candidate present" : "missing credentials"}` : info.bedrock ? `${info.hasKey || info.bedrock.auth === "bearer" ? "Bedrock bearer token" : "AWS credential chain"} · ${info.authReady ? "candidate present" : "missing credentials"}` : keyLabel(info).text),
        ...(info.vertex ? [
          ...field("Project", info.vertex.project ?? "missing", info.vertex.project ? "text" : "warning"),
          ...field("Location", info.vertex.location ?? (info.type === "google-vertex-anthropic" ? "global" : "us-central1")),
          ...field("Metadata", info.vertex.allowMetadata ? "on" : "off"),
          ...(info.vertex.quotaProject ? field("Quota project", info.vertex.quotaProject) : []),
        ] : []),
        ...(info.bedrock ? [
          ...field("AWS region", `${info.bedrock.region ?? "us-east-1"} · profile ${info.bedrock.profile ?? "default"}`),
          ...field("Metadata", `${info.bedrock.allowMetadata ? "on" : "off"} · credential process ${info.bedrock.allowCredentialProcess ? "on" : "off"}`),
        ] : []),
        ...(info.gitlab ? [
          ...field("Auth", info.gitlab.authType === "oauth" ? "OAuth access token" : "Personal access token"),
          ...(info.gitlab.rootNamespaceId ? field("Namespace", info.gitlab.rootNamespaceId) : []),
          ...(info.gitlab.projectId ? field("Project", info.gitlab.projectId) : []),
          ...field("Workflow tools", "local permissions"),
        ] : []),
        ...(info.cloudflareWorkersAi?.accountId ? field("Account", info.cloudflareWorkersAi.accountId) : []),
        ...(info.cloudflareAiGateway ? [
          ...(info.cloudflareAiGateway.accountId ? field("Account", info.cloudflareAiGateway.accountId) : []),
          ...(info.cloudflareAiGateway.gatewayId ? field("Gateway", info.cloudflareAiGateway.gatewayId) : []),
          ...field("Metadata", info.cloudflareAiGateway.hasMetadata ? "configured" : "off"),
          ...field("Cache key", info.cloudflareAiGateway.hasCacheKey ? "configured" : "gateway default"),
          ...(info.cloudflareAiGateway.cacheTtl != null ? field("Cache TTL", `${info.cloudflareAiGateway.cacheTtl}s`) : []),
          ...field("Cache", info.cloudflareAiGateway.skipCache == null ? "gateway default" : info.cloudflareAiGateway.skipCache ? "bypass" : "enabled"),
          ...field("Logs", info.cloudflareAiGateway.collectLog == null ? "gateway default" : info.cloudflareAiGateway.collectLog ? "enabled" : "off"),
        ] : []),
        [],
        ...info.models.flatMap((model) => field("Model", `${model.id}${model.context ? ` · ${Math.round(model.context / 1000)}k` : ""}${model.tool_call === false ? " · no tools" : ""}${model.images === false ? " · no images" : ""}`)),
        ...(info.error ? field("Error", info.error, "error") : []),
        ...(note ? field("Last", note.text, note.tone) : []),
      ]
    }
    const list = (w: number): Line[] => w < 70 ? providers.map((entry, index) => fit([
      { text: index === selected ? `${glyphs.user} ` : "  ", fg: "primary" },
      { text: providerName(entry.id), fg: "text", bold: index === selected },
      { text: ` · ${entry.enabled ? "on" : "off"} · ${entry.models.length} ${entry.models.length === 1 ? "model" : "models"} · ${entry.vertex ? "auth" : "key"} ${keyLabel(entry).text}`, fg: "muted" },
    ], w)) : [headerRow(nameWidth, w, providers.some((entry) => Boolean(entry.vertex))), ...providers.map((entry, index) => providerRow({ info: entry, selected: index === selected, note: input.notes?.[entry.id], width: w, nameWidth, glyphs }))]
    const panels = width >= 110 ? [
      { title: "Providers", weight: 3, body: list, scroll: Math.max(0, selected + 2 - (height - 8)) },
      { title: providerName(info.id), weight: 2, body: details },
    ] : [{ title: state.detail || confirming ? providerName(info.id) : "Providers", body: (w: number) => state.detail || confirming ? details(w) : list(w), scroll: state.detail || confirming ? 0 : Math.max(0, selected + 2 - (height - 8)) }]
    const fullHints = confirming ? CONFIRM_HINTS : HINTS
    const shortHints = confirming ? CONFIRM_HINTS : "↑↓ · enter · e · t · r · esc"
    const header = spread([{ text: "Providers", fg: "primary", bold: true }], [{ text: fullHints.length + 13 <= inner ? fullHints : shortHints, fg: "muted" }], inner)
    const grid = panelGrid({ width: inner, compact: false, padding: true, maxColumns: width >= 110 ? 2 : 1, heights: [Math.max(0, height - 4)], rows: [panels] })
    const rows: Line[] = [header, [{ text: "─".repeat(inner), fg: "border" }], [], ...grid]
    while (rows.length < height) rows.push([])
    return rows.slice(0, height).map((line) => fit([{ text: " " }, ...line], width))
  }
  let body: Line[] = []
  let summary = ""
  let status: { label: string; tone: "warn" | "error" } | undefined
  let focus = 0

  if (!providers) {
    body = [[{ text: error ?? "loading providers…", fg: error ? "error" : "muted" }]]
    if (error) status = { label: "Error", tone: "error" }
  } else if (providers.length === 0) {
    body = [
      [{ text: "no API-key providers · press a (or /connect) to add one", fg: "muted" }],
      [],
      [{ text: "A key in OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, GROQ_API_KEY or DEEPSEEK_API_KEY", fg: "muted" }],
      [{ text: "in the daemon's environment enables its provider without any entry.", fg: "muted" }],
    ].map((row) => clip(row as Line, inner))
  } else {
    const selected = clamp(state.selected, providers.length)
    const nameWidth = Math.max(8, Math.min(18, Math.max(...providers.map((info) => providerName(info.id).length))))
    body.push(headerRow(nameWidth, inner))
    providers.forEach((info, index) => {
      if (index === selected) focus = body.length
      body.push(providerRow({ info, selected: index === selected, note: input.notes?.[info.id], width: inner, nameWidth, glyphs }))
      if (index === selected && state.detail) body.push(...detailLines(info, input.notes?.[info.id], inner))
    })
    const on = providers.filter((info) => info.enabled).length
    summary = `${on} of ${providers.length} on`
    const broken = providers.filter((info) => info.error).length
    if (broken) status = { label: `${broken} need${broken === 1 ? "s" : ""} attention`, tone: "warn" }
  }

  if (providers?.length && width >= 110) {
    const selected = clamp(state.selected, providers.length)
    const info = providers[selected]!
    body = panelGrid({ width: inner, heights: [room], rows: [[
      { title: "Providers", weight: 3, body: (w) => [headerRow(18, w), ...providers.map((info, index) => providerRow({ info, selected: index === selected, note: input.notes?.[info.id], width: w, nameWidth: 18, glyphs }))], scroll: Math.max(0, selected + 3 - (room - 2)) },
      { title: providerName(info.id), weight: 2, body: (w) => state.detail ? detailLines(info, input.notes?.[info.id], w) : [
        [{ text: `${info.enabled ? "Enabled" : "Disabled"} · ${info.models.length} models`, fg: "text" }],
        [{ text: `${info.type} · ${info.source}`, fg: "muted" }],
        [{ text: "Enter details", fg: "muted" }],
      ] },
    ]] })
    focus = 0
  }

  const name = state.confirm ? providerName(state.confirm) : ""
  return deck({
    page: "Providers",
    subtitle: "API keys",
    ...(summary ? { summary } : {}),
    ...(status ? { status } : {}),
    ...(confirming ? { mode: { key: `Remove ${name}?`, label: "its key and model list are deleted from providers.json" } } : {}),
    body,
    scroll: Math.max(0, focus + 1 - room),
    hints,
    width,
    height,
  })
}

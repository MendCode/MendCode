import { run } from "@/util/process"
import type { MendPromptChromePreset } from "./prompt-chrome"

export type MendPromptStatusPlacement = "inside" | "outside"
export type MendPromptStatusBuiltin =
  | "mode"
  | "model"
  | "provider"
  | "reasoning"
  | "variant"
  | "context"
  | "permissionMode"
  | "commandsHint"
  | "agentsHint"

export type MendPromptStatusItem = {
  type: "builtin"
  value: MendPromptStatusBuiltin
}

export type MendPromptStatusScript = {
  enabled?: boolean
  command?: string
  timeoutMs?: number
  refreshMs?: number
  prepend?: boolean
}

export type MendPromptStatusScripts = Partial<Record<"left" | "right", MendPromptStatusScript>>

export type MendPromptStatusConfig = {
  enabled: boolean
  context?: {
    visible?: boolean
  }
  commandsHint?: {
    visible?: boolean
  }
  placementByPreset?: Partial<Record<MendPromptChromePreset, MendPromptStatusPlacement>>
  left: MendPromptStatusItem[]
  right: MendPromptStatusItem[]
  separator?: string
  colors?: Record<string, string>
  scripts?: MendPromptStatusScripts
  script?: MendPromptStatusScript
}

export type MendPromptStatusResolved = {
  enabled: boolean
  context?: {
    visible?: boolean
  }
  placement: MendPromptStatusPlacement
  left: MendPromptStatusItem[]
  right: MendPromptStatusItem[]
  separator: string
  colors: Record<string, string>
  scripts: MendPromptStatusScripts
  script?: MendPromptStatusScript
}

export type MendPromptStatusScriptInput = {
  command: string
  root: string
  rootName?: string
  sessionID?: string
  workspaceID?: string
  promptMode: string
  promptModeLabel?: string
  agentLabel?: string
  model: string
  modelLabel?: string
  provider: string
  providerLabel?: string
  reasoning?: string
  reasoningLabel?: string
  variant?: string
  context?: string
  contextTokens?: number
  contextLimit?: number
  contextPercent?: number
  permissionMode?: string
  permissionModeLabel?: string
  permissionPending?: number
  commandsHint?: string
  agentsHint?: string
  preset: MendPromptChromePreset
  side: "left" | "right"
  prepend: boolean
  timeoutMs: number
  refreshKey?: number
}

export type MendPromptStatusScriptSegment = {
  text: string
  fg?: string
  bold?: boolean
}

export type MendPromptStatusScriptOutput = {
  text: string
  segments?: MendPromptStatusScriptSegment[]
}

export type MendPromptStatusScriptResult = {
  identity: string
  output: MendPromptStatusScriptOutput
}

const scriptCache = new Map<string, { value: MendPromptStatusScriptOutput; expiresAt: number; inflight?: Promise<MendPromptStatusScriptOutput> }>()
const scriptWarmCache = new Map<string, { value: MendPromptStatusScriptOutput; expiresAt: number }>()

function warmCacheKey(input: MendPromptStatusScriptInput) {
  return JSON.stringify({
    root: input.root,
    command: input.command,
    promptMode: input.promptMode,
    promptModeLabel: input.promptModeLabel || "",
    agentLabel: input.agentLabel || "",
    model: input.model,
    modelLabel: input.modelLabel || "",
    provider: input.provider,
    providerLabel: input.providerLabel || "",
    reasoning: input.reasoning || "",
    reasoningLabel: input.reasoningLabel || "",
    variant: input.variant || "",
    context: input.context || "",
    contextTokens: input.contextTokens ?? "",
    contextLimit: input.contextLimit ?? "",
    contextPercent: input.contextPercent ?? "",
    permissionMode: input.permissionMode || "",
    permissionModeLabel: input.permissionModeLabel || "",
    permissionPending: input.permissionPending ?? 0,
    preset: input.preset,
    side: input.side,
    prepend: input.prepend,
  })
}

export function promptStatusScriptIdentityKey(input: MendPromptStatusScriptInput) {
  return JSON.stringify({
    root: input.root,
    rootName: input.rootName || "",
    command: input.command,
    sessionID: input.sessionID || "",
    workspaceID: input.workspaceID || "",
    promptMode: input.promptMode,
    promptModeLabel: input.promptModeLabel || "",
    agentLabel: input.agentLabel || "",
    model: input.model,
    modelLabel: input.modelLabel || "",
    provider: input.provider,
    providerLabel: input.providerLabel || "",
    reasoning: input.reasoning || "",
    reasoningLabel: input.reasoningLabel || "",
    variant: input.variant || "",
    permissionMode: input.permissionMode || "",
    permissionModeLabel: input.permissionModeLabel || "",
    permissionPending: input.permissionPending ?? 0,
    commandsHint: input.commandsHint || "",
    agentsHint: input.agentsHint || "",
    preset: input.preset,
    side: input.side,
    prepend: input.prepend,
  })
}

export function pickPromptStatusScriptOutput(input: {
  currentIdentity?: string
  current?: MendPromptStatusScriptResult
  latest?: MendPromptStatusScriptResult
}) {
  if (!input.currentIdentity) return input.current?.output ?? input.latest?.output
  if (input.current?.identity === input.currentIdentity) return input.current.output
  if (input.latest?.identity === input.currentIdentity) return input.latest.output
  return undefined
}

export function defaultPromptStatus(): MendPromptStatusConfig {
  return {
    enabled: true,
    context: {
      visible: false,
    },
    commandsHint: {
      visible: false,
    },
    placementByPreset: {
      box: "outside",
      "top-bottom": "outside",
      minimal: "outside",
      "ascii-box": "inside",
    },
    left: [
      { type: "builtin", value: "mode" },
      { type: "builtin", value: "model" },
      { type: "builtin", value: "provider" },
      { type: "builtin", value: "reasoning" },
    ],
    right: [],
    separator: " · ",
    colors: {},
    scripts: {
      left: {
        enabled: false,
        command: "",
        timeoutMs: 150,
        refreshMs: 1000,
        prepend: false,
      },
      right: {
        enabled: false,
        command: "",
        timeoutMs: 150,
        refreshMs: 1000,
        prepend: false,
      },
    },
    script: {
      enabled: false,
      command: "",
      timeoutMs: 150,
      refreshMs: 1000,
      prepend: false,
    },
  }
}

export function resolvePromptStatus(config: MendPromptStatusConfig | null | undefined, preset: MendPromptChromePreset): MendPromptStatusResolved {
  const defaults = defaultPromptStatus()
  const merged = {
    ...defaults,
    ...(config || {}),
    context: {
      ...(defaults.context || {}),
      ...(config?.context || {}),
    },
    placementByPreset: {
      ...(defaults.placementByPreset || {}),
      ...(config?.placementByPreset || {}),
    },
    left: Array.isArray(config?.left) ? config!.left : defaults.left,
    right: Array.isArray(config?.right) ? config!.right : defaults.right,
    colors: {
      ...(defaults.colors || {}),
      ...(config?.colors || {}),
    },
    scripts: {
      ...(defaults.scripts || {}),
      ...(config?.scripts || {}),
      left: {
        ...(defaults.scripts?.left || {}),
        ...(config?.scripts?.left || {}),
      },
      right: {
        ...(defaults.scripts?.right || {}),
        ...(config?.scripts?.right || {}),
      },
    },
    script: {
      ...(defaults.script || {}),
      ...(config?.script || {}),
    },
    commandsHint: {
      ...(defaults.commandsHint || {}),
      ...(config?.commandsHint || {}),
    },
  }
  const legacyScript = merged.script
  if (legacyScript?.command?.trim()) {
    const fallbackSide = "left"
    merged.scripts = {
      ...merged.scripts,
      [fallbackSide]: {
        ...(merged.scripts?.[fallbackSide] || {}),
        enabled: legacyScript.enabled ?? true,
        command: legacyScript.command,
        timeoutMs: legacyScript.timeoutMs,
        prepend: legacyScript.prepend,
      },
    }
  }
  return {
    enabled: merged.enabled !== false,
    context: merged.context,
    placement: merged.placementByPreset?.[preset] || "outside",
    left: filterPromptStatusItems(merged.left, merged),
    right: filterPromptStatusItems(merged.right, merged),
    separator: merged.separator || " · ",
    colors: merged.colors || {},
    scripts: merged.scripts || {},
    script: merged.script,
  }
}

function filterPromptStatusItems(items: MendPromptStatusItem[], config: { commandsHint?: { visible?: boolean } }) {
  if (config.commandsHint?.visible === false) return items.filter((item) => item.value !== "commandsHint")
  return items
}

function normalizeScriptText(text: string) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ")
    .trim()
}

function parseTsvScriptSegments(text: string): MendPromptStatusScriptSegment[] | undefined {
  const lines = text.split(/\r?\n/g).filter(Boolean)
  const segments = lines
    .map((line): MendPromptStatusScriptSegment | undefined => {
      const [fg = "", bold = "", ...rest] = line.split("\t")
      const value = rest.join("\t")
      if (!value.trim()) return
      return {
        text: value,
        fg: fg.trim() || undefined,
        bold: bold.trim() === "1" || bold.trim().toLowerCase() === "true",
      }
    })
    .filter((item): item is MendPromptStatusScriptSegment => Boolean(item?.text.trim()))
  return segments.length ? segments : undefined
}

function parseScriptOutput(text: string): MendPromptStatusScriptOutput {
  const trimmed = text.trim()
  if (!trimmed) return { text: "" }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const rawSegments = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && "segments" in parsed && Array.isArray((parsed as any).segments)
          ? (parsed as any).segments
          : undefined
      if (rawSegments) {
        const segments = rawSegments
          .filter((item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item: Record<string, unknown>): MendPromptStatusScriptSegment => ({
            text: typeof item.text === "string" ? item.text : "",
            fg: typeof item.fg === "string" ? item.fg : undefined,
            bold: item.bold === true,
          }))
          .filter((item: MendPromptStatusScriptSegment) => item.text.trim())
        if (segments.length) {
          return {
            text: segments.map((item: MendPromptStatusScriptSegment) => item.text).join(""),
            segments,
          }
        }
      }
    } catch {}
  }

  if (trimmed.includes("\t")) {
    const segments = parseTsvScriptSegments(trimmed)
    if (segments?.length) {
      return {
        text: segments.map((item: MendPromptStatusScriptSegment) => item.text).join(""),
        segments,
      }
    }
  }

  return { text: normalizeScriptText(trimmed) }
}

export async function readPromptStatusScript(input: MendPromptStatusScriptInput) {
  const key = JSON.stringify(input)
  const warmKey = warmCacheKey(input)
  const now = Date.now()
  const cached = scriptCache.get(key)
  const warmed = scriptWarmCache.get(warmKey)
  if (cached && cached.expiresAt > now && !cached.inflight) return cached.value
  if (cached?.inflight) return cached.inflight

  const inflight = run(["sh", "-lc", input.command], {
    cwd: input.root,
    timeout: input.timeoutMs,
    nothrow: true,
    env: {
      MEND_TUI_ROOT: input.root,
      MEND_TUI_ROOT_NAME: input.rootName || "",
      MEND_TUI_SESSION_ID: input.sessionID || "",
      MEND_TUI_WORKSPACE_ID: input.workspaceID || "",
      MEND_TUI_PROMPT_MODE: input.promptMode,
      MEND_TUI_PROMPT_MODE_LABEL: input.promptModeLabel || "",
      MEND_TUI_AGENT_LABEL: input.agentLabel || "",
      MEND_TUI_MODEL: input.model,
      MEND_TUI_MODEL_LABEL: input.modelLabel || "",
      MEND_TUI_PROVIDER: input.provider,
      MEND_TUI_PROVIDER_LABEL: input.providerLabel || "",
      MEND_TUI_REASONING: input.reasoning || "",
      MEND_TUI_REASONING_LABEL: input.reasoningLabel || "",
      MEND_TUI_VARIANT: input.variant || "",
      MEND_TUI_CONTEXT: input.context || "",
      MEND_TUI_CONTEXT_TOKENS: input.contextTokens === undefined ? "" : String(input.contextTokens),
      MEND_TUI_CONTEXT_LIMIT: input.contextLimit === undefined ? "" : String(input.contextLimit),
      MEND_TUI_CONTEXT_PERCENT: input.contextPercent === undefined ? "" : String(input.contextPercent),
      MEND_TUI_PERMISSION_MODE: input.permissionMode || "",
      MEND_TUI_PERMISSION_MODE_LABEL: input.permissionModeLabel || "",
      MEND_TUI_PERMISSION_PENDING: String(input.permissionPending ?? 0),
      MEND_TUI_COMMANDS_HINT: input.commandsHint || "",
      MEND_TUI_AGENTS_HINT: input.agentsHint || "",
      MEND_TUI_PROMPT_PRESET: input.preset,
      MEND_TUI_STATUS_SIDE: input.side,
      MEND_TUI_STATUS_PREPEND: input.prepend ? "1" : "0",
      MEND_TUI_STATUS_REFRESH_KEY: String(input.refreshKey ?? 0),
    },
  })
    .then((result) => parseScriptOutput(result.stdout.toString("utf8")))
    .catch(() => ({ text: "" }))
    .then((value) => {
      scriptCache.set(key, { value, expiresAt: Date.now() + 1000 })
      scriptWarmCache.set(warmKey, { value, expiresAt: Date.now() + 5000 })
      return value
    })

  scriptCache.set(
    key,
    {
      value: cached?.value || (warmed && warmed.expiresAt > now ? warmed.value : { text: "" }),
      expiresAt: now + 1000,
      inflight,
    },
  )
  return inflight
}

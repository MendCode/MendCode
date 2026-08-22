import type { MendTuiProfile } from "../profile"
import { defaultActivityMascotConfig, type MendActivityMascotConfig } from "./mascot"

export type MendPresentationProfile = "raw" | "minimal" | "mendcode"
export type MendPresentationProfileInput = MendPresentationProfile | "full"
export type MendMessageRenderer = "plain" | "markdown" | "rich"
export type MendReasoningVisibility = "visible" | "collapsed" | "hidden"
export type MendActivityPlacement = "current" | "left-docked" | "footer"
export type MendActivityStyle = "raw" | "minimal" | "signal"
export type MendCompactionStyle = "minimal" | "cockpit" | "arcade" | "quiet"
export type MendCompactionArcade = "off" | "stars" | "snake" | "blocks" | (string & {})
export type MendActivityPhase =
  | "sending"
  | "thinking"
  | "searching"
  | "reading"
  | "running"
  | "editing"
  | "patching"
  | "installing"
  | "browsing"
  | "uploading"
  | "downloading"
  | "testing"
  | "subagents"
  | "planning"
  | "memory"
  | "compacting"
  | "awaiting-input"
  | "retrying"
  | "blocked"
  | "done"

export type MendActivityMessages = Partial<Record<MendActivityPhase, string[]>>

export type MendPresentationConfig = {
  profile: MendPresentationProfile
  message: {
    renderer: MendMessageRenderer
  }
  input: {
    pasteSummary: boolean
    pasteSummaryMinChars: number
  }
  reasoning: {
    defaultVisibility: MendReasoningVisibility
  }
  activity: {
    style: MendActivityStyle
    placement: MendActivityPlacement
    maxLines: number
    collapseOnComplete: boolean
    showModel: boolean
    showTokens: boolean
    showElapsed: boolean
    showInterruptHint: boolean
    messages: MendActivityMessages
    mascot: MendActivityMascotConfig
  }
  compaction: {
    style: MendCompactionStyle
    showProgress: boolean
    allowScratchpad: boolean
    arcade: MendCompactionArcade
  }
  symbols: {
    assistantDone: string
  }
}

const DEFAULT_PASTE_SUMMARY_MIN_CHARS = 3000

const inputConfig: MendPresentationConfig["input"] = {
  pasteSummary: true,
  pasteSummaryMinChars: DEFAULT_PASTE_SUMMARY_MIN_CHARS,
}

const activityMessages: MendActivityMessages = {
  sending: ["Generating..."],
  thinking: ["Thinking..."],
  searching: ["Searching..."],
  reading: ["Reading..."],
  running: ["Running command..."],
  editing: ["Editing..."],
  patching: ["Patching..."],
  installing: ["Installing..."],
  browsing: ["Browsing..."],
  uploading: ["Uploading..."],
  downloading: ["Downloading..."],
  testing: ["Testing..."],
  subagents: ["Waiting for subagents..."],
  planning: ["Planning..."],
  memory: ["Preparing memory..."],
  compacting: ["Compacting..."],
  "awaiting-input": ["Waiting for answer..."],
  retrying: ["Retrying..."],
  blocked: ["Waiting..."],
  done: ["Done"],
}

const neutralActivityConfig: MendPresentationConfig["activity"] = {
  style: "raw",
  placement: "current",
  maxLines: 1,
  collapseOnComplete: false,
  showModel: false,
  showTokens: true,
  showElapsed: true,
  showInterruptHint: true,
  messages: activityMessages,
  mascot: defaultActivityMascotConfig,
}

const cockpitCompactionConfig: MendPresentationConfig["compaction"] = {
  style: "cockpit",
  showProgress: true,
  allowScratchpad: true,
  arcade: "off",
}

const arcadeCompactionConfig: MendPresentationConfig["compaction"] = {
  style: "arcade",
  showProgress: true,
  allowScratchpad: true,
  arcade: "snake",
}

const minimalCompactionConfig: MendPresentationConfig["compaction"] = {
  style: "minimal",
  showProgress: false,
  allowScratchpad: false,
  arcade: "off",
}

const quietCompactionConfig: MendPresentationConfig["compaction"] = {
  style: "quiet",
  showProgress: false,
  allowScratchpad: false,
  arcade: "off",
}

export const defaultPresentationConfig: MendPresentationConfig = {
  profile: "mendcode",
  message: {
    renderer: "rich",
  },
  input: inputConfig,
  reasoning: {
    defaultVisibility: "collapsed",
  },
  activity: neutralActivityConfig,
  compaction: arcadeCompactionConfig,
  symbols: {
    assistantDone: "◈",
  },
}

const rawPresentationConfig: MendPresentationConfig = {
  profile: "raw",
  message: {
    renderer: "plain",
  },
  input: inputConfig,
  reasoning: {
    defaultVisibility: "visible",
  },
  activity: neutralActivityConfig,
  compaction: quietCompactionConfig,
  symbols: {
    assistantDone: "▣",
  },
}

const minimalPresentationConfig: MendPresentationConfig = {
  profile: "minimal",
  message: {
    renderer: "markdown",
  },
  input: inputConfig,
  reasoning: {
    defaultVisibility: "collapsed",
  },
  activity: neutralActivityConfig,
  compaction: minimalCompactionConfig,
  symbols: {
    assistantDone: "◈",
  },
}

const profileDefaults: Record<MendPresentationProfile, MendPresentationConfig> = {
  raw: rawPresentationConfig,
  minimal: minimalPresentationConfig,
  mendcode: defaultPresentationConfig,
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null
}

function asProfile(value: unknown): MendPresentationProfile {
  if (value === "raw" || value === "minimal" || value === "mendcode") return value
  if (value === "full") return "mendcode"
  return "mendcode"
}

export function presentationProfileTitle(profile: MendPresentationProfile) {
  if (profile === "raw") return "Raw"
  if (profile === "minimal") return "Minimal"
  return "Full"
}

export function messageRendererForPresentationProfile(profile: MendPresentationProfile): MendMessageRenderer {
  if (profile === "raw") return "plain"
  if (profile === "minimal") return "markdown"
  return "rich"
}

function asMessageRenderer(value: unknown, fallback: MendMessageRenderer): MendMessageRenderer {
  if (value === "plain" || value === "markdown" || value === "rich") return value
  return fallback
}

function asReasoningVisibility(value: unknown, fallback: MendReasoningVisibility): MendReasoningVisibility {
  if (value === "visible" || value === "collapsed" || value === "hidden") return value
  return fallback
}

function asPlacement(value: unknown, fallback: MendActivityPlacement): MendActivityPlacement {
  if (value === "current" || value === "left-docked" || value === "footer") return value
  return fallback
}

function asStyle(value: unknown, fallback: MendActivityStyle): MendActivityStyle {
  if (value === "raw" || value === "minimal" || value === "signal") return value
  return fallback
}

function asCompactionStyle(value: unknown, fallback: MendCompactionStyle): MendCompactionStyle {
  if (value === "minimal" || value === "cockpit" || value === "arcade" || value === "quiet") return value
  return fallback
}

function asCompactionArcade(value: unknown, fallback: MendCompactionArcade): MendCompactionArcade {
  if (value === "off" || value === "stars" || value === "snake" || value === "blocks") return value
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  return fallback
}

function asMessages(value: unknown, fallback: MendActivityMessages): MendActivityMessages {
  if (!isRecord(value)) return fallback
  const next: MendActivityMessages = { ...fallback }
  for (const [phase, messages] of Object.entries(value)) {
    if (!Array.isArray(messages)) continue
    if (!Object.prototype.hasOwnProperty.call(activityMessages, phase)) continue
    const clean = messages.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    if (clean.length) next[phase as MendActivityPhase] = clean
  }
  return next
}

function asMascot(value: unknown, fallback: MendActivityMascotConfig): MendActivityMascotConfig {
  if (!isRecord(value)) return fallback
  const rawStates = isRecord(value.states) ? value.states : {}
  const states: MendActivityMascotConfig["states"] = { ...fallback.states }
  for (const [phase, text] of Object.entries(rawStates)) {
    if (phase !== "idle" && phase !== "error" && !Object.prototype.hasOwnProperty.call(activityMessages, phase))
      continue
    if (typeof text === "string" && text.trim())
      states[phase as keyof MendActivityMascotConfig["states"]] = text.trimEnd()
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    hover: typeof value.hover === "string" && value.hover.trim() ? value.hover.trimEnd() : fallback.hover,
    states,
  }
}

export function resolveTuiPresentation(input: unknown): MendPresentationConfig {
  const raw = isRecord(input) ? input : {}
  const profile = asProfile(raw.profile)
  const defaults = profileDefaults[profile]
  const message = isRecord(raw.message) ? raw.message : {}
  const inputConfig = isRecord(raw.input) ? raw.input : {}
  const activity = isRecord(raw.activity) ? raw.activity : {}
  const compaction = isRecord(raw.compaction) ? raw.compaction : {}
  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : {}
  const symbols = isRecord(raw.symbols) ? raw.symbols : {}

  return {
    profile,
    message: {
      renderer: asMessageRenderer(message.renderer ?? raw.messageRenderer, defaults.message.renderer),
    },
    input: {
      pasteSummary:
        typeof inputConfig.pasteSummary === "boolean" ? inputConfig.pasteSummary : defaults.input.pasteSummary,
      pasteSummaryMinChars: Math.max(
        1,
        Number(inputConfig.pasteSummaryMinChars) || defaults.input.pasteSummaryMinChars,
      ),
    },
    reasoning: {
      defaultVisibility: asReasoningVisibility(reasoning.defaultVisibility, defaults.reasoning.defaultVisibility),
    },
    activity: {
      style: asStyle(activity.style, defaults.activity.style),
      placement: asPlacement(activity.placement, defaults.activity.placement),
      maxLines: Math.max(1, Math.min(4, Number(activity.maxLines) || defaults.activity.maxLines)),
      collapseOnComplete:
        typeof activity.collapseOnComplete === "boolean"
          ? activity.collapseOnComplete
          : defaults.activity.collapseOnComplete,
      showModel: typeof activity.showModel === "boolean" ? activity.showModel : defaults.activity.showModel,
      showTokens: typeof activity.showTokens === "boolean" ? activity.showTokens : defaults.activity.showTokens,
      showElapsed: typeof activity.showElapsed === "boolean" ? activity.showElapsed : defaults.activity.showElapsed,
      showInterruptHint:
        typeof activity.showInterruptHint === "boolean"
          ? activity.showInterruptHint
          : defaults.activity.showInterruptHint,
      messages: asMessages(activity.messages, defaults.activity.messages),
      mascot: asMascot(activity.mascot, defaults.activity.mascot),
    },
    compaction: {
      style: asCompactionStyle(compaction.style, defaults.compaction.style),
      showProgress:
        typeof compaction.showProgress === "boolean" ? compaction.showProgress : defaults.compaction.showProgress,
      allowScratchpad:
        typeof compaction.allowScratchpad === "boolean"
          ? compaction.allowScratchpad
          : defaults.compaction.allowScratchpad,
      arcade: asCompactionArcade(compaction.arcade, defaults.compaction.arcade),
    },
    symbols: {
      assistantDone:
        typeof symbols.assistantDone === "string" && symbols.assistantDone
          ? symbols.assistantDone
          : defaults.symbols.assistantDone,
    },
  }
}

export function presentationReasoningVisible(profile: MendTuiProfile) {
  return profile.presentation.reasoning.defaultVisibility === "visible"
}

export function shouldDisplayReasoning(profile: MendTuiProfile, input: { completed: boolean; showThinking?: boolean }) {
  if (profile.presentation.profile === "raw") return true
  if (profile.presentation.profile === "mendcode") {
    return profile.presentation.reasoning.defaultVisibility !== "hidden"
  }
  if (!presentationReasoningVisible(profile)) return false
  return input.completed && input.showThinking === true
}

export function reasoningSummary(text: string) {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null, body: content }
  return { title: match[1].trim(), body: content.slice(match[0].length).trimEnd() }
}

export function rawReasoningDisplay(text: string, input?: { fallbackTitle?: string | null }) {
  const body = text.trim()
  return {
    title: body ? null : (input?.fallbackTitle ?? null),
    body,
  }
}

export function reasoningPreview(text: string, maxChars = 1200, maxLines = 8) {
  const content = text.trim()
  if (!content) return { text: "", truncated: false }
  const lines = content.split(/\r?\n/)
  const bounded = lines.slice(0, maxLines).join("\n")
  if (bounded.length <= maxChars && lines.length <= maxLines) return { text: bounded, truncated: false }
  const clipped = bounded.slice(0, Math.max(0, maxChars - 1)).trimEnd()
  return { text: `${clipped}…`, truncated: true }
}

export function reasoningViewportMaxHeight(
  terminalHeight: number,
  input?: { min?: number; max?: number; ratio?: number },
) {
  const min = Math.max(1, Math.floor(input?.min ?? 4))
  const max = Math.max(min, Math.floor(input?.max ?? 14))
  const ratio = input?.ratio ?? 0.32
  return Math.max(min, Math.min(max, Math.floor(Math.max(1, terminalHeight) * ratio)))
}

export function reasoningViewportHeight(content: string, maxHeight: number) {
  const boundedMaxHeight = Math.max(1, Math.floor(maxHeight))
  const contentLines = content.split(/\r?\n/).length
  return Math.max(1, Math.min(boundedMaxHeight, contentLines))
}

export function shouldShowToolContinuation(input: { finish?: string; terminal: boolean; activeTool: boolean }) {
  if (input.terminal || !input.activeTool) return false
  return input.finish === "tool-calls" || input.finish === "unknown"
}

export function toolContinuationActivity(input: { status: string; tool?: string }) {
  const name = (input.tool ?? "").toLowerCase()
  if (name === "question" || name.includes("ask_user")) return "Waiting for answer..."
  if (name.includes("upload")) return "Uploading..."
  if (name.includes("download")) return "Downloading..."
  if (name.includes("web") || name.includes("fetch") || name.includes("browser") || name.includes("chrome"))
    return "Browsing..."
  if (name.includes("install") || name.includes("pnpm") || name.includes("npm") || name.includes("bun"))
    return "Installing..."
  if (name.includes("test") || name.includes("typecheck") || name.includes("lint") || name.includes("build"))
    return "Testing..."
  if (name.includes("patch") || name.includes("diff")) return "Patching..."
  if (name.includes("edit") || name.includes("write") || name.includes("update")) return "Editing..."
  if (name.includes("read") || name.includes("open") || name.includes("cat")) return "Reading..."
  if (name.includes("search") || name.includes("grep") || name.includes("glob") || name.includes("list"))
    return "Searching..."
  if (name.includes("plan") || name.includes("spec") || name.includes("review")) return "Planning..."
  if (name === "task" || name.includes("subagent")) return "Waiting for subagents..."
  if (name.includes("bash") || name.includes("shell") || name.includes("exec") || name.includes("command"))
    return "Running command..."
  if (input.status === "pending") return "Generating..."
  return "Thinking..."
}

export function unavailableReasoningLabel(input: { hasReadableContent: boolean; encrypted: boolean }) {
  if (input.hasReadableContent) return null
  return "reasoning unavailable"
}

export function activityMessagesForPhase(profile: MendTuiProfile, phase: MendActivityPhase) {
  const messages = profile.presentation.activity.messages[phase]
  if (messages?.length) return [messages[0]]
  const fallback = profile.workingIndicator.messages
  return fallback?.length ? [fallback[0]] : ["Thinking..."]
}

export function compactPreviewLine(text: string | undefined, max = 88) {
  if (!text) return
  const normalized = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
    .find(Boolean)
  if (!normalized) return
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…` : normalized
}

function cleanPreviewLine(line: string) {
  return line.replace(/^[-*#>\s]+/, "").trim()
}

function isOnlyCompactionHeading(line: string) {
  const clean = cleanPreviewLine(line)
    .replace(/[:.]+$/, "")
    .trim()
    .toLowerCase()
  return [
    "goal",
    "summary",
    "current user intent",
    "resume anchor",
    "active work",
    "optional follow-ups",
    "next steps",
  ].includes(clean)
}

export function compactionSummaryPreview(text: string | undefined, max = 88) {
  if (!text) return
  const normalized = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isOnlyCompactionHeading(line))
    .map(cleanPreviewLine)
    .find(Boolean)
  if (!normalized) return
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…` : normalized
}

export function compactionStageStates(input: {
  hasSummary?: boolean
  resume?: boolean
  include?: string
  tailStartID?: string
  postPrompt?: string
}) {
  const hasTail = Boolean(input.include || input.tailStartID)
  const shouldContinue = Boolean(input.resume || input.postPrompt)
  return [
    { label: "Capture transcript", state: "done" as const },
    { label: "Write memory", state: input.hasSummary ? ("done" as const) : ("active" as const) },
    {
      label: "Preserve tail",
      state: input.hasSummary ? (hasTail ? ("done" as const) : ("pending" as const)) : ("pending" as const),
    },
    {
      label: "Continue",
      state: input.hasSummary ? (shouldContinue ? ("done" as const) : ("pending" as const)) : ("pending" as const),
    },
  ]
}

export function compactionArcadeFrames(mode: MendCompactionArcade) {
  if (mode === "stars") return ["✦ · ˚ ✦ · ˚ ✦", "  ˚ ✦ ·  ✧ · ✦", "✧ · ✦ · ˚ · ✧"]
  if (mode === "snake") return []
  if (mode === "blocks") return ["blocks ▙▟  ▖  ▝", "blocks ▙▟ ▜▛   ", "blocks ▙▟ ▜▛ ▄ ", "blocks ▙▟ ▜▛ ▄▟"]
  return []
}

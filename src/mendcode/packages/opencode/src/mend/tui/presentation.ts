import type { MendTuiProfile } from "../profile"
import { defaultActivityMascotConfig, type MendActivityMascotConfig } from "./mascot"

export type MendPresentationProfile = "raw" | "minimal" | "mendcode"
export type MendPresentationProfileInput = MendPresentationProfile | "full"
export type MendMessageRenderer = "plain" | "markdown" | "rich"
export type MendReasoningVisibility = "visible" | "collapsed" | "hidden"
export type MendActivityPlacement = "current" | "left-docked" | "footer"
export type MendActivityStyle = "raw" | "minimal" | "signal"
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
  | "planning"
  | "memory"
  | "retrying"
  | "blocked"
  | "done"

export type MendActivityMessages = Partial<Record<MendActivityPhase, string[]>>

export type MendPresentationConfig = {
  profile: MendPresentationProfile
  message: {
    renderer: MendMessageRenderer
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
  symbols: {
    assistantDone: string
  }
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
  planning: ["Planning..."],
  memory: ["Preparing memory..."],
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

export const defaultPresentationConfig: MendPresentationConfig = {
  profile: "mendcode",
  message: {
    renderer: "rich",
  },
  reasoning: {
    defaultVisibility: "collapsed",
  },
  activity: neutralActivityConfig,
  symbols: {
    assistantDone: "◈",
  },
}

const rawPresentationConfig: MendPresentationConfig = {
  profile: "raw",
  message: {
    renderer: "plain",
  },
  reasoning: {
    defaultVisibility: "visible",
  },
  activity: neutralActivityConfig,
  symbols: {
    assistantDone: "▣",
  },
}

const minimalPresentationConfig: MendPresentationConfig = {
  profile: "minimal",
  message: {
    renderer: "markdown",
  },
  reasoning: {
    defaultVisibility: "collapsed",
  },
  activity: neutralActivityConfig,
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
    if (phase !== "idle" && phase !== "error" && !Object.prototype.hasOwnProperty.call(activityMessages, phase)) continue
    if (typeof text === "string" && text.trim()) states[phase as keyof MendActivityMascotConfig["states"]] = text.trimEnd()
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
  const activity = isRecord(raw.activity) ? raw.activity : {}
  const reasoning = isRecord(raw.reasoning) ? raw.reasoning : {}
  const symbols = isRecord(raw.symbols) ? raw.symbols : {}

  return {
    profile,
    message: {
      renderer: asMessageRenderer(message.renderer ?? raw.messageRenderer, defaults.message.renderer),
    },
    reasoning: {
      defaultVisibility: asReasoningVisibility(reasoning.defaultVisibility, defaults.reasoning.defaultVisibility),
    },
    activity: {
      style: asStyle(activity.style, defaults.activity.style),
      placement: asPlacement(activity.placement, defaults.activity.placement),
      maxLines: Math.max(1, Math.min(4, Number(activity.maxLines) || defaults.activity.maxLines)),
      collapseOnComplete:
        typeof activity.collapseOnComplete === "boolean" ? activity.collapseOnComplete : defaults.activity.collapseOnComplete,
      showModel: typeof activity.showModel === "boolean" ? activity.showModel : defaults.activity.showModel,
      showTokens: typeof activity.showTokens === "boolean" ? activity.showTokens : defaults.activity.showTokens,
      showElapsed: typeof activity.showElapsed === "boolean" ? activity.showElapsed : defaults.activity.showElapsed,
      showInterruptHint:
        typeof activity.showInterruptHint === "boolean" ? activity.showInterruptHint : defaults.activity.showInterruptHint,
      messages: asMessages(activity.messages, defaults.activity.messages),
      mascot: asMascot(activity.mascot, defaults.activity.mascot),
    },
    symbols: {
      assistantDone: typeof symbols.assistantDone === "string" && symbols.assistantDone ? symbols.assistantDone : defaults.symbols.assistantDone,
    },
  }
}

export function presentationReasoningVisible(profile: MendTuiProfile) {
  return profile.presentation.reasoning.defaultVisibility === "visible"
}

export function shouldDisplayReasoning(profile: MendTuiProfile, input: { completed: boolean; showThinking?: boolean }) {
  if (profile.presentation.profile === "raw") return true
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

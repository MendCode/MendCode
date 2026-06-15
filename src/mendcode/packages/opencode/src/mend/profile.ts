import path from "path"
import { fileURLToPath } from "url"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import { mendPaths } from "./config/paths"
import { defaultPromptChrome, normalizePromptChromePreset, type MendPromptChromeConfig } from "./tui/prompt-chrome"
import { defaultPromptStatus, type MendPromptStatusConfig } from "./tui/prompt-status"
import { defaultPresentationConfig, resolveTuiPresentation, type MendPresentationConfig } from "./tui/presentation"
import { activeMendPackageProjection } from "./runtime/packages"
import type { MendHomeLogoSize, MendLogoMode } from "./tui/mascot"
import type { MendWorkingIndicator } from "./tui/working-indicator"
import { Global } from "@mendcode/core/global"

export type MendHomeWelcomeRightPanel = "actions" | "agentManager"

export type MendTuiProfile = {
  version: 0
  profile: string
  promptChrome: MendPromptChromeConfig
  promptStatus: MendPromptStatusConfig
  workingIndicator: Omit<MendWorkingIndicator, "trust">
  presentation: MendPresentationConfig
  identity: {
    productName: string
    tagline: string
    logoMode?: MendLogoMode
    logoFont?: "classic" | "mendcode" | "opencode" | "small" | "standard" | "shadow"
  }
  theme: {
    mode: "dark" | "light"
    palette: string
    tokens: {
      accent: string
      background: string
      foreground: string
      muted: string
      border: string
      backgroundPanel?: string
    }
  }
  layout: {
    density: "compact" | "comfortable" | "spacious"
    spacing: "tight" | "normal" | "loose"
    borders: "none" | "single" | "rounded" | "heavy"
    width?: number
    zones: {
      sidebar: { enabled: boolean; compact: boolean; width: number }
      header: { enabled: boolean }
      footer: { enabled: boolean }
      session: Record<string, unknown>
      prompt: Record<string, unknown>
    }
  }
  widgets: {
    enabled: string[]
    order: string[]
    config: Record<string, { label?: string; value?: string; surface?: string }>
  }
  surfaces: {
    model: { visible: boolean; format: string }
    provider: { visible: boolean; format: string }
    status: { visible: boolean; mode: string }
    homeLogo?: { text?: string; size?: MendHomeLogoSize }
    homeWelcome?: { mode?: "centered" | "split"; rightPanel?: MendHomeWelcomeRightPanel }
  }
  rollback: {
    enabled: true
    lastAppliedProposal: string | null
    previousProfilePath: string | null
    updatedAt: string | null
  }
}

const fallbackProfile: MendTuiProfile = {
  version: 0,
  profile: "default",
  promptChrome: defaultPromptChrome(),
  promptStatus: defaultPromptStatus(),
  workingIndicator: {
    messages: ["Thinking..."],
    messageIntervalMs: 2500,
    visible: true,
    showElapsed: true,
    showTokenUsage: true,
  },
  presentation: defaultPresentationConfig,
  identity: {
    productName: "MendCode",
    tagline: "terminal-first coding",
    logoMode: "title",
    logoFont: "mendcode",
  },
  theme: {
    mode: "dark",
    palette: "mend-dark",
    tokens: {
      accent: "#22c55e",
      background: "#08110d",
      foreground: "#ffffff",
      muted: "#a3a3a3",
      border: "#2f2f2f",
      backgroundPanel: "#0b1f16",
    },
  },
  layout: {
    density: "comfortable",
    spacing: "normal",
    borders: "rounded",
    width: 88,
    zones: {
      sidebar: { enabled: false, compact: false, width: 0 },
      header: { enabled: true },
      footer: { enabled: true },
      session: { transcript: "main", metadata: "footer", stickyUserHeader: true, submitScrollMode: "bottom" },
      prompt: { position: "bottom", rightSurface: false },
    },
  },
  widgets: {
    enabled: ["focus", "budget", "worktree", "models", "status", "prompt-mode"],
    order: ["focus", "budget", "worktree", "models", "status", "prompt-mode"],
    config: {
      focus: { label: "Behavior", value: "Codex", surface: "footer" },
      budget: { label: "Budget", value: "guarded", surface: "footer" },
      worktree: { label: "Worktree", value: "dry-run", surface: "footer" },
      models: { label: "Provider", value: "auto", surface: "footer" },
      status: { label: "Status", value: "donor guarded", surface: "header" },
      "prompt-mode": { label: "Prompt", value: "focus", surface: "footer" },
    },
  },
  surfaces: {
    model: { visible: true, format: "provider/model" },
    provider: { visible: true, format: "provider" },
    status: { visible: true, mode: "guarded-runtime" },
    homeLogo: { size: "default" },
    homeWelcome: { mode: "centered", rightPanel: "agentManager" },
  },
  rollback: {
    enabled: true,
    lastAppliedProposal: null,
    previousProfilePath: null,
    updatedAt: null,
  },
}

export function defaultTuiProfile(): MendTuiProfile {
  return fallbackProfile
}

function ownRootFromModule() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "../../../../../..")
}

export function globalMendTuiProfilePath() {
  if (process.env.MENDCODE_TUI_PROFILE_PATH) return process.env.MENDCODE_TUI_PROFILE_PATH
  return path.join(Global.Path.config, "tui", "profile.json")
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null
}

function normalizeLogoFont(value: unknown): MendTuiProfile["identity"]["logoFont"] | undefined {
  if (value === "opencode") return "mendcode"
  if (value === "classic" || value === "mendcode" || value === "small" || value === "standard" || value === "shadow") {
    return value
  }
  return undefined
}

export function mergeMendTuiProfile(input: unknown): MendTuiProfile {
  if (!isRecord(input)) return fallbackProfile
  const identityInput = isRecord(input.identity) ? input.identity : {}
  const logoFont = normalizeLogoFont(identityInput.logoFont)
  const promptChromeInput = isRecord(input.promptChrome) ? input.promptChrome : {}
  return {
    ...fallbackProfile,
    ...input,
    promptChrome: {
      ...fallbackProfile.promptChrome,
      ...promptChromeInput,
      preset: normalizePromptChromePreset(promptChromeInput.preset ?? fallbackProfile.promptChrome.preset),
      glyphs: {
        ...(fallbackProfile.promptChrome.glyphs || {}),
        ...(isRecord(input.promptChrome) && isRecord(input.promptChrome.glyphs) ? input.promptChrome.glyphs : {}),
      },
    },
    promptStatus: {
      ...fallbackProfile.promptStatus,
      ...(isRecord(input.promptStatus) ? input.promptStatus : {}),
      context: {
        ...(fallbackProfile.promptStatus.context || {}),
        ...(isRecord(input.promptStatus) && isRecord(input.promptStatus.context) ? input.promptStatus.context : {}),
      },
      commandsHint: {
        ...(fallbackProfile.promptStatus.commandsHint || {}),
        ...(isRecord(input.promptStatus) && isRecord(input.promptStatus.commandsHint)
          ? input.promptStatus.commandsHint
          : {}),
      },
      placementByPreset: {
        ...(fallbackProfile.promptStatus.placementByPreset || {}),
        ...(isRecord(input.promptStatus) && isRecord(input.promptStatus.placementByPreset)
          ? input.promptStatus.placementByPreset
          : {}),
      },
      left:
        isRecord(input.promptStatus) && Array.isArray(input.promptStatus.left)
          ? input.promptStatus.left.filter((item): item is MendPromptStatusConfig["left"][number] => isRecord(item))
          : fallbackProfile.promptStatus.left,
      right:
        isRecord(input.promptStatus) && Array.isArray(input.promptStatus.right)
          ? input.promptStatus.right.filter((item): item is MendPromptStatusConfig["right"][number] => isRecord(item))
          : fallbackProfile.promptStatus.right,
      colors: {
        ...(fallbackProfile.promptStatus.colors || {}),
        ...(isRecord(input.promptStatus) && isRecord(input.promptStatus.colors) ? input.promptStatus.colors : {}),
      },
      scripts: {
        ...(fallbackProfile.promptStatus.scripts || {}),
        ...(isRecord(input.promptStatus) && isRecord(input.promptStatus.scripts) ? input.promptStatus.scripts : {}),
        left: {
          ...(fallbackProfile.promptStatus.scripts?.left || {}),
          ...(isRecord(input.promptStatus) &&
          isRecord(input.promptStatus.scripts) &&
          isRecord(input.promptStatus.scripts.left)
            ? input.promptStatus.scripts.left
            : {}),
        },
        right: {
          ...(fallbackProfile.promptStatus.scripts?.right || {}),
          ...(isRecord(input.promptStatus) &&
          isRecord(input.promptStatus.scripts) &&
          isRecord(input.promptStatus.scripts.right)
            ? input.promptStatus.scripts.right
            : {}),
        },
      },
      script: {
        ...(fallbackProfile.promptStatus.script || {}),
        ...(isRecord(input.promptStatus) && isRecord(input.promptStatus.script) ? input.promptStatus.script : {}),
      },
    },
    workingIndicator: {
      ...fallbackProfile.workingIndicator,
      ...(isRecord(input.workingIndicator) ? input.workingIndicator : {}),
      frames:
        isRecord(input.workingIndicator) && Array.isArray(input.workingIndicator.frames)
          ? input.workingIndicator.frames.filter((item): item is string => typeof item === "string")
          : fallbackProfile.workingIndicator.frames,
      messages:
        isRecord(input.workingIndicator) && Array.isArray(input.workingIndicator.messages)
          ? input.workingIndicator.messages.filter(
              (item): item is string => typeof item === "string" && item.trim().length > 0,
            )
          : fallbackProfile.workingIndicator.messages,
    },
    presentation: resolveTuiPresentation(
      isRecord(input.presentation) ? input.presentation : fallbackProfile.presentation,
    ),
    identity: {
      ...fallbackProfile.identity,
      ...identityInput,
      ...(logoFont ? { logoFont } : {}),
    },
    theme: {
      ...fallbackProfile.theme,
      ...(isRecord(input.theme) ? input.theme : {}),
      tokens: {
        ...fallbackProfile.theme.tokens,
        ...(isRecord(input.theme) && isRecord(input.theme.tokens) ? input.theme.tokens : {}),
      },
    },
    layout: {
      ...fallbackProfile.layout,
      ...(isRecord(input.layout) ? input.layout : {}),
      zones: {
        ...fallbackProfile.layout.zones,
        ...(isRecord(input.layout) && isRecord(input.layout.zones) ? input.layout.zones : {}),
        sidebar: {
          ...fallbackProfile.layout.zones.sidebar,
          ...(isRecord(input.layout) && isRecord(input.layout.zones) && isRecord(input.layout.zones.sidebar)
            ? input.layout.zones.sidebar
            : {}),
        },
        header: {
          ...fallbackProfile.layout.zones.header,
          ...(isRecord(input.layout) && isRecord(input.layout.zones) && isRecord(input.layout.zones.header)
            ? input.layout.zones.header
            : {}),
        },
        footer: {
          ...fallbackProfile.layout.zones.footer,
          ...(isRecord(input.layout) && isRecord(input.layout.zones) && isRecord(input.layout.zones.footer)
            ? input.layout.zones.footer
            : {}),
        },
        session: {
          ...fallbackProfile.layout.zones.session,
          ...(isRecord(input.layout) && isRecord(input.layout.zones) && isRecord(input.layout.zones.session)
            ? input.layout.zones.session
            : {}),
        },
        prompt: {
          ...fallbackProfile.layout.zones.prompt,
          ...(isRecord(input.layout) && isRecord(input.layout.zones) && isRecord(input.layout.zones.prompt)
            ? input.layout.zones.prompt
            : {}),
        },
      },
    },
    widgets: {
      ...fallbackProfile.widgets,
      ...(isRecord(input.widgets) ? input.widgets : {}),
      enabled:
        isRecord(input.widgets) && Array.isArray(input.widgets.enabled)
          ? input.widgets.enabled.filter((item): item is string => typeof item === "string")
          : fallbackProfile.widgets.enabled,
      order:
        isRecord(input.widgets) && Array.isArray(input.widgets.order)
          ? input.widgets.order.filter((item): item is string => typeof item === "string")
          : fallbackProfile.widgets.order,
      config: {
        ...fallbackProfile.widgets.config,
        ...(isRecord(input.widgets) && isRecord(input.widgets.config) ? input.widgets.config : {}),
      },
    },
    surfaces: {
      ...fallbackProfile.surfaces,
      ...(isRecord(input.surfaces) ? input.surfaces : {}),
      model: {
        ...fallbackProfile.surfaces.model,
        ...(isRecord(input.surfaces) && isRecord(input.surfaces.model) ? input.surfaces.model : {}),
      },
      provider: {
        ...fallbackProfile.surfaces.provider,
        ...(isRecord(input.surfaces) && isRecord(input.surfaces.provider) ? input.surfaces.provider : {}),
      },
      status: {
        ...fallbackProfile.surfaces.status,
        ...(isRecord(input.surfaces) && isRecord(input.surfaces.status) ? input.surfaces.status : {}),
      },
      homeLogo: {
        ...fallbackProfile.surfaces.homeLogo,
        ...(isRecord(input.surfaces) && isRecord(input.surfaces.homeLogo) ? input.surfaces.homeLogo : {}),
      },
      homeWelcome: {
        ...fallbackProfile.surfaces.homeWelcome,
        ...(isRecord(input.surfaces) && isRecord(input.surfaces.homeWelcome) ? input.surfaces.homeWelcome : {}),
      },
    },
    rollback: {
      ...fallbackProfile.rollback,
      ...(isRecord(input.rollback) ? input.rollback : {}),
      enabled: true,
    },
  }
}

export function validateMendTuiProfile(profile: MendTuiProfile) {
  const failures: string[] = []
  if (profile.version !== 0) failures.push("tui profile version must be 0")
  if (!profile.profile) failures.push("tui profile must include profile")
  if (!profile.identity.productName) failures.push("tui identity.productName is required")
  if (!["box", "top-bottom", "minimal", "ascii-box"].includes(profile.promptChrome.preset)) {
    failures.push("tui promptChrome.preset is invalid")
  }
  if (
    profile.promptChrome.borderStyle &&
    !["single", "rounded", "heavy", "ascii"].includes(profile.promptChrome.borderStyle)
  ) {
    failures.push("tui promptChrome.borderStyle is invalid")
  }
  if (profile.promptChrome.glyphs?.leadText !== undefined && typeof profile.promptChrome.glyphs.leadText !== "string") {
    failures.push("tui promptChrome.glyphs.leadText must be a string")
  }
  if (typeof profile.promptStatus.enabled !== "boolean") failures.push("tui promptStatus.enabled must be a boolean")
  if (profile.promptStatus.context !== undefined && !isRecord(profile.promptStatus.context)) {
    failures.push("tui promptStatus.context must be an object")
  }
  if (!Array.isArray(profile.promptStatus.left)) failures.push("tui promptStatus.left must be an array")
  if (!Array.isArray(profile.promptStatus.right)) failures.push("tui promptStatus.right must be an array")
  if (profile.promptStatus.separator !== undefined && typeof profile.promptStatus.separator !== "string") {
    failures.push("tui promptStatus.separator must be a string")
  }
  if (profile.promptStatus.colors !== undefined && !isRecord(profile.promptStatus.colors)) {
    failures.push("tui promptStatus.colors must be an object")
  }
  if (profile.promptStatus.scripts !== undefined && !isRecord(profile.promptStatus.scripts)) {
    failures.push("tui promptStatus.scripts must be an object")
  }
  if (!Array.isArray(profile.workingIndicator.messages)) failures.push("tui workingIndicator.messages must be an array")
  if (!["raw", "minimal", "mendcode"].includes(profile.presentation.profile))
    failures.push("tui presentation.profile is invalid")
  if (!["visible", "collapsed", "hidden"].includes(profile.presentation.reasoning.defaultVisibility)) {
    failures.push("tui presentation.reasoning.defaultVisibility is invalid")
  }
  if (!["raw", "minimal", "signal"].includes(profile.presentation.activity.style))
    failures.push("tui presentation.activity.style is invalid")
  if (!["current", "left-docked", "footer"].includes(profile.presentation.activity.placement))
    failures.push("tui presentation.activity.placement is invalid")
  if (profile.presentation.activity.maxLines < 1 || profile.presentation.activity.maxLines > 4) {
    failures.push("tui presentation.activity.maxLines must be between 1 and 4")
  }
  if (
    profile.workingIndicator.messageIntervalMs !== undefined &&
    (typeof profile.workingIndicator.messageIntervalMs !== "number" || profile.workingIndicator.messageIntervalMs < 250)
  ) {
    failures.push("tui workingIndicator.messageIntervalMs must be at least 250")
  }
  for (const token of ["accent", "background", "foreground", "muted", "border"] as const) {
    if (typeof profile.theme.tokens[token] !== "string") failures.push(`tui theme.tokens.${token} must be a string`)
  }
  if (!["compact", "comfortable", "spacious"].includes(profile.layout.density))
    failures.push("tui layout.density is invalid")
  if (!["tight", "normal", "loose"].includes(profile.layout.spacing)) failures.push("tui layout.spacing is invalid")
  const sessionZone = profile.layout.zones.session as { submitScrollMode?: unknown }
  if (
    sessionZone.submitScrollMode !== undefined &&
    sessionZone.submitScrollMode !== "bottom" &&
    sessionZone.submitScrollMode !== "clear"
  ) {
    failures.push("tui layout.zones.session.submitScrollMode is invalid")
  }
  if (
    profile.surfaces.homeLogo?.size !== undefined &&
    !["compact", "default", "large"].includes(profile.surfaces.homeLogo.size)
  ) {
    failures.push("tui surfaces.homeLogo.size is invalid")
  }
  if (
    profile.surfaces.homeWelcome?.mode !== undefined &&
    !["centered", "split"].includes(profile.surfaces.homeWelcome.mode)
  ) {
    failures.push("tui surfaces.homeWelcome.mode is invalid")
  }
  if (
    profile.surfaces.homeWelcome?.rightPanel !== undefined &&
    !["actions", "agentManager"].includes(profile.surfaces.homeWelcome.rightPanel)
  ) {
    failures.push("tui surfaces.homeWelcome.rightPanel is invalid")
  }
  if (!Array.isArray(profile.widgets.enabled)) failures.push("tui widgets.enabled must be an array")
  if (!Array.isArray(profile.widgets.order)) failures.push("tui widgets.order must be an array")
  const enabled = new Set(profile.widgets.enabled)
  for (const id of profile.widgets.order) {
    if (!enabled.has(id)) failures.push(`tui widgets.order includes disabled widget: ${id}`)
  }
  if (profile.rollback.enabled !== true) failures.push("tui rollback.enabled must remain true")
  return { ok: failures.length === 0, failures }
}

export async function loadMendTuiProfile(root = ownRootFromModule(), config?: unknown) {
  const requestedRoot = root
  const requestedDefaultPath = mendPaths(requestedRoot).tuiDefaultProfile
  const requestedActivePath = path.join(requestedRoot, ".mendcode", "tui", "profile.json")
  const globalActivePath = globalMendTuiProfilePath()
  const hasRequestedProfile =
    (await Filesystem.exists(requestedActivePath)) || (await Filesystem.exists(requestedDefaultPath))
  const profileRoot = hasRequestedProfile ? requestedRoot : ownRootFromModule()
  const defaultPath = mendPaths(profileRoot).tuiDefaultProfile
  const inheritedActivePath = path.join(profileRoot, ".mendcode", "tui", "profile.json")
  const activePath = (await Filesystem.exists(globalActivePath)) ? globalActivePath : inheritedActivePath
  const usingGlobalActiveProfile = activePath === globalActivePath
  const defaults = (await Filesystem.exists(defaultPath)) ? await Filesystem.readJson(defaultPath) : fallbackProfile
  const active = (await Filesystem.exists(activePath)) ? await Filesystem.readJson(activePath) : undefined
  const profile = mergeMendTuiProfile(defaults)
  let configured = await applyTuiConfigOverrides(
    mergeMendTuiProfile(active ? { ...profile, ...active } : profile),
    config,
    root,
  )
  if (usingGlobalActiveProfile && active) {
    configured = mergeMendTuiProfile({ ...configured, ...(active as object) })
  }
  if (isRecord(active) && isRecord(active.presentation)) {
    const profile = active.presentation.profile
    if (profile === "raw" || profile === "minimal" || profile === "mendcode") {
      const presentation: Record<string, unknown> = {
        ...configured.presentation,
        profile,
      }
      if (isRecord(active.presentation.reasoning)) presentation.reasoning = active.presentation.reasoning
      else delete presentation.reasoning
      configured.presentation = resolveTuiPresentation(presentation)
    }
  }
  const packageProjection = await activeMendPackageProjection(requestedRoot).catch(() => undefined)
  for (const pack of packageProjection?.runtimePacks || []) {
    if (!isRecord(pack.tui) || Object.keys(pack.tui).length === 0) continue
    configured = mergeMendTuiProfile({ ...configured, ...pack.tui })
  }
  if (profileRoot !== requestedRoot) {
    absolutizeInheritedPromptStatusScripts(configured, profileRoot)
  }
  return {
    root: requestedRoot,
    defaultPath,
    activePath,
    profile: configured,
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function absolutizeInheritedCommand(command: string | undefined, sourceRoot: string) {
  if (!command?.trim()) return command
  const match = command.trim().match(/^(\.\/\.mendcode\/\S+|\.mendcode\/\S+)(.*)$/)
  if (!match) return command
  const relative = match[1].replace(/^\.\//, "")
  return `${shellQuote(path.join(sourceRoot, relative))}${match[2] || ""}`
}

function absolutizeInheritedPromptStatusScripts(profile: MendTuiProfile, sourceRoot: string) {
  for (const side of ["left", "right"] as const) {
    const script = profile.promptStatus.scripts?.[side]
    if (script) script.command = absolutizeInheritedCommand(script.command, sourceRoot)
  }
  if (profile.promptStatus.script) {
    profile.promptStatus.script.command = absolutizeInheritedCommand(profile.promptStatus.script.command, sourceRoot)
  }
}

async function applyTuiConfigOverrides(
  profile: MendTuiProfile,
  config: unknown,
  root: string,
): Promise<MendTuiProfile> {
  if (!isRecord(config)) return profile
  const next = mergeMendTuiProfile(profile)

  if (isRecord(config.promptStatus)) {
    next.promptStatus = mergeMendTuiProfile({
      ...next,
      promptStatus: {
        ...next.promptStatus,
        ...config.promptStatus,
      },
    }).promptStatus
  }

  if (isRecord(config.identity)) {
    next.identity = mergeMendTuiProfile({
      ...next,
      identity: {
        ...next.identity,
        ...config.identity,
      },
    }).identity
  }

  if (isRecord(config.presentation)) {
    next.presentation = mergeMendTuiProfile({
      ...next,
      presentation: {
        ...next.presentation,
        ...config.presentation,
      },
    }).presentation
  }

  const homeLogo = isRecord(config.home) && isRecord(config.home.logo) ? config.home.logo : undefined
  const homeWelcome = isRecord(config.home) && isRecord(config.home.welcome) ? config.home.welcome : undefined

  const homeWelcomePatch: NonNullable<MendTuiProfile["surfaces"]["homeWelcome"]> = {}
  if (homeWelcome?.mode === "centered" || homeWelcome?.mode === "split") {
    homeWelcomePatch.mode = homeWelcome.mode
  }
  if (homeWelcome?.rightPanel === "actions" || homeWelcome?.rightPanel === "agentManager") {
    homeWelcomePatch.rightPanel = homeWelcome.rightPanel
  }
  if (Object.keys(homeWelcomePatch).length) {
    next.surfaces.homeWelcome = { ...(next.surfaces.homeWelcome || {}), ...homeWelcomePatch }
  }

  if (!homeLogo) return next

  if (homeLogo.mode === "title" || homeLogo.mode === "mascot") next.identity.logoMode = homeLogo.mode
  if (homeLogo.size === "compact" || homeLogo.size === "default" || homeLogo.size === "large") {
    next.surfaces.homeLogo = { ...(next.surfaces.homeLogo || {}), size: homeLogo.size }
  }

  const text = typeof homeLogo.text === "string" ? homeLogo.text : await readHomeLogoPath(homeLogo.path, root)
  if (text?.trim()) {
    next.identity.logoMode = "mascot"
    next.surfaces.homeLogo = { ...(next.surfaces.homeLogo || {}), text: text.trimEnd() }
  }

  return next
}

async function readHomeLogoPath(value: unknown, root: string) {
  if (typeof value !== "string" || !value.trim()) return undefined
  const expanded = value.startsWith("~/") ? path.join(process.env.HOME || "", value.slice(2)) : value
  const file = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded)
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

export function profileTheme(profile: MendTuiProfile) {
  const t = profile.theme.tokens
  return {
    theme: {
      primary: { dark: t.accent, light: t.accent },
      secondary: { dark: t.muted, light: t.muted },
      accent: { dark: t.accent, light: t.accent },
      error: { dark: "#ef4444", light: "#ef4444" },
      warning: { dark: "#f59e0b", light: "#f59e0b" },
      success: { dark: "#22c55e", light: "#22c55e" },
      info: { dark: "#38bdf8", light: "#38bdf8" },
      text: { dark: t.foreground, light: t.foreground },
      textMuted: { dark: t.muted, light: t.muted },
      background: { dark: t.background, light: t.background },
      backgroundPanel: { dark: t.backgroundPanel || "#0b1f16", light: t.backgroundPanel || "#0b1f16" },
      backgroundElement: { dark: t.backgroundPanel || "#0b1f16", light: t.backgroundPanel || "#0b1f16" },
      border: { dark: t.border, light: t.border },
      borderActive: { dark: t.accent, light: t.accent },
      borderSubtle: { dark: t.border, light: t.border },
      diffAdded: { dark: "#22c55e", light: "#22c55e" },
      diffRemoved: { dark: "#ef4444", light: "#ef4444" },
      diffContext: { dark: t.muted, light: t.muted },
      diffHunkHeader: { dark: t.accent, light: t.accent },
      diffHighlightAdded: { dark: "#22c55e", light: "#22c55e" },
      diffHighlightRemoved: { dark: "#ef4444", light: "#ef4444" },
      diffAddedBg: { dark: "#052e16", light: "#052e16" },
      diffRemovedBg: { dark: "#450a0a", light: "#450a0a" },
      diffContextBg: { dark: t.background, light: t.background },
    },
  }
}

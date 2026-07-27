import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { routeReturnTarget, useRoute, useRouteData, type SetupStepID } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { DialogProvider } from "@tui/component/dialog-provider"
import { providerDisplayName } from "@tui/util/provider-origin"
import { useLocal } from "@tui/context/local"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { useMendTuiProfile } from "@tui/context/mend"
import { setupReadiness, providerAuthStatus } from "@/mend/runtime/readiness"
import { budgetStatus, writeBudgetPolicy } from "@/mend/runtime/budget"
import {
  modelPresets,
  readModelsConfig,
  refreshGeneratedRuntimeModelConfig,
  resolveModelRoles,
  writeGlobalModelsConfig,
  writeModelsConfig,
  type ModelRole,
} from "@/mend/config/models"
import { readPromptMode, writePromptMode, type MendPromptMode } from "@/mend/prompt/mode"
import { composePromptPolicy } from "@/mend/prompt/compose"
import { memoryStatus } from "@/mend/memory/store"
import { writeGlobalMemoryConfig } from "@/mend/memory/config"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "@/mend/config/permissions"
import { packageMetadata, packageMetadataSet, syncGlobalPrimaryAgentModels, syncProject } from "@/mend/config/project"
import { applyRuntimePack } from "@/mend/runtime/pack"
import { disableAllMendPackages, listMendPackages, removeMendPackage, setMendPackageEnabled } from "@/mend/runtime/packages"
import {
  runtimeRegistryAdd,
  runtimeRegistryApplySource,
  runtimeRegistryInstallPack,
  runtimeRegistryList,
  runtimeRegistryRemove,
  runtimeRegistrySearch,
} from "@/mend/runtime/registry"
import type { RegistryMarketplacePackManifest } from "@/mend/runtime/registry/marketplace"
import { mendTuiCapabilityVersion, visibleCustomizationCapabilities } from "@/mend/tui/capabilities"
import { listActiveCustomizations } from "@/mend/tui/customization-state"
import { applyTuiPreset, readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import { defaultTuiProfile } from "@/mend/profile"
import type { MendPromptChromePreset } from "@/mend/tui/prompt-chrome"
import { CommandDeck } from "@tui/component/command-deck"
import {
  dismissSetup,
  isSetupComplete,
  markSetupStepComplete,
  openSetupState,
  setSetupCurrentStep,
  requiredSetupSteps,
  setupSteps,
} from "@/mend/setup/state"
import { SetupRail } from "./setup-rail"
import { SetupActionBar } from "./action-bar"

const baseModelRoleOrder = [
  "default",
  "build",
  "plan",
  "subagent",
  "small",
  "title",
  "compaction",
  "summary",
  "memoryExtractor",
  "memoryDream",
  "memoryAssistant",
  "permissionReviewer",
] as const
type SetupModelRole = string
const primaryModelRoles = ["default", "build", "plan"] as const
const internalModelRoles = ["subagent", "small", "title", "compaction", "summary", "memoryExtractor", "memoryDream", "memoryAssistant", "permissionReviewer"] as const
const promptModes: MendPromptMode[] = ["minimal", "focus", "full"]
const promptModeDetails: Record<MendPromptMode, { summary: string; runtime: string; adds: string }> = {
  minimal: {
    summary: "fresh extensible base",
    runtime:
      "Keeps core tools, environment, project instructions, custom system input, and MCP tools; skills are not advertised by default.",
    adds: "minimal MendCode boundary with evidence and secret-safety rules",
  },
  focus: {
    summary: "harness-focused prompt",
    runtime: "Loads normal skills and project instructions.",
    adds: "minimal plus the MendCode-owned official/adapted harness prompt when available",
  },
  full: {
    summary: "MendCode-aware prompt",
    runtime: "Loads normal skills and project instructions.",
    adds: "focus plus MendCode runtime knowledge; Mflow/TSM only when configured active or relevant",
  },
}

export type SetupPresetID = "default" | "minimal" | "full" | "custom"

export const setupPresetDetails: Record<SetupPresetID, { title: string; summary: string; changes: string; safety: string }> = {
  default: {
    title: "Use current defaults",
    summary: "Keep provider, models, and existing settings unchanged.",
    changes: "No optional feature is enabled by this choice; configure only what you need below.",
    safety: "Safest when you are upgrading or already have a working config.",
  },
  minimal: {
    title: "Minimal MendCode",
    summary: "Quiet prompt, compact TUI, memory and extra presentation features off.",
    changes: "Sets minimal prompt context, compact layout, hidden optional surfaces, memory off, and approval permissions.",
    safety: "Provider and model settings are preserved; no packages or credentials are removed.",
  },
  full: {
    title: "Full MendCode",
    summary: "Use the complete TUI and MendCode context with guarded memory learning.",
    changes: "Sets full prompt context, spacious TUI, visible runtime surfaces, memory retrieval and approval-gated proposals.",
    safety: "Memory writes remain approval-gated; provider and model settings are preserved.",
  },
  custom: {
    title: "Configure manually",
    summary: "Skip presets and walk through every setup step yourself.",
    changes: "Does not write settings; it only opens the provider step.",
    safety: "Best for mixed providers, custom role routing, or an existing team policy.",
  },
}

export const setupPresetList = (Object.entries(setupPresetDetails) as Array<[
  SetupPresetID,
  (typeof setupPresetDetails)[SetupPresetID],
]>).map(([id, detail]) => ({ id, ...detail }))
const roleDescriptions: Record<string, string> = {
  default: "Fallback chat model and generated config model.",
  build: "Model used when the TUI is in build mode.",
  plan: "Model used when the TUI is in plan mode.",
  subagent: "Default model for new background subagent task sessions. Individual agent configs can still override it.",
  small: "Runtime small-model fallback for title generation and lightweight internal work.",
  title: "Hidden runtime agent that generates conversation titles.",
  compaction: "Hidden runtime agent that compacts long context.",
  summary: "Hidden runtime summary agent for session summary metadata.",
  memoryExtractor:
    "Background model that reviews completed turns and proposes only durable memories worth approval.",
  memoryDream:
    "Background model for manual/scheduled memory maintenance that writes reviewable proposals only.",
  memoryAssistant:
    "Memory assistant for supported integrations that answers memory questions and drafts reviewable proposals only.",
  permissionReviewer:
    "Hidden permission reviewer model that quickly checks risky shell permission prompts in Smart Approval.",
}
const roleLabels: Record<string, string> = {
  default: "Default chat",
  build: "Build",
  plan: "Plan",
  subagent: "Subagents",
  small: "Small/cheap",
  title: "Chat titles",
  compaction: "Context compaction",
  summary: "Session summaries",
  memoryExtractor: "Memory extractor",
  memoryDream: "Memory Dream",
  memoryAssistant: "Memory side chat",
  permissionReviewer: "Permission reviewer",
}

function roleLabel(role: string) {
  return roleLabels[role] || role
}

function roleCategory(role: string) {
  if (role === "default") return "Required"
  if ((primaryModelRoles as readonly string[]).includes(role)) return "Primary roles"
  if ((internalModelRoles as readonly string[]).includes(role)) return "Background helpers"
  return "Skill roles"
}

const surfacedCustomizationCapabilities = visibleCustomizationCapabilities()
const setupVisibleCapabilities = surfacedCustomizationCapabilities.filter((item) =>
  item.entrypoints.some((entry) => entry === "setup"),
)
function modelLabel(role?: ModelRole) {
  if (!role?.providerID || !role.modelID) return "not set"
  const base = `${role.providerID}/${role.modelID}`
  return role.variant ? `${base} · ${role.variant}` : base
}

function approxPromptTokens(bytes?: number) {
  if (typeof bytes !== "number") return "measuring"
  return `~${Math.ceil(bytes / 4)} tokens`
}

export function truncateSetupText(value: string, max = 88) {
  const limit = Math.max(4, max)
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

export function setupLabelValueLine(label: string, value: string, max = 88) {
  return truncateSetupText(`${label}: ${value}`, max)
}

export function setupExtractorAuthMessage(value: string) {
  if (value.includes("OAuth token expired")) {
    return "OAuth expired; re-auth OpenAI or set MENDCODE_OPENAI_OAUTH_CLIENT_ID/OPENAI_OAUTH_CLIENT_ID."
  }
  return value
}

export function setupProviderAuthMessage(value: string) {
  if (value.includes("OAuth token expired")) {
    return "OAuth expired; re-auth OpenAI or set MENDCODE_OPENAI_OAUTH_CLIENT_ID/OPENAI_OAUTH_CLIENT_ID so MendCode can refresh it."
  }
  if (value.includes("missing env:OPENAI_API_KEY")) {
    return "No OPENAI_API_KEY is visible to this MendCode runtime."
  }
  if (value.includes("missing usable OpenAI auth state")) {
    return "OpenAI needs usable OAuth or API key auth before background helpers can run."
  }
  return value
}

export function setupMemoryLearningStatus(input: {
  generate?: boolean
  outputCallsProviders?: boolean
  auth?: { providerID?: string | null; mendRunReady?: boolean; oauthExpired?: boolean; oauthRefreshReady?: boolean } | null
  connectedProviderIDs?: readonly string[]
}) {
  if (!input.generate) return "off"
  if (!input.outputCallsProviders) return "no extractor"
  const auth = input.auth
  if (!auth) return "no model"
  if (auth.mendRunReady || (auth.providerID && input.connectedProviderIDs?.includes(auth.providerID))) return "ready"
  if (auth.oauthExpired && !auth.oauthRefreshReady) return "oauth expired"
  return "auth blocked"
}

export function setupShouldShowExtractorAuthBlocker(input: {
  generate?: boolean
  auth?: { providerID?: string | null; blockers?: unknown[]; mendRunReady?: boolean } | null
  connectedProviderIDs?: readonly string[]
}) {
  const auth = input.auth
  if (!input.generate || !auth?.blockers?.length) return false
  if (auth.mendRunReady) return false
  return !(auth.providerID && input.connectedProviderIDs?.includes(auth.providerID))
}

export function setupMemoryDialogCurrentValue(memory?: { enabled?: boolean; generate?: boolean } | null) {
  if (memory?.generate) return "generate"
  return memory?.enabled ? "enable-use" : "disable"
}

export function setupShouldChooseHomeSplitPanel(welcomeMode: "centered" | "split") {
  return welcomeMode === "split"
}

function normalizeProductName(value: string) {
  return value.trim() || "MendCode"
}

function registrySourceIDFromURL(value: string) {
  const clean = value.trim().replace(/\.git$/, "")
  const last = clean.split(/[/:]/).filter(Boolean).at(-1) || "package-source"
  const slug = last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return `url-${slug || "package-source"}`.slice(0, 64)
}

export function isPublicGitHubURL(value: string) {
  try {
    const url = new URL(value.trim())
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.split("/").filter(Boolean).length === 2
    )
  } catch {
    return false
  }
}

function setupMarketplaceRuntimeSummary(pack: RegistryMarketplacePackManifest) {
  const runtime = pack.runtime || {}
  return [
    ["commands", runtime.commands],
    ["agents", runtime.agents],
    ["skills", runtime.skills],
    ["plugins", runtime.plugins],
    ["pages", runtime.pages],
    ["widgets", runtime.widgets],
    ["MCP", runtime.mcpFiles],
  ]
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ") || "No runtime artifacts advertised"
}

function setupMarketplaceBadgeTitle(title: string, badge?: string | null) {
  return `${badge ? `[${badge}] ` : ""}${title}`
}

function setupMarketplaceCategory(input: { badge?: string | null; channel?: string | null; sourceID?: string | null }) {
  const state = input.badge === "active" ? "Active" : input.badge === "installed" ? "Installed" : undefined
  return [state, input.channel || input.sourceID].filter(Boolean).join(" · ") || "Packages"
}

function setupMarketplaceSearchText(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" ")
}

function setupMarketplaceInstallPreview(input: {
  pack: RegistryMarketplacePackManifest
  sourceID: string
  sourceURL?: string | null
  sourceType?: string
  fetchesNetwork?: boolean
  digest?: { algorithm: "sha256"; value: string }
}) {
  return [
    `Source: ${input.sourceURL || input.sourceID}`,
    `Source id: ${input.sourceID}`,
    `Source type: ${input.sourceType || input.pack.source?.type || "unknown"}`,
    `Package: ${input.pack.id}@${input.pack.version}`,
    `Runtime: ${setupMarketplaceRuntimeSummary(input.pack)}`,
    `Fetches network: ${input.fetchesNetwork ? "yes" : "no"}`,
    `Digest: ${input.digest ? `${input.digest.algorithm}:${input.digest.value.slice(0, 12)}...` : input.pack.digest ? `${input.pack.digest.algorithm}:${input.pack.digest.value.slice(0, 12)}...` : "not pinned"}`,
    `Signature: ${input.pack.signature ? `${input.pack.signature.algorithm}:${input.pack.signature.value.slice(0, 12)}...` : "not signed"}`,
    "",
    "Review before install:",
    "- Trust only repos you expect to run MendCode package content from.",
    "- Packages may add commands, skills, plugins, widgets, pages, scripts, and MCP config.",
    "- MendCode copies allowlisted package files only; local sessions, auth, runs, cache, and customizations stay untouched.",
  ].join("\n")
}

function presetRole(preset: (typeof modelPresets)[keyof typeof modelPresets]): ModelRole {
  return { providerID: preset.providerID, modelID: preset.modelID, authMode: preset.authMode }
}

export function inferModelPresetAuthMode(providerID: string, modelID: string) {
  const matches = [...new Set(
    Object.values(modelPresets)
      .filter((preset) => preset.providerID === providerID && preset.modelID === modelID && preset.authMode)
      .map((preset) => preset.authMode),
  )]
  if (matches.length !== 1) return null
  return matches[0]
}

function parseOptionalUsd(value: string | null, label: string) {
  const text = value?.trim().toLowerCase()
  if (!text || ["none", "no limit", "unlimited", "sin limite", "sin límite"].includes(text)) return null
  const normalized = text.replace(/^\$/, "")
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${label} must be a positive USD number, blank, or "unlimited"`)
  return parsed
}

export function Setup() {
  const route = useRoute()
  const data = useRouteData("setup")
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const mend = useMendTuiProfile()
  const sync = useSync()
  const local = useLocal()
  const initialStep = data.step && setupSteps.includes(data.step) ? data.step : "start"
  const [selected, setSelected] = createSignal<SetupStepID>(initialStep)
  const [refresh, setRefresh] = createSignal(0)
  const reload = () => setRefresh((value) => value + 1)

  const [summary] = createResource(refresh, async () => {
    const root = mend.root
    const state = await openSetupState(selected(), root)
    const [setup, auth, models, modelsConfig, budget, prompt, promptPolicies, pkg, packages, permissions] = await Promise.all(
      [
        setupReadiness(root),
        providerAuthStatus(null, null, {}, root),
        resolveModelRoles(root),
        readModelsConfig(root),
        budgetStatus(root),
        readPromptMode(root),
        Promise.all(
          promptModes.map(async (mode) => [mode, await composePromptPolicy({ root, mode, focusID: "codex" })] as const),
        ).then((entries) => Object.fromEntries(entries)),
        Promise.resolve(packageMetadata(root)),
        listMendPackages(root),
        readPermissionsConfig(),
      ],
    )
    const memory = await memoryStatus(root)
    const memoryExtractorRole = (models.roles as Record<string, any>)[memory.extractorRole || "memoryExtractor"]
    const memoryExtractorAuth = memoryExtractorRole?.providerID
      ? await providerAuthStatus(
        memoryExtractorRole.providerID,
        memoryExtractorRole.modelID,
        { authMode: memoryExtractorRole.authMode, skipNext: true },
        root,
      )
      : null
    return { state, setup, auth, models, modelsConfig, budget, prompt, promptPolicies, pkg, packages, memory, memoryExtractorAuth, permissions }
  })

  const setupSummary = createMemo(() => summary.latest ?? summary())
  const narrow = createMemo(() => dimensions().width < 110)
  const compact = createMemo(() => dimensions().width < 72)
  const current = createMemo(() => setupSummary()?.state.currentStep || selected())
  const active = createMemo(() => selected() || current())
  const complete = createMemo(() => {
    const state = setupSummary()?.state
    return state ? isSetupComplete(state) : false
  })
  const requiredProgress = createMemo(() => {
    const state = setupSummary()?.state
    return requiredSetupSteps.filter((step) => state?.completedSteps.includes(step)).length
  })
  const promptPanelWidth = createMemo(() => Math.max(20, dimensions().width - (compact() ? 4 : narrow() ? 12 : 44)))
  const connectedProviderIDs = createMemo(() => sync.data.provider_next.connected)
  const connectedProviderNames = createMemo(() =>
    connectedProviderIDs().map(
      (providerID) => {
        const provider = sync.data.provider.find((provider) => provider.id === providerID)
        return provider ? providerDisplayName(provider) : providerID
      },
    ),
  )

  const move = (direction: number) => {
    const index = setupSteps.indexOf(active())
    const next = setupSteps[(index + direction + setupSteps.length) % setupSteps.length]
    setSelected(next)
    void setSetupCurrentStep(next, mend.root).then(reload)
  }

  const exitSetup = async () => {
    const state = setupSummary()?.state
    if (state?.completedOnce || complete()) {
      route.navigate(routeReturnTarget(route.data))
      return
    }
    const leave = await DialogConfirm.show(
      dialog,
      "Continue in minimal mode?",
      "Setup is incomplete. You can explore MendCode, but provider/model/budget/prompt setup will stay visible until completed.",
      "continue setup",
    )
    if (!leave) return
    await dismissSetup(mend.root)
    route.navigate(routeReturnTarget(route.data))
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      move(-1)
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      move(1)
    }
    if (evt.name === "return") {
      evt.preventDefault()
      void runPrimaryAction(active())
    }
    if (evt.name === "escape") {
      evt.preventDefault()
      void exitSetup()
    }
  })

  const mark = async (step: SetupStepID) => {
    await markSetupStepComplete(step, mend.root)
    reload()
  }

  const chooseProvider = async () => {
    dialog.replace(() => <DialogProvider postAuth="close" onAuthReady={reload} />)
  }

  const applySetupTuiPreset = async (preset: "minimal" | "full") => {
    const applied = await applyTuiPreset(preset === "minimal" ? "compact" : "spacious", mend.root)
    const current = applied.profile
    const defaults = defaultTuiProfile()
    if (preset === "minimal") {
      await writeActiveTuiProfile({
        ...current,
        profile: "minimal-runtime",
        promptChrome: { ...current.promptChrome, preset: "minimal" },
        presentation: {
          ...current.presentation,
          profile: "minimal",
          message: { ...current.presentation.message, renderer: "markdown" },
          reasoning: { ...current.presentation.reasoning, defaultVisibility: "collapsed" },
          activity: {
            ...current.presentation.activity,
            style: "minimal",
            placement: "footer",
            maxLines: 1,
            showModel: false,
            showTokens: false,
            showElapsed: false,
            showInterruptHint: false,
          },
          compaction: {
            ...current.presentation.compaction,
            style: "minimal",
            showProgress: false,
            allowScratchpad: false,
            arcade: "off",
          },
        },
        layout: {
          ...current.layout,
          density: "compact",
          spacing: "tight",
          zones: {
            ...current.layout.zones,
            sidebar: { ...current.layout.zones.sidebar, enabled: false, compact: true, width: 0 },
            header: { ...current.layout.zones.header, enabled: false },
            footer: { ...current.layout.zones.footer, enabled: false },
            prompt: { ...current.layout.zones.prompt, rightSurface: false },
          },
        },
        widgets: { ...current.widgets, enabled: ["focus"], order: ["focus"] },
        surfaces: {
          ...current.surfaces,
          model: { ...current.surfaces.model, visible: false },
          provider: { ...current.surfaces.provider, visible: false },
          status: { ...current.surfaces.status, visible: false },
        },
      }, mend.root)
      return
    }

    await writeActiveTuiProfile({
      ...current,
      profile: "full-runtime",
      promptChrome: { ...current.promptChrome, preset: "box" },
      presentation: {
        ...defaults.presentation,
        activity: {
          ...defaults.presentation.activity,
          showModel: true,
          showTokens: true,
          showElapsed: true,
          showInterruptHint: true,
        },
        compaction: { ...defaults.presentation.compaction, style: "cockpit", showProgress: true, allowScratchpad: true },
      },
      layout: {
        ...current.layout,
        density: "spacious",
        spacing: "loose",
        zones: {
          ...current.layout.zones,
          sidebar: { ...current.layout.zones.sidebar, enabled: true, compact: false, width: 28 },
          header: { ...current.layout.zones.header, enabled: true },
          footer: { ...current.layout.zones.footer, enabled: true },
          prompt: { ...current.layout.zones.prompt, rightSurface: true },
        },
      },
      widgets: { ...defaults.widgets, config: { ...current.widgets.config, ...defaults.widgets.config } },
      surfaces: { ...defaults.surfaces },
    }, mend.root)
  }

  const applyStandaloneTuiPreset = async (preset: "minimal" | "full") => {
    try {
      await applySetupTuiPreset(preset)
      await mend.reload()
      await mark("tui")
      reload()
      toast.show({ variant: "success", message: `${preset === "minimal" ? "Minimal" : "Full"} TUI profile applied.`, duration: 4000 })
    } catch (error) {
      toast.show({ variant: "error", message: error instanceof Error ? error.message : "TUI profile preset failed.", duration: 6000 })
    }
  }

  const applySetupPreset = async (preset: SetupPresetID) => {
    try {
      if (preset === "minimal") {
        await writePromptMode("minimal", mend.root)
        await writeGlobalMemoryConfig({ enabled: false, use: false, generate: false }, mend.root)
        await writePermissionsConfig({ mode: "approval" })
        await applySetupTuiPreset("minimal")
      }
      if (preset === "full") {
        await writePromptMode("full", mend.root)
        await writeGlobalMemoryConfig({ enabled: true, use: true, generate: true, requireApprovalForGenerated: true }, mend.root)
        await writePermissionsConfig({ mode: "approval" })
        await applySetupTuiPreset("full")
      }
      if (preset === "minimal" || preset === "full") await mend.reload()
      await mark("start")
      const next: SetupStepID = "provider"
      setSelected(next)
      await setSetupCurrentStep(next, mend.root)
      reload()
      dialog.clear()
      toast.show({ variant: "success", message: `${setupPresetDetails[preset].title} selected.`, duration: 4000 })
    } catch (error) {
      toast.show({ variant: "error", message: error instanceof Error ? error.message : "Setup preset failed.", duration: 6000 })
    }
  }

  const chooseSetupPreset = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Setup starting point"
        current={setupSummary()?.state.completedSteps.includes("start") ? "default" : undefined}
        options={setupPresetList.map((preset) => ({
          title: preset.title,
          value: preset.id,
          category: "Setup presets",
          description: `${preset.summary} ${preset.safety}`,
          onSelect: () => applySetupPreset(preset.id),
        }))}
      />
    ))
  }

  const setupModelRoles = createMemo<SetupModelRole[]>(() => {
    const agentRoles = sync.data.agent
      .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
      .map((agent) => agent.name)
      .filter((name) => name !== "default" && name !== "review")
    return [...new Set([...baseModelRoleOrder, ...agentRoles])]
  })

  const saveModelRole = async (roleName: SetupModelRole, role: ModelRole) => {
    const config = await readModelsConfig(mend.root)
    config.enabled = true
    config.roles[roleName] = role
    if (roleName === "build") config.roles.code = role
    if (roleName === "default" && role.providerID && role.modelID) {
      if (!config.roles.plan?.providerID || !config.roles.plan.modelID) config.roles.plan = { ...role }
      if (!config.roles.build?.providerID || !config.roles.build.modelID) config.roles.build = { ...role }
      if (!config.roles.code?.providerID || !config.roles.code.modelID) config.roles.code = { ...role }
    }
    await writeGlobalModelsConfig(config)
    await syncGlobalPrimaryAgentModels(mend.root)
    await refreshGeneratedRuntimeModelConfig(mend.root)
    const latest = await readModelsConfig(mend.root)
    if (latest.roles.default?.providerID && latest.roles.default.modelID) await mark("models")
    else reload()
    dialog.clear()
    const saved = modelLabel(role)
    toast.show({ variant: "success", message: `Updated global ${roleName}: ${saved}.`, duration: 4000 })
  }

  const inferAuthMode = (providerID: string, modelID: string) => {
    const currentAuth = setupSummary()?.auth as any
    if (currentAuth?.providerID === providerID && typeof currentAuth.authMode === "string") return currentAuth.authMode
    return inferModelPresetAuthMode(providerID, modelID)
  }

  const saveModelRoleWithVariant = async (roleName: SetupModelRole, role: ModelRole) => {
    const provider = sync.data.provider.find((item) => item.id === role.providerID)
    const model = role.modelID ? provider?.models[role.modelID] : undefined
    const variants = model?.variants ? Object.keys(model.variants) : []
    if (!variants.length) return saveModelRole(roleName, role)
    dialog.replace(() => (
      <DialogSelect
        title={`Variant: ${roleName}`}
        current={role.variant ?? "default"}
        options={[
          {
            title: "Default",
            value: "default",
            category: "Variant",
            description: "Use the provider default model effort variant.",
            onSelect: async () => saveModelRole(roleName, { ...role, variant: null }),
          },
          ...variants.map((variant) => ({
            title: variant,
            value: variant,
            category: "Variant",
            description: "Persist this model effort variant for the selected role.",
            onSelect: async () => saveModelRole(roleName, { ...role, variant }),
          })),
        ]}
      />
    ))
  }

  const chooseModelRole = (roleName: SetupModelRole) => {
    const options: Array<{
      title: string
      value: unknown
      category: string
      description: string
      footer?: string
      disabled?: boolean
      onSelect: () => Promise<void>
    }> = []

    for (const provider of sync.data.provider.toSorted((a, b) =>
      providerDisplayName(a).localeCompare(providerDisplayName(b)),
    )) {
      for (const [modelID, model] of Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))) {
        if (model.status === "deprecated") continue
        options.push({
          title: model.name ?? modelID,
          value: { providerID: provider.id, modelID },
          category: providerDisplayName(provider),
          description: provider.id,
          onSelect: async () => {
            await saveModelRoleWithVariant(roleName, {
              providerID: provider.id,
              modelID,
              authMode: inferAuthMode(provider.id, modelID),
            })
          },
        })
      }
    }

    for (const [id, preset] of Object.entries(modelPresets)) {
      const alreadyListed = options.some((option) => {
        const value = option.value as { providerID?: string; modelID?: string }
        return value.providerID === preset.providerID && value.modelID === preset.modelID
      })
      if (alreadyListed) continue
      options.push({
        title: `${preset.providerID}/${preset.modelID}`,
        value: id,
        category: "Pinned presets",
        description: preset.note,
        onSelect: async () => {
          await saveModelRoleWithVariant(roleName, presetRole(preset))
        },
      })
    }

    if (roleName !== "default") {
      options.push({
        title: "Use default model for this role",
        value: "skip",
        category: "Role fallback",
        description: "Projection falls back to default.",
        onSelect: async () => {
          await saveModelRole(roleName, {
            providerID: null,
            modelID: null,
            reason: "Skipped during setup; use default runtime fallback.",
          })
        },
      })
    }
    dialog.replace(() => <DialogSelect title={`Model role: ${roleName}`} options={options} />)
  }

  const applyProviderModelPreset = async (providerID: string, modelID: string) => {
    const config = await readModelsConfig(mend.root)
    const role = { providerID, modelID, authMode: inferAuthMode(providerID, modelID) }
    config.enabled = true
    for (const name of ["default", "build", "code", "plan", "subagent"]) config.roles[name] = { ...role }
    if (!config.roles.small?.providerID || !config.roles.small.modelID) config.roles.small = { ...role }
    await writeGlobalModelsConfig(config)
    await syncGlobalPrimaryAgentModels(mend.root)
    await refreshGeneratedRuntimeModelConfig(mend.root)
    await mark("models")
    reload()
    dialog.clear()
    toast.show({ variant: "success", message: `Primary model preset applied from ${providerID}.`, duration: 4000 })
  }

  const chooseProviderModelPreset = (providerID: string) => {
    const provider = sync.data.provider.find((item) => item.id === providerID)
    if (!provider) return
    const options = Object.entries(provider.models)
      .filter(([, model]) => model.status !== "deprecated")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([modelID, model]) => ({
        title: model.name || modelID,
        value: modelID,
        category: providerDisplayName(provider),
        description: `${provider.id}/${modelID} · ${inferAuthMode(provider.id, modelID) || "provider auth"}`,
        onSelect: () => applyProviderModelPreset(provider.id, modelID),
      }))
    if (!options.length) {
      toast.show({ variant: "warning", message: `${providerDisplayName(provider)} has no selectable models.`, duration: 4000 })
      return
    }
    dialog.replace(() => <DialogSelect title={`${providerDisplayName(provider)} baseline model`} options={options} />)
  }

  const applyModelOnboardingPreset = async (preset: "subscription" | "api-balanced" | "api-budget") => {
    const config = await readModelsConfig(mend.root)
    const primary = preset === "subscription"
      ? presetRole(modelPresets["openai-codex-subscription-gpt-5.6-sol"])
      : preset === "api-balanced"
        ? presetRole(modelPresets["openai-api-gpt-5.6"])
        : presetRole(modelPresets["openai-api-gpt-5-mini"])
    const defaultRole = preset === "subscription"
      ? presetRole(modelPresets["openai-codex-subscription-gpt-5.6-sol"])
      : preset === "api-balanced"
        ? presetRole(modelPresets["openai-api-gpt-5.6"])
        : presetRole(modelPresets["openai-api-gpt-5-mini"])
    const helper = preset === "api-balanced"
      ? presetRole(modelPresets["openai-api-gpt-5-mini"])
      : preset === "api-budget"
        ? presetRole(modelPresets["openai-api-gpt-5-nano"])
        : defaultRole
    config.enabled = true
    config.roles.default = defaultRole
    config.roles.build = primary
    config.roles.code = primary
    config.roles.plan = defaultRole
    config.roles.subagent = primary
    config.roles.small = helper
    config.roles.title = helper
    config.roles.compaction = helper
    config.roles.summary = helper
    config.roles.memoryExtractor = helper
    config.roles.memoryDream = helper
    config.roles.memoryAssistant = helper
    config.roles.permissionReviewer = helper
    await writeGlobalModelsConfig(config)
    await syncGlobalPrimaryAgentModels(mend.root)
    await refreshGeneratedRuntimeModelConfig(mend.root)
    await writeBudgetPolicy(
      preset === "subscription"
        ? { mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false }
        : { mode: "api-usage", warnUsd: 1, stopUsd: 3, expensiveModelRequiresConfirm: true },
      mend.root,
    )
    await mark("models")
    await mark("budget")
    dialog.clear()
    toast.show({ variant: "success", message: "Model and usage preset applied.", duration: 4000 })
  }

  const chooseModelRoleMenu = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Model Roles"
        options={[
          {
            title: "ChatGPT subscription preset",
            value: "subscription",
            category: "Onboarding presets",
            description: "Use Codex OAuth defaults; no API-key billing contract is written.",
            onSelect: async () => applyModelOnboardingPreset("subscription"),
          },
          {
            title: "OpenAI API balanced preset",
            value: "api-balanced",
            category: "Onboarding presets",
            description: "Use stronger primary roles and cheaper helper roles; requires OPENAI_API_KEY.",
            onSelect: async () => applyModelOnboardingPreset("api-balanced"),
          },
           {
             title: "OpenAI API budget preset",
            value: "api-budget",
            category: "Onboarding presets",
            description: "Use mini/nano API presets for lower-cost onboarding and smoke tests.",
             onSelect: async () => applyModelOnboardingPreset("api-budget"),
           },
           ...sync.data.provider
             .filter((provider) => Object.keys(provider.models).length > 0)
             .map((provider) => ({
               title: `${providerDisplayName(provider)} baseline preset`,
               value: `provider:${provider.id}`,
               category: "Connected provider",
               description: "Pick one model from this provider and use it for the primary MendCode roles.",
               onSelect: () => chooseProviderModelPreset(provider.id),
             })),
           ...setupModelRoles().map((role) => ({
            title: roleLabel(role),
            value: role,
            category: roleCategory(role),
            description: roleDescriptions[role] || "Additional primary agent role.",
            footer: roleLabels[role] ? `role id: ${role}` : undefined,
            onSelect: () => chooseModelRole(role),
          })),
        ]}
      />
    ))
  }

  const chooseBudget = () => {
    dialog.replace(() => (
       <DialogSelect
         title="Budget Policy"
         current={setupSummary()?.budget?.mode === "api-usage" ? "api-usage" : "subscription"}
         options={[
          {
            title: "Subscription usage preset",
            value: "subscription",
            category: "Usage mode",
            description: "No loop token/cost budget and no API USD warn/stop gate.",
            onSelect: async () => {
              await writeBudgetPolicy(
                { mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false },
                mend.root,
              )
              await mark("budget")
              toast.show({ variant: "success", message: "Subscription usage mode enabled; no budget limits configured.", duration: 4000 })
            },
          },
          {
            title: "API usage preset",
            value: "api-usage",
            category: "Usage mode",
            description: "Use API-priced USD enforcement with $1 warning and $3 stop defaults.",
            onSelect: async () => {
              await writeBudgetPolicy(
                { mode: "api-usage", warnUsd: 1, stopUsd: 3, expensiveModelRequiresConfirm: true },
                mend.root,
              )
              await mark("budget")
              toast.show({ variant: "success", message: "API usage mode enabled with $1/$3 USD limits.", duration: 4000 })
            },
          },
          {
            title: "Set API USD limits",
            value: "custom",
            category: "API usage",
            description: "Choose your own warn and stop thresholds. Blank means no API USD limit.",
            onSelect: async () => {
              const current = setupSummary()?.budget as any
              const warnInput = await DialogPrompt.show(dialog, "Warn USD", {
                value: current?.warnUsd === undefined ? "" : String(current.warnUsd),
                placeholder: "1, 3.50, or blank for no warning",
                description: () => (
                  <text fg={theme.textMuted}>
                    Warn when known API-priced spend reaches this USD amount. Blank disables warning.
                  </text>
                ),
              })
              if (warnInput === null) return
              const stopInput = await DialogPrompt.show(dialog, "Stop USD", {
                value: current?.stopUsd === undefined ? "" : String(current.stopUsd),
                placeholder: "3, 10, or blank for no stop",
                description: () => (
                  <text fg={theme.textMuted}>
                    Stop API-key priced calls when known spend reaches this USD amount. Blank means no hard limit.
                  </text>
                ),
              })
              if (stopInput === null) return
              try {
                const warnUsd = parseOptionalUsd(warnInput, "Warn USD")
                const stopUsd = parseOptionalUsd(stopInput, "Stop USD")
                await writeBudgetPolicy(
                  { mode: "api-usage", warnUsd, stopUsd, expensiveModelRequiresConfirm: current?.expensiveModelRequiresConfirm !== false },
                  mend.root,
                )
                await mark("budget")
                const warnLabel = warnUsd === null ? "no warning" : `$${warnUsd}`
                const stopLabel = stopUsd === null ? "no hard stop" : `$${stopUsd}`
                toast.show({
                  variant: "success",
                  message: `Budget policy saved: warn ${warnLabel}, stop ${stopLabel}.`,
                  duration: 4000,
                })
              } catch (e) {
                toast.show({
                  variant: "error",
                  message: e instanceof Error ? e.message : "Invalid budget policy.",
                  duration: 5000,
                })
              }
            },
          },
          {
            title: "No USD limit",
            value: "unlimited",
            category: "Budget",
            description: "Disable warn/stop USD thresholds. Expensive model confirmation stays on.",
            onSelect: async () => {
              await writeBudgetPolicy({ warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: true }, mend.root)
              await mark("budget")
              toast.show({
                variant: "success",
                message: "Budget policy saved with no USD warn/stop limit.",
                duration: 4000,
              })
            },
          },
          {
            title: "Toggle expensive model confirmation",
            value: "toggle-expensive-confirm",
            category: "Safety",
            description: "Require confirmation before expensive API-priced model calls.",
            onSelect: async () => {
              const current = setupSummary()?.budget as any
              await writeBudgetPolicy(
                {
                  warnUsd: current?.warnUsd ?? null,
                  stopUsd: current?.stopUsd ?? null,
                  expensiveModelRequiresConfirm: current?.expensiveModelRequiresConfirm === false,
                },
                mend.root,
              )
              await mark("budget")
              toast.show({ variant: "success", message: "Expensive model confirmation updated.", duration: 3000 })
            },
          },
        ]}
      />
    ))
  }

  const choosePromptMode = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Prompt Mode"
        current={setupSummary()?.prompt.mode}
        options={promptModes.map((mode) => ({
          title: mode,
          value: mode,
          category: "Prompt",
          description: promptModeDetails[mode].runtime,
          onSelect: async () => {
            await writePromptMode(mode, mend.root)
            await mend.reload()
            await mark("prompt")
            toast.show({ variant: "success", message: `Prompt mode is now ${mode}.`, duration: 3000 })
          },
        }))}
      />
    ))
  }

  const chooseMemory = () => {
    const current = setupSummary()?.memory
    dialog.replace(() => (
      <DialogSelect
        title="Memory"
        current={setupMemoryDialogCurrentValue(current)}
        options={[
          {
            title: "Enable memory use (opt-in)",
            value: "enable-use",
            category: "Memory",
            description: "Read local global/project memories and inject relevant context.",
            onSelect: async () => {
              await writeGlobalMemoryConfig({ enabled: true, use: true }, mend.root)
              await mark("memory")
              toast.show({ variant: "success", message: "Memory use enabled.", duration: 3000 })
              reload()
            },
          },
          {
            title: "Disable memory",
            value: "disable",
            category: "Memory",
            description: "Do not read or inject persistent memory.",
            onSelect: async () => {
              await writeGlobalMemoryConfig({ enabled: false, use: false, generate: false }, mend.root)
              toast.show({ variant: "success", message: "Memory disabled.", duration: 3000 })
              reload()
            },
          },
          {
            title: "Allow generated proposals (approval-gated)",
            value: "generate",
            category: "Generation",
            description: "Permit future extractor runs to create approval-gated memory proposals.",
            onSelect: async () => {
              await writeGlobalMemoryConfig(
                { enabled: true, use: true, generate: true, requireApprovalForGenerated: true },
                mend.root,
              )
              await mark("memory")
              toast.show({ variant: "success", message: "Memory proposal generation enabled.", duration: 3000 })
              reload()
            },
          },
          {
            title: "Configure extractor model",
            value: "extractor-model",
            category: "Model",
            description: "Choose the cheap/small model role used only for memory proposal decisions.",
            onSelect: async () => chooseModelRole("memoryExtractor"),
          },
        ]}
      />
    ))
  }

  const choosePermissions = () => {
    const current = setupSummary()?.permissions
    const modeOptions: Array<{ title: string; value: PermissionMode; category: string; description: string }> = [
      {
        title: "Require approval",
        value: "approval",
        category: "Permission mode",
        description: "Ask before permission-gated actions.",
      },
      {
        title: "Smart Approval",
        value: "smart",
        category: "Permission mode",
        description: "Auto-approve bounded read-only commands; review risky shell, script, and delete prompts.",
      },
      {
        title: "Full Access",
        value: "full_access",
        category: "Permission mode",
        description: "Approve permission prompts in the active TUI session without asking.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Permissions"
        current={current?.mode || "approval"}
        options={[
          ...modeOptions.map((option) => ({
            ...option,
            onSelect: async () => {
              await writePermissionsConfig({ mode: option.value })
              await mark("permissions")
              reload()
              toast.show({ variant: "success", message: `Permission mode saved: ${option.title}.`, duration: 4000 })
              dialog.clear()
            },
          })),
          {
            title: "Configure reviewer model",
            value: "reviewer-model",
            category: "Model",
            description: "Choose the model role used by Smart Approval.",
            onSelect: async () => chooseModelRole(current?.reviewerRole || "permissionReviewer"),
          },
        ]}
      />
    ))
  }

  const savePackageMetadataAndSnapshot = async (input: {
    title: string
    id: string
    description: string
    version: string
    channel: string
  }) => {
    await packageMetadataSet(input, mend.root)
    const snapshot = await applyRuntimePack(mend.root)
    await mark("package")
    reload()
    toast.show({
      variant: "success",
      message: `Package snapshot updated: ${snapshot.packageManifestPath}`,
      duration: 4000,
    })
  }

  const choosePackageAuthorMetadata = async () => {
    const current = setupSummary()?.pkg
    const title = await DialogPrompt.show(dialog, "Package title", {
      value: current?.title || "",
      placeholder: "Starter Pack",
      description: () => (
        <text fg={theme.textMuted}>Human-facing title shown in generated mend-package.json and registry previews.</text>
      ),
    })
    if (title === null) return
    const id = await DialogPrompt.show(dialog, "Package id", {
      value: current?.id || "",
      placeholder: "starter-pack",
      description: () => (
        <text fg={theme.textMuted}>Stable package id. Blank keeps the generated local runtime id.</text>
      ),
    })
    if (id === null) return
    const description = await DialogPrompt.show(dialog, "Package description", {
      value: current?.description || "",
      placeholder: "Reusable starter package for MendCode",
      description: () => <text fg={theme.textMuted}>Short summary for registry/search/show output.</text>,
    })
    if (description === null) return
    const version = await DialogPrompt.show(dialog, "Package version", {
      value: current?.version || "0.1.0",
      placeholder: "0.1.0",
      description: () => <text fg={theme.textMuted}>Semantic package version used by registry previews and updates.</text>,
    })
    if (version === undefined || version === null) return
    dialog.replace(() => (
      <DialogSelect
        title="Package channel"
        current={current?.channel || "local"}
        options={[
          {
            title: "local",
            value: "local",
            category: "Channel",
            description: "Only for local authoring/default export.",
            onSelect: async () => {
              await savePackageMetadataAndSnapshot({ title, id, description, version, channel: "local" })
            },
          },
          {
            title: "official",
            value: "official",
            category: "Channel",
            description: "Prepared for curated/shared registry publication.",
            onSelect: async () => {
              await savePackageMetadataAndSnapshot({ title, id, description, version, channel: "official" })
            },
          },
          {
            title: "beta",
            value: "beta",
            category: "Channel",
            description: "Visible as pre-release/shared preview.",
            onSelect: async () => {
              await savePackageMetadataAndSnapshot({ title, id, description, version, channel: "beta" })
            },
          },
        ]}
      />
    ))
  }

  const syncPackageRuntime = async () => {
    await syncProject(mend.root)
    await mend.reload()
    await mark("package")
    reload()
  }

  const exportSafeRuntimeSnapshot = async () => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Export safe runtime snapshot",
      [
        "Writes mend-package.json and .mendcode/runtime-pack.json for shareable setup config.",
        "Secrets, auth files, sessions, runs, cache, and local provider tokens are excluded.",
      ].join("\n"),
    )
    if (!confirmed) return
    try {
      const snapshot = await applyRuntimePack(mend.root)
      await mark("package")
      reload()
      toast.show({
        variant: "success",
        message: `Safe snapshot exported: ${snapshot.packPath}`,
        duration: 5000,
      })
      dialog.clear()
    } catch (error) {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : "Safe runtime snapshot export failed.",
        duration: 7000,
      })
    }
  }

  const ensureRegistrySourceIDAvailable = async (sourceID: string) => {
    const registry = await runtimeRegistryList(mend.root)
    if (registry.entries.some((entry) => entry.id === sourceID)) {
      throw new Error(`Registry source already exists: ${sourceID}. Choose a new source id.`)
    }
  }

  const removeFailedRegistrySource = async (sourceID: string) => {
    try {
      await runtimeRegistryRemove(sourceID, mend.root)
    } catch {
      // Best effort cleanup only; the visible error should stay focused on the failed install.
    }
  }

  const showImportedSourcePackages = async (input: {
    sourceID: string
    sourceURL: string
    result: Awaited<ReturnType<typeof runtimeRegistrySearch>>
    title: string
    installErrorMessage: string
  }) => {
    let keepSource = false
    dialog.replace(() => (
      <DialogSelect
        title={input.title}
        options={input.result.results.map((pack) => ({
          title: setupMarketplaceBadgeTitle(pack.title || pack.id),
          value: pack.id,
          category: setupMarketplaceCategory({ channel: pack.channel, sourceID: input.sourceID }),
          description: pack.description || setupMarketplaceRuntimeSummary(pack),
          searchText: setupMarketplaceSearchText([
            pack.id,
            pack.title,
            pack.description,
            setupMarketplaceRuntimeSummary(pack),
            pack.channel,
            input.sourceID,
            ...(pack.tags || []),
          ]),
          footer: pack.version,
          onSelect: async () => {
            keepSource = true
            try {
              const confirmed = await DialogConfirm.show(
                dialog,
                `Install ${pack.title || pack.id}`,
                setupMarketplaceInstallPreview({
                  pack,
                  sourceID: input.sourceID,
                  sourceURL: input.result.source.url || input.sourceURL,
                  sourceType: input.result.source.type,
                  fetchesNetwork: input.result.fetchesNetwork,
                  digest: input.result.digest,
                }),
              )
              if (!confirmed) {
                await removeFailedRegistrySource(input.sourceID)
                keepSource = false
                return
              }
              const installed = await runtimeRegistryInstallPack(pack.id, input.sourceID, mend.root)
              await syncPackageRuntime()
              toast.show({ variant: "success", message: `Installed package: ${installed.package.id}.`, duration: 5000 })
              dialog.clear()
            } catch (error) {
              await removeFailedRegistrySource(input.sourceID)
              keepSource = false
              toast.show({
                variant: "error",
                message: error instanceof Error ? error.message : input.installErrorMessage,
                duration: 7000,
              })
            }
          },
        }))}
      />
    ), () => {
      if (keepSource) return
      void removeFailedRegistrySource(input.sourceID)
    })
  }

  const chooseOfficialPackage = async () => {
    try {
      const result = await runtimeRegistrySearch("", "official", mend.root)
      const packages = await listMendPackages(mend.root)
      if (!result.results.length) {
        toast.show({ variant: "warning", message: "No official packages found in the registry.", duration: 5000 })
        return
      }
      dialog.replace(() => (
        <DialogSelect
          title="Official Packages"
          options={result.results.map((pack) => {
            const installed = packages.installed.find((item) => item.id === pack.id)
            const badge = installed ? installed.enabled ? "active" : "installed" : null
            return {
            title: setupMarketplaceBadgeTitle(pack.title || pack.id, badge),
            value: pack.id,
            category: setupMarketplaceCategory({ badge, channel: pack.channel, sourceID: "official" }),
            description: pack.description || setupMarketplaceRuntimeSummary(pack),
            searchText: setupMarketplaceSearchText([pack.id, pack.title, pack.description, setupMarketplaceRuntimeSummary(pack), pack.channel, badge, ...(pack.tags || [])]),
            footer: [pack.version, badge].filter(Boolean).join(" · "),
            onSelect: async () => {
              const confirmed = await DialogConfirm.show(
                dialog,
                `Install ${pack.title || pack.id}`,
                setupMarketplaceInstallPreview({
                  pack,
                  sourceID: "official",
                  sourceURL: result.source.url,
                  sourceType: result.source.type,
                  fetchesNetwork: result.fetchesNetwork,
                  digest: result.digest,
                }),
              )
              if (!confirmed) return
              const installed = await runtimeRegistryInstallPack(pack.id, "official", mend.root)
              await syncPackageRuntime()
              toast.show({ variant: "success", message: `Installed package: ${installed.package.id}.`, duration: 5000 })
              dialog.clear()
            },
            }
          })}
        />
      ))
    } catch (error) {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : "Official packages are unavailable.",
        duration: 7000,
      })
    }
  }

  const installLocalPackagePath = async () => {
    const sourcePath = await DialogPrompt.show(dialog, "Local package path", {
      value: "",
      placeholder: "/path/to/package-or-registry",
      description: () => <text fg={theme.textMuted}>Directory or manifest containing a MendCode package.</text>,
    })
    if (!sourcePath?.trim()) return
    const sourceID = await DialogPrompt.show(dialog, "Local source id", {
      value: "local-import",
      placeholder: "local-import",
      description: () => <text fg={theme.textMuted}>Stable id for this local registry source.</text>,
    })
    if (!sourceID?.trim()) return
    let sourceAdded = false
    try {
      await ensureRegistrySourceIDAvailable(sourceID.trim())
      await runtimeRegistryAdd([sourceID.trim(), "--type", "local", "--url", sourcePath.trim(), "--note", "Setup-added local package source."], mend.root)
      sourceAdded = true
      const result = await runtimeRegistrySearch("", sourceID.trim(), mend.root)
      if (result.results.length > 1) {
        await showImportedSourcePackages({
          sourceID: sourceID.trim(),
          sourceURL: sourcePath.trim(),
          result,
          title: "Packages from local source",
          installErrorMessage: "Local package install failed.",
        })
        return
      }
      if (result.results.length === 1) {
        const installed = await runtimeRegistryInstallPack(result.results[0]!.id, sourceID.trim(), mend.root)
        await syncPackageRuntime()
        toast.show({
          variant: "success",
          message: `Installed local package source: ${installed.package.id}.`,
          duration: 5000,
        })
        return
      }
      const preview = await runtimeRegistryApplySource(sourceID.trim(), mend.root)
      await syncPackageRuntime()
      toast.show({
        variant: "success",
        message: `Installed local package source: ${preview.package?.id || sourceID.trim()}.`,
        duration: 5000,
      })
    } catch (error) {
      if (sourceAdded) await removeFailedRegistrySource(sourceID.trim())
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : "Local package install failed.",
        duration: 7000,
      })
    }
  }

  const installGitHubPackageUrl = async () => {
    const sourceURL = await DialogPrompt.show(dialog, "GitHub package URL", {
      value: "",
      placeholder: "https://github.com/org/mendcode-package.git",
      description: () => (
        <text fg={theme.textMuted}>Public git URL containing a MendCode package or marketplace catalog.</text>
      ),
    })
    if (!sourceURL?.trim()) return
    if (!isPublicGitHubURL(sourceURL)) {
      toast.show({
        variant: "error",
        message: "Package URL must be a public https://github.com/<org>/<repo> URL. Use local path for filesystem packages.",
        duration: 7000,
      })
      return
    }
    const sourceID = await DialogPrompt.show(dialog, "Source id", {
      value: registrySourceIDFromURL(sourceURL),
      placeholder: "url-my-package",
      description: () => <text fg={theme.textMuted}>Saved in .mendcode/registry.json; no credentials are stored.</text>,
    })
    if (!sourceID?.trim()) return
    let sourceAdded = false
    try {
      await ensureRegistrySourceIDAvailable(sourceID.trim())
      await runtimeRegistryAdd([sourceID.trim(), "--type", "github", "--url", sourceURL.trim(), "--note", "Setup-added GitHub package source."], mend.root)
      sourceAdded = true
      const result = await runtimeRegistrySearch("", sourceID.trim(), mend.root)
      if (result.results.length > 1) {
        await showImportedSourcePackages({
          sourceID: sourceID.trim(),
          sourceURL: sourceURL.trim(),
          result,
          title: "Packages from URL",
          installErrorMessage: "Package URL install failed.",
        })
        return
      }
      if (result.results.length === 1) {
        const pack = result.results[0]!
        const confirmed = await DialogConfirm.show(
          dialog,
          `Install ${pack.title || pack.id}`,
          setupMarketplaceInstallPreview({
            pack,
            sourceID: sourceID.trim(),
            sourceURL: result.source.url || sourceURL.trim(),
            sourceType: result.source.type,
            fetchesNetwork: result.fetchesNetwork,
            digest: result.digest,
          }),
        )
        if (!confirmed) {
          await removeFailedRegistrySource(sourceID.trim())
          return
        }
        const installed = await runtimeRegistryInstallPack(pack.id, sourceID.trim(), mend.root)
        await syncPackageRuntime()
        toast.show({ variant: "success", message: `Installed package: ${installed.package.id}.`, duration: 5000 })
        dialog.clear()
        return
      }
      await removeFailedRegistrySource(sourceID.trim())
      toast.show({ variant: "warning", message: "No installable MendCode packages found in that GitHub repo.", duration: 6000 })
    } catch (error) {
      if (sourceAdded) await removeFailedRegistrySource(sourceID.trim())
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : "Package URL install failed.",
        duration: 7000,
      })
    }
  }

  const manageInstalledPackages = async () => {
    const packages = await listMendPackages(mend.root)
    dialog.replace(() => (
      <DialogSelect
        title="Installed Packages"
        options={[
          {
            title: "Deselect all",
            value: "disable-all",
            category: "Action",
            description: `${packages.enabled.length} active packages`,
            onSelect: async () => {
              await disableAllMendPackages(mend.root)
              await syncPackageRuntime()
              toast.show({ variant: "success", message: "All packages deselected.", duration: 4000 })
            },
          },
          ...packages.installed.map((item) => ({
            title: setupMarketplaceBadgeTitle(item.title || item.id, item.enabled ? "active" : "installed"),
            value: item.id,
            category: setupMarketplaceCategory({ badge: item.enabled ? "active" : "installed", channel: item.channel, sourceID: item.sourceType }),
            description: item.description || item.root,
            searchText: setupMarketplaceSearchText([item.id, item.title, item.description, item.root, item.version, item.channel, item.sourceType, item.enabled ? "active enabled selected" : "installed inactive disabled"]),
            footer: item.version || item.channel || item.sourceType,
            onSelect: async () => {
              await setMendPackageEnabled(item.id, !item.enabled, mend.root)
              await syncPackageRuntime()
              toast.show({
                variant: "success",
                message: `${item.title || item.id} ${item.enabled ? "deselected" : "enabled"}.`,
                duration: 4000,
              })
              void manageInstalledPackages()
            },
          })),
          ...packages.installed.map((item) => ({
            title: `Remove ${item.title || item.id}`,
            value: `remove:${item.id}`,
            category: "Remove",
            description: "Deletes only the installed overlay copy.",
            onSelect: async () => {
              const confirmed = await DialogConfirm.show(
                dialog,
                "Remove package",
                `Remove installed package snapshot ${item.title || item.id}? Local source/customization files stay on disk.`,
              )
              if (!confirmed) return
              await removeMendPackage(item.id, mend.root)
              await syncPackageRuntime()
              toast.show({ variant: "success", message: `${item.title || item.id} removed.`, duration: 4000 })
              void manageInstalledPackages()
            },
          })),
        ]}
      />
    ))
  }

  const choosePackageMetadata = async () => {
    dialog.replace(() => (
      <DialogSelect
        title="Package"
        options={[
          {
            title: "Skip packages",
            value: "skip",
            category: "Setup",
            description: "Leave package overlays unchanged.",
            onSelect: async () => {
              await mark("package")
              toast.show({ variant: "success", message: "Package step skipped.", duration: 3000 })
              dialog.clear()
            },
          },
          {
            title: "Browse official packages",
            value: "official",
            category: "Install",
            description: "Install a curated package from MendCode/mendcode-marketplace.",
            onSelect: () => void chooseOfficialPackage(),
          },
          {
            title: "Import local package path",
            value: "local-path",
            category: "Import",
            description: "Import a local package directory or manifest as an overlay; secrets remain local.",
            onSelect: () => void installLocalPackagePath(),
          },
          {
            title: "Import GitHub package URL",
            value: "github-url",
            category: "Import",
            description: "Add a public package repository or marketplace catalog, then import from it.",
            onSelect: () => void installGitHubPackageUrl(),
          },
          {
            title: "Export safe config snapshot",
            value: "export-safe",
            category: "Export",
            description: "Write mend-package.json + runtime-pack without auth, sessions, runs, cache, or secrets.",
            onSelect: () => void exportSafeRuntimeSnapshot(),
          },
          {
            title: "Create/update local package",
            value: "author",
            category: "Author",
            description: "Edit metadata and write mend-package.json + runtime-pack snapshot.",
            onSelect: () => void choosePackageAuthorMetadata(),
          },
          {
            title: "Manage installed packages",
            value: "manage",
            category: "Manage",
            description: `${setupSummary()?.packages.installed.length || 0} installed · ${setupSummary()?.packages.enabled.length || 0} active`,
            onSelect: () => void manageInstalledPackages(),
          },
        ]}
      />
    ))
  }

  const chooseTuiProfile = async () => {
    const current = await readActiveTuiProfile(mend.root)
    const identityMode = await new Promise<"title" | "mascot" | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Home identity"
            current={current.identity.logoMode || "title"}
            renderFilter={false}
            options={[
              {
                title: "ASCII title",
                value: "title",
                category: "Home",
                description: "Default MendCode title logo. You can still set your own product title.",
                onSelect: async () => resolve("title"),
              },
              {
                title: "ASCII mascot",
                value: "mascot",
                category: "Home",
                description: "Use ASCII mascot art as the Home logo.",
                onSelect: async () => resolve("mascot"),
              },
            ]}
          />
        ),
        () => resolve(null),
      )
    })
    if (identityMode === null) return
    const productName = await DialogPrompt.show(dialog, "Product name", {
      value: current.identity.productName,
      placeholder: "MendCode",
      description: () => <text fg={theme.textMuted}>Visible product name for home, footer, and terminal title.</text>,
    })
    if (productName === null) return
    const logoFont = await new Promise<"mendcode" | "small" | "standard" | "shadow" | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Home title font"
            current={
              current.identity.logoFont === "classic" || current.identity.logoFont === "opencode"
                ? "mendcode"
                : current.identity.logoFont || "mendcode"
            }
            renderFilter={false}
            options={[
              {
                title: "MendCode",
                value: "mendcode",
                category: "Font",
                description: "MendCode block title: block tops, flat bases, compact rows.",
                onSelect: async () => resolve("mendcode"),
              },
              {
                title: "Small",
                value: "small",
                category: "Font",
                description: "Compact figlet style with more personality than classic.",
                onSelect: async () => resolve("small"),
              },
              {
                title: "Standard",
                value: "standard",
                category: "Font",
                description: "Readable slanted ASCII banner.",
                onSelect: async () => resolve("standard"),
              },
              {
                title: "Shadow",
                value: "shadow",
                category: "Font",
                description: "ANSI shadow style with tighter letter spacing.",
                onSelect: async () => resolve("shadow"),
              },
            ]}
          />
        ),
        () => resolve(null),
      )
    })
    if (logoFont === null) return
    const welcomeMode = await new Promise<"centered" | "split" | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Home welcome mode"
            current={current.surfaces.homeWelcome?.mode || "centered"}
            renderFilter={false}
            options={[
              {
                title: "Centered",
                value: "centered",
                category: "Home",
                description: "Centered logo with actions underneath.",
                onSelect: async () => resolve("centered"),
              },
              {
                title: "Split",
                value: "split",
                category: "Home",
                description: "Two-column welcome: identity top-left, activity panel top-right.",
                onSelect: async () => resolve("split"),
              },
            ]}
          />
        ),
        () => resolve(null),
      )
    })
    if (welcomeMode === null) return
    const rightPanel = setupShouldChooseHomeSplitPanel(welcomeMode)
      ? await new Promise<"actions" | "agentManager" | null>((resolve) => {
          dialog.replace(
            () => (
              <DialogSelect
                title="Home split panel"
                current={current.surfaces.homeWelcome?.rightPanel || "agentManager"}
                renderFilter={false}
                options={[
                  {
                    title: "Actions",
                    value: "actions",
                    category: "Home",
                    description: "Show Resume, Open commands, and Quit in the split panel.",
                    onSelect: async () => resolve("actions"),
                  },
                  {
                    title: "Agent View",
                    value: "agentManager",
                    category: "Home",
                    description: "Show global sessions grouped by input, working, and completed.",
                    onSelect: async () => resolve("agentManager"),
                  },
                ]}
              />
            ),
            () => resolve(null),
          )
        })
      : current.surfaces.homeWelcome?.rightPanel || "agentManager"
    if (rightPanel === null) return
    const applyTuiIdentityPreset = async (
      preset: "comfortable" | "compact" | "spacious",
      promptChromePreset: MendPromptChromePreset,
      message: string,
    ) => {
      dialog.clear()
      const nextStep: SetupStepID = "prompt"
      setSelected(nextStep)
      reload()
      try {
        await writeActiveTuiProfile(
          {
            ...current,
            promptChrome: { ...current.promptChrome, preset: promptChromePreset },
            identity: { productName: normalizeProductName(productName), tagline: "", logoMode: identityMode, logoFont },
            surfaces: {
              ...current.surfaces,
              homeLogo: { ...(current.surfaces.homeLogo || {}) },
              homeWelcome: { ...(current.surfaces.homeWelcome || {}), mode: welcomeMode, rightPanel },
            },
          },
          mend.root,
        )
        await applyTuiPreset(preset, mend.root)
        await mend.reload()
        await mark("tui")
        await setSetupCurrentStep(nextStep, mend.root)
        reload()
        toast.show({ variant: "success", message, duration: 4000 })
      } catch (error) {
        setSelected("tui")
        await setSetupCurrentStep("tui", mend.root)
        reload()
        toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : "Failed to update TUI profile.",
          duration: 5000,
        })
      }
    }
    dialog.replace(() => (
      <DialogSelect
        title="TUI prompt chrome"
        current={current.promptChrome?.preset || "top-bottom"}
        renderFilter={false}
        options={[
          {
            title: "Full box",
            value: "box",
            category: "Prompt chrome",
            description: "Top + sides + bottom box around the chat input for new chat and sessions.",
            onSelect: async () =>
              applyTuiIdentityPreset("comfortable", "box", "TUI identity updated with full box prompt."),
          },
          {
            title: "Top + bottom only",
            value: "top-bottom",
            category: "Prompt chrome",
            description: "Horizontal rules only, with no left/right edges.",
            onSelect: async () =>
              applyTuiIdentityPreset(
                "comfortable",
                "top-bottom",
                "TUI identity updated with top/bottom prompt chrome.",
              ),
          },
          {
            title: "Minimal panel",
            value: "minimal",
            category: "Prompt chrome",
            description: "No border, only the existing prompt panel background.",
            onSelect: async () =>
              applyTuiIdentityPreset("comfortable", "minimal", "TUI identity updated with minimal prompt panel."),
          },
          {
            title: "ASCII terminal",
            value: "ascii-box",
            category: "Prompt chrome",
            description: "Full box using plain ASCII borders for old-school terminals.",
            onSelect: async () =>
              applyTuiIdentityPreset("compact", "ascii-box", "TUI identity updated with ASCII prompt box."),
          },
        ]}
      />
    ))
  }

  const finish = async () => {
    const state = setupSummary()?.state
    if (!state || !isSetupComplete(state)) {
      toast.show({
        variant: "warning",
        message: "Provider, models, budget, and prompt are required before finishing.",
        duration: 4000,
      })
      return
    }
    route.navigate(routeReturnTarget(route.data))
  }

  const runPrimaryAction = async (step: SetupStepID) => {
    if (step === "start") return chooseSetupPreset()
    if (step === "provider") return chooseProvider()
    if (step === "models") return chooseModelRoleMenu()
    if (step === "budget") return chooseBudget()
    if (step === "package") return choosePackageMetadata()
    if (step === "tui") return chooseTuiProfile()
    if (step === "prompt") return choosePromptMode()
    if (step === "memory") return chooseMemory()
    if (step === "permissions") return choosePermissions()
  }

  const models = createMemo(() => setupSummary()?.modelsConfig.roles || {})
  const additionalModelRoles = createMemo(() =>
    setupModelRoles().filter((role) => {
      return (
        !(primaryModelRoles as readonly string[]).includes(role) &&
        !(internalModelRoles as readonly string[]).includes(role)
      )
    }),
  )
  const modelRole = (role: SetupModelRole) => {
    const roles = models()
    if (role === "build") return roles.build?.modelID ? roles.build : roles.code
    return roles[role]
  }
  const budget = createMemo(() => setupSummary()?.budget as any)
  const auth = createMemo(() => setupSummary()?.auth as any)
  const activeRuntimeProviderID = createMemo(() => local.model.current()?.providerID || undefined)
  const providerLabel = createMemo(() => {
    const providerID = auth()?.providerID || activeRuntimeProviderID() || connectedProviderIDs()[0]
    if (!providerID) return "not selected"
    return sync.data.provider.find((provider) => provider.id === providerID)?.name ?? providerID
  })
  const providerReady = createMemo(() => {
    const status = auth()
    if (status?.providerID) return status.mendRunReady === true || connectedProviderIDs().includes(status.providerID)
    return connectedProviderIDs().length > 0
  })
  const providerStatusText = createMemo(() => {
    const status = auth()
    if (status?.mendRunReady) return "ready"
    if (status?.providerID && connectedProviderIDs().includes(status.providerID)) return "ready via connected provider"
    if (status?.providerID) return "auth blocked"
    if (connectedProviderIDs().length > 0) return "available via stored runtime auth"
    return "incomplete"
  })
  const memoryExtractorAuth = createMemo(() => setupSummary()?.memoryExtractorAuth as any)
  const memoryLearningStatus = createMemo(() => {
    const memory = setupSummary()?.memory
    return setupMemoryLearningStatus({
      generate: memory?.generate,
      outputCallsProviders: memory?.outputCallsProviders,
      auth: memoryExtractorAuth(),
      connectedProviderIDs: connectedProviderIDs(),
    })
  })
  const showMemoryExtractorAuthBlocker = createMemo(() => {
    return setupShouldShowExtractorAuthBlocker({
      generate: setupSummary()?.memory.generate,
      auth: memoryExtractorAuth(),
      connectedProviderIDs: connectedProviderIDs(),
    })
  })

  createEffect(() => {
    const state = setupSummary()?.state
    if (!state) return
    if (!providerReady()) return
    if (state.completedSteps.includes("provider")) return
    void markSetupStepComplete("provider", mend.root).then(reload)
  })

  createEffect(() => {
    const state = setupSummary()?.state
    const setup = setupSummary()?.setup
    if (!state || !setup) return
    if (!(setup.modelsEnabled && setup.defaultModel)) return
    if (state.completedSteps.includes("models")) return
    void markSetupStepComplete("models", mend.root).then(reload)
  })

  return (
    <CommandDeck
      page="setup"
      subtitle={() => `${requiredProgress()}/${requiredSetupSteps.length} required · ${active()} step`}
      status={() => complete() ? "READY" : providerReady() ? "SETUP" : "BLOCKED"}
      summary={() => `${providerLabel()} · ${setupSummary()?.prompt.mode || "focus"} prompt · ${data.minimal ? "minimal mode" : "customizable"}`}
      footer="↑↓/jk Step   Enter Configure   Esc/Q Leave   R Refresh"
    >
      <box flexGrow={1} minHeight={0} flexDirection={narrow() ? "column" : "row"} gap={compact() ? 0 : 2}>
        <SetupRail
          active={active()}
          state={setupSummary()?.state}
          complete={complete()}
          minimal={data.minimal}
          narrow={narrow()}
          summary={{
            model: setupSummary()?.models.defaultModel,
            prompt: setupSummary()?.prompt.mode,
            budget: budget()?.enforcement?.state,
            packageTitle: setupSummary()?.pkg.title || setupSummary()?.pkg.id || undefined,
            authReady: providerReady(),
            authBlocked: Boolean(auth()?.providerID && !providerReady()),
            memory: setupSummary()?.memory.enabled ? (setupSummary()?.memory.use ? "on" : "stored") : "off",
            permissions:
              setupSummary()?.permissions.mode === "full_access" ? "full" : setupSummary()?.permissions.mode || "approval",
          }}
          onSelect={(step) => {
            setSelected(step)
            void setSetupCurrentStep(step, mend.root).then(reload)
          }}
        />

        <box
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          borderColor={theme.border}
          borderStyle="single"
          paddingLeft={compact() ? 0 : 1}
          paddingRight={compact() ? 0 : 1}
          paddingTop={compact() ? 0 : 1}
        >
          <scrollbox
            flexGrow={1}
            minHeight={0}
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{
              visible: narrow(),
              trackOptions: {
                backgroundColor: theme.backgroundPanel,
                foregroundColor: theme.border,
              },
            }}
          >
            <Show when={setupSummary()} fallback={<text fg={theme.textMuted}>Loading setup state...</text>}>
              <Switch>
              <Match when={active() === "start"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Quick start</text>
                  <text fg={theme.textMuted}>
                    Choose a starting profile first. Every choice stays editable in the steps below, and provider/model
                    credentials are never guessed or overwritten by a presentation preset.
                  </text>
                  <box flexDirection={narrow() ? "column" : "row"} gap={1}>
                    <box flexDirection="column" width={narrow() ? "100%" : "40%"} minWidth={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1}>
                      <text fg={theme.primary}>CURRENT BASELINE</text>
                      <text>Provider: {providerLabel()}</text>
                      <text>Models: {setupSummary()?.models.defaultModel || "not configured"}</text>
                      <text>Prompt: {setupSummary()?.prompt.mode || "focus"}</text>
                      <text>TUI: {mend.profile.layout.density} · {mend.profile.presentation.profile}</text>
                      <text>Memory: {setupSummary()?.memory.enabled ? "enabled" : "off"}</text>
                      <text>Permissions: {setupSummary()?.permissions.mode || "approval"}</text>
                      <text fg={theme.textMuted}>Required progress: {requiredProgress()}/{requiredSetupSteps.length}</text>
                    </box>
                    <box flexDirection="column" flexGrow={1} minWidth={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1}>
                      <text fg={theme.primary}>STARTING PROFILES</text>
                      <For each={setupPresetList}>
                        {(preset) => (
                          <box flexDirection="column" gap={0} onMouseDown={() => void applySetupPreset(preset.id)}>
                            <text fg={preset.id === "default" ? theme.primary : theme.text}>{preset.title}</text>
                            <text fg={theme.textMuted}>{truncateSetupText(preset.summary, promptPanelWidth())}</text>
                            <text fg={theme.textMuted}>{truncateSetupText(`  ${preset.changes}`, promptPanelWidth())}</text>
                          </box>
                        )}
                      </For>
                    </box>
                  </box>
                  <text fg={theme.textMuted}>Enter opens the profile picker. Use Custom when you want to configure each step manually.</text>
                </box>
              </Match>
              <Match when={active() === "provider"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Provider Manager</text>
                  <text>Primary runtime provider: {providerLabel()}</text>
                  <text>
                    Connected providers: {connectedProviderNames().length ? connectedProviderNames().join(", ") : "none"}
                  </text>
                  <text>
                    Auth: {providerStatusText()} · {auth()?.authMode || "not pinned in project config"}
                  </text>
                  <Show when={!providerReady() && auth()?.blockers?.length}>
                    <box flexDirection="column" gap={0}>
                      <text fg={theme.warning}>Why blocked:</text>
                      <For each={(auth()?.blockers || []).slice(0, 3)}>
                        {(blocker) => (
                          <text fg={theme.warning}>
                            {truncateSetupText(setupProviderAuthMessage(String(blocker)), promptPanelWidth())}
                          </text>
                        )}
                      </For>
                    </box>
                  </Show>
                  <Show when={!providerReady()}>
                    <text fg={theme.textMuted}>
                      Re-auth in Provider or expose the credential to the runtime, then reopen Setup.
                    </text>
                  </Show>
                  <Show when={!auth()?.providerID && connectedProviderNames().length > 0}>
                    <text fg={theme.textMuted}>
                      Runtime already has stored auth for {connectedProviderNames().join(", ")}, but no global default
                      provider/model is pinned in `~/.mendcode/models.yaml`.
                    </text>
                  </Show>
                   <Show when={!narrow()}>
                     <text fg={theme.textMuted}>
                       Enter opens Provider Manager. Select a provider to add or refresh auth; press d on saved auth to
                       disconnect it. Multiple providers can stay connected, then Models decides which roles use them.
                     </text>
                   </Show>
                   <SetupActionBar actions={[{ label: "Open Provider Manager", active: true, onPress: () => void chooseProvider() }]} />
                   <text fg={theme.textMuted}>Next: connect auth here, then choose a model preset or provider baseline in Models.</text>
                 </box>
              </Match>
              <Match when={active() === "models"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Models</text>
                   <text fg={theme.textMuted}>
                     Pick the main models first. The Subagents role sets the default for background workers, but each
                     subagent can still override its model in that agent's own config.
                   </text>
                   <text fg={theme.primary}>MODEL PRESETS</text>
                   <text fg={theme.textMuted}>ChatGPT subscription uses OAuth; OpenAI API uses an API key; connected provider presets use that provider's model catalog.</text>
                   <text fg={theme.textMuted}>OpenRouter, Anthropic, and other providers appear here only after their runtime auth/catalog is available.</text>
                  <For each={primaryModelRoles}>
                    {(role) => (
                      <box flexDirection="row" justifyContent="space-between" onMouseDown={() => chooseModelRole(role)}>
                        <text>{roleLabel(role)}</text>
                        <text fg={role === "default" && !modelRole(role)?.modelID ? theme.warning : theme.textMuted}>
                          {modelLabel(modelRole(role))}
                        </text>
                      </box>
                    )}
                  </For>
                  <box height={1} />
                  <text fg={theme.primary}>Background helpers</text>
                  <For each={internalModelRoles}>
                    {(role) => (
                      <box flexDirection="row" justifyContent="space-between" onMouseDown={() => chooseModelRole(role)}>
                        <text>{roleLabel(role)}</text>
                        <text fg={theme.textMuted}>{modelLabel(modelRole(role))}</text>
                      </box>
                    )}
                  </For>
                  <Show when={additionalModelRoles().length > 0}>
                    <box height={1} />
                    <text fg={theme.primary}>Skill roles</text>
                    <text fg={theme.textMuted}>
                      {additionalModelRoles().length} configured · press Enter to edit the full role list
                    </text>
                  </Show>
                   <box flexGrow={1} />
                   <text fg={theme.textMuted}>Enter opens onboarding presets plus all model roles. Click any visible row to edit it.</text>
                   <SetupActionBar actions={[{ label: "Open model presets", active: true, onPress: chooseModelRoleMenu }]} />
                 </box>
              </Match>
               <Match when={active() === "budget"}>
                 <box flexDirection="column" gap={1}>
                   <text fg={theme.primary}>Budget</text>
                   <text>Usage mode: {budget()?.mode === "api-usage" ? "API usage" : "Subscription"}</text>
                   <text>Warn USD: {budget()?.warnUsd ?? "no limit"}</text>
                   <text>Stop USD: {budget()?.stopUsd ?? "no limit"}</text>
                   <text>
                     Expensive model confirmation: {budget()?.expensiveModelRequiresConfirm === false ? "off" : "on"}
                   </text>
                   <text fg={theme.textMuted}>
                     Subscription mode leaves token and USD budgets unenforced.
                   </text>
                   <text fg={theme.textMuted}>
                     API usage mode can warn/stop by USD thresholds before provider calls.
                   </text>
                   <SetupActionBar actions={[{ label: "Configure budget", active: true, onPress: chooseBudget }]} />
                 </box>
               </Match>
              <Match when={active() === "prompt"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Prompt Mode</text>
                  <text>Current: {setupSummary()?.prompt.mode}</text>
                  <text fg={theme.textMuted}>
                    Customization contract: v{mendTuiCapabilityVersion()} · {surfacedCustomizationCapabilities.length}{" "}
                    visible · {listActiveCustomizations().length} active
                  </text>
                  <For each={promptModes}>
                    {(mode) => {
                      const policy = () => setupSummary()?.promptPolicies[mode]
                      const activeMode = () => setupSummary()?.prompt.mode === mode
                      return (
                        <box flexDirection="column" gap={0}>
                          <text
                            fg={activeMode() ? theme.primary : theme.text}
                          >{`${mode}: ${promptModeDetails[mode].summary}`}</text>
                          <text fg={theme.textMuted}>
                            {truncateSetupText(`  Adds: ${promptModeDetails[mode].adds}`, promptPanelWidth())}
                          </text>
                          <text fg={theme.textMuted}>
                            {truncateSetupText(`  Runtime: ${promptModeDetails[mode].runtime}`, promptPanelWidth())}
                          </text>
                          <text fg={theme.textMuted}>
                            {truncateSetupText(
                              `  Source: ${policy()?.basePromptSource ?? "measuring"}${policy()?.fallbackReason ? ` (${policy()?.fallbackReason})` : ""}`,
                              promptPanelWidth(),
                            )}
                          </text>
                          <text fg={theme.textMuted}>
                            {truncateSetupText(
                              `  Sections: ${policy()?.sections?.length ?? 0} · ${policy()?.instructionsBytes ?? "measuring"} bytes (${approxPromptTokens(policy()?.instructionsBytes)})`,
                              promptPanelWidth(),
                            )}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                  <text fg={theme.textMuted}>
                    {truncateSetupText(
                      "Enter changes mode. Footer/status reloads from .mendcode/prompt-mode.json.",
                      promptPanelWidth(),
                    )}
                  </text>
                  <text fg={theme.textMuted}>
                    Available now: {surfacedCustomizationCapabilities.map((item) => item.id).join(", ")}
                  </text>
                   <text fg={theme.textMuted}>
                     Blocked in v1: transcript.renderers, prompt.parser.override, sync.bootstrap.override
                   </text>
                   <SetupActionBar actions={[{ label: "Choose prompt mode", active: true, onPress: choosePromptMode }]} />
                 </box>
              </Match>
              <Match when={active() === "package"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Packages Store & Manager</text>
                  <text>ID: {setupSummary()?.pkg.id || "generated from local runtime"}</text>
                  <text>Title: {setupSummary()?.pkg.title || "unset"}</text>
                  <text>Description: {setupSummary()?.pkg.description || "unset"}</text>
                  <text>Version: {setupSummary()?.pkg.version || "0.1.0"}</text>
                  <text>Kind: {setupSummary()?.pkg.kind || "bundle"}</text>
                  <text>Channel: {setupSummary()?.pkg.channel || "local"}</text>
                  <text>
                    Installed packages: {setupSummary()?.packages.installed.length || 0} · active{" "}
                    {setupSummary()?.packages.enabled.length || 0}
                  </text>
                  <text>Import: official registry, public GitHub package URL, or local package path</text>
                  <text>Manage: activate/deactivate installed overlays, remove snapshots, or update local metadata</text>
                  <text>Export: mend-package.json + .mendcode/runtime-pack.json safe config snapshot</text>
                  <text fg={theme.textMuted}>
                    This metadata feeds generated `mend-package.json`, runtime-pack snapshots, and registry previews.
                  </text>
                  <text fg={theme.textMuted}>
                    Enter opens import/export/package actions. Package overlays install under .mendcode/packages/installed
                    and do not replace local sessions, auth, runs, cache, or customization files.
                  </text>
                </box>
              </Match>
              <Match when={active() === "tui"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>TUI Profile</text>
                  <text>Identity: {mend.profile.identity.logoMode === "mascot" ? "ASCII mascot" : "ASCII title"}</text>
                  <text>Product: {mend.profile.identity.productName}</text>
                  <text>Font: {mend.profile.identity.logoFont || "classic"}</text>
                  <text>Density: {mend.profile.layout.density}</text>
                  <text>Spacing: {mend.profile.layout.spacing}</text>
                  <text>Prompt chrome: {mend.profile.promptChrome.preset}</text>
                  <text>Presentation: {mend.profile.presentation.profile}</text>
                  <text>Activity: global spinner footer</text>
                   <text fg={theme.textMuted}>
                     Enter sets title-vs-mascot identity, product name, logo font, and prompt chrome preset.
                   </text>
                   <text fg={theme.textMuted}>Quick profiles: Minimal hides optional surfaces; Full restores the complete MendCode presentation.</text>
                  <text fg={theme.textMuted}>
                    Mascot mode uses MendBug by default and can be overridden from global TUI config.
                  </text>
                   <text fg={theme.textMuted}>
                     Setup-owned or setup-visible surfaces: {setupVisibleCapabilities.map((item) => item.id).join(", ")}
                   </text>
                   <SetupActionBar actions={[
                     { label: "Minimal TUI", onPress: () => void applyStandaloneTuiPreset("minimal") },
                     { label: "Full TUI", active: true, onPress: () => void applyStandaloneTuiPreset("full") },
                     { label: "Edit TUI profile", onPress: () => void chooseTuiProfile() },
                   ]} />
                 </box>
              </Match>
              <Match when={active() === "memory"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Memory</text>
                  <text>
                    Config scope: {setupSummary()?.memory.configScope === "project" ? "project override" : "global defaults"}
                  </text>
                  <text>Enabled: {setupSummary()?.memory.enabled ? "yes" : "no"}</text>
                  <text>Input memory: {setupSummary()?.memory.use ? "on" : "off"}</text>
                   <text>Memory learning: {setupSummary()?.memory.generate ? "on" : "off"} · {memoryLearningStatus()}</text>
                   <text fg={theme.textMuted}>Default and Minimal keep memory off. Full enables retrieval and approval-gated proposals; it never auto-applies generated changes.</text>
                  <text>
                    Context limit: {setupSummary()?.memory.maxPromptTokens} tokens · project {setupSummary()?.memory.projectMaxEntries}
                    /request · global {setupSummary()?.memory.globalCompactionMaxEntries}/after compaction
                  </text>
                  <text>
                    Memory extractor model: {modelLabel(modelRole(setupSummary()?.memory.extractorRole || "memoryExtractor"))}
                  </text>
                  <text>
                    Output model calls: {setupSummary()?.memory.outputCallsProviders ? "possible when learning runs" : "off"}
                  </text>
                  <Show when={showMemoryExtractorAuthBlocker()}>
                    <text fg={theme.warning}>
                      {setupLabelValueLine(
                        "Extractor auth",
                        setupExtractorAuthMessage(memoryExtractorAuth().blockers[0]),
                        promptPanelWidth(),
                      )}
                    </text>
                  </Show>
                  <text>
                    Consolidation model: {setupSummary()?.memory.consolidatorRole || "none"} · policy {setupSummary()?.memory.dreamConsolidationPolicy || "disabled"}
                  </text>
                  <text>
                    Dream model: {setupSummary()?.memory.memoryDreamRole || "memoryDream"} · manual/scheduled runs write proposals only
                  </text>
                  <text>
                    Side chat model: {setupSummary()?.memory.memoryAssistantRole || "memoryAssistant"} · no shell/git/source edits
                  </text>
                  <text>Scopes: {setupSummary()?.memory.scopes.join(", ")}</text>
                  <text>
                    Stored entries: global {setupSummary()?.memory.entries.global.count}, project{" "}
                    {setupSummary()?.memory.entries.project.count}
                  </text>
                  <text fg={theme.textMuted}>Works in every prompt mode: minimal, focus, and full.</text>
                  <text fg={theme.textMuted}>
                    Enter toggles memory config. Retrieval is local-only; learning uses the configured extractor role.
                  </text>
                   <text fg={theme.textMuted}>
                     Memory is injected as soft context; current user intent and repo evidence still win.
                   </text>
                   <SetupActionBar actions={[{ label: "Configure memory", active: true, onPress: chooseMemory }]} />
                 </box>
              </Match>
              <Match when={active() === "permissions"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Permissions</text>
                  <text>
                    Mode:{" "}
                    {setupSummary()?.permissions.mode === "full_access"
                      ? "Full Access"
                      : setupSummary()?.permissions.mode === "smart"
                        ? "Smart Approval"
                        : "Require approval"}
                  </text>
                  <text>Smart policy: safe read-only commands pass; risky shell/script/delete prompts stay gated</text>
                  <text>
                    Permission reviewer model:{" "}
                    {modelLabel(modelRole(setupSummary()?.permissions.reviewerRole || "permissionReviewer"))}
                  </text>
                  <text fg={theme.textMuted}>
                    Smart Approval auto-approves only bounded read-only shell requests. Risky or ambiguous requests stay
                    gated and can be reviewed by the configured model; a model response can never auto-approve a command
                    that is not provably read-only.
                  </text>
                  <text fg={theme.textMuted}>
                    Full Access is the renamed auto-accept mode for the TUI session. It does not change OS sandboxing by
                    itself.
                  </text>
                   <text fg={theme.textMuted}>Enter changes the global default in your MendCode config.</text>
                   <SetupActionBar actions={[{ label: "Configure permissions", active: true, onPress: choosePermissions }]} />
                 </box>
              </Match>
              </Switch>
            </Show>
          </scrollbox>
          <box flexDirection={compact() ? "column" : "row"} justifyContent="space-between" flexShrink={0}>
            <text fg={theme.textMuted} wrapMode="none">
              {compact()
                ? truncateSetupText("Required: provider, models, budget, prompt", promptPanelWidth())
                : "Required: provider, models, budget, prompt · optional: start, tui, memory, permissions, package"}
            </text>
            <text fg={complete() ? theme.success : theme.textMuted} wrapMode="none" onMouseDown={() => void finish()}>
              {complete() ? "Finish setup" : "Setup incomplete"}
            </text>
          </box>
        </box>
      </box>
    </CommandDeck>
  )
}

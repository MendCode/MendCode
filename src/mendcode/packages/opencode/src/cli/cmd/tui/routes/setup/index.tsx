import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { routeReturnTarget, useRoute, useRouteData, type SetupStepID } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { createDialogProviderOptions } from "@tui/component/dialog-provider"
import { useLocal } from "@tui/context/local"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { useMendTuiProfile } from "@tui/context/mend"
import { setupReadiness, aiStatus, providerAuthStatus } from "@/mend/runtime/readiness"
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
import { packageMetadata, packageMetadataSet, syncGlobalPrimaryAgentModels } from "@/mend/config/project"
import { applyRuntimePack } from "@/mend/runtime/pack"
import { listMendPackages } from "@/mend/runtime/packages"
import { mendTuiCapabilityVersion, visibleCustomizationCapabilities } from "@/mend/tui/capabilities"
import { listActiveCustomizations } from "@/mend/tui/customization-state"
import { applyTuiPreset, readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import type { MendPromptChromePreset } from "@/mend/tui/prompt-chrome"
import {
  dismissSetup,
  isSetupComplete,
  markSetupStepComplete,
  openSetupState,
  setSetupCurrentStep,
  setupSteps,
} from "@/mend/setup/state"
import { SetupRail } from "./setup-rail"

const baseModelRoleOrder = [
  "default",
  "build",
  "plan",
  "review",
  "subagent",
  "small",
  "title",
  "compaction",
  "summary",
  "memoryExtractor",
  "permissionReviewer",
] as const
type SetupModelRole = string
const primaryModelRoles = ["default", "build", "plan", "review"] as const
const internalModelRoles = ["subagent", "small", "title", "compaction", "summary", "memoryExtractor", "permissionReviewer"] as const
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
const roleDescriptions: Record<string, string> = {
  default: "Fallback chat model and generated config model.",
  build: "Model used when the TUI is in build mode.",
  plan: "Model used when the TUI is in plan mode.",
  review: "Review/checking role for future and projected role routing.",
  subagent: "Default model for background subagent task sessions.",
  small: "Runtime small-model fallback for title generation and lightweight internal work.",
  title: "Hidden runtime agent that generates conversation titles.",
  compaction: "Hidden runtime agent that compacts long context.",
  summary: "Hidden runtime summary agent for session summary metadata.",
  memoryExtractor:
    "Background model that reviews completed turns and proposes only durable memories worth approval.",
  permissionReviewer:
    "Hidden permission reviewer model that quickly checks risky shell permission prompts in Smart Approval.",
}
const roleLabels: Record<string, string> = {
  default: "Default chat",
  build: "Build",
  plan: "Plan",
  review: "Review",
  subagent: "Subagents",
  small: "Small/cheap",
  title: "Chat titles",
  compaction: "Context compaction",
  summary: "Session summaries",
  memoryExtractor: "Memory extractor",
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

function normalizeProductName(value: string) {
  return value.trim() || "MendCode"
}

function presetRole(preset: (typeof modelPresets)[keyof typeof modelPresets]): ModelRole {
  return { providerID: preset.providerID, modelID: preset.modelID, authMode: preset.authMode }
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
  const initialStep = data.step && setupSteps.includes(data.step) ? data.step : "provider"
  const [selected, setSelected] = createSignal<SetupStepID>(initialStep)
  const [refresh, setRefresh] = createSignal(0)
  const reload = () => setRefresh((value) => value + 1)
  const providerOptions = createDialogProviderOptions()

  const [summary] = createResource(refresh, async () => {
    const root = mend.root
    const state = await openSetupState(selected(), root)
    const [setup, ai, auth, models, modelsConfig, budget, prompt, promptPolicies, pkg, packages, permissions] = await Promise.all(
      [
        setupReadiness(root),
        aiStatus(root),
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
    return { state, setup, ai, auth, models, modelsConfig, budget, prompt, promptPolicies, pkg, packages, memory, memoryExtractorAuth, permissions }
  })

  const setupSummary = createMemo(() => summary.latest ?? summary())
  const narrow = createMemo(() => dimensions().width < 110)
  const current = createMemo(() => setupSummary()?.state.currentStep || selected())
  const active = createMemo(() => selected() || current())
  const complete = createMemo(() => {
    const state = setupSummary()?.state
    return state ? isSetupComplete(state) : false
  })
  const promptPanelWidth = createMemo(() => Math.max(56, dimensions().width - (narrow() ? 12 : 44)))
  const connectedProviderIDs = createMemo(() =>
    sync.data.provider_next.connected.filter((providerID) => providerID !== "opencode"),
  )
  const connectedProviderNames = createMemo(() =>
    connectedProviderIDs().map(
      (providerID) => sync.data.provider.find((provider) => provider.id === providerID)?.name ?? providerID,
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
    const auth = setupSummary()?.auth as any
    dialog.replace(() => (
      <DialogSelect
        title="Connect a provider"
        current={currentProviderID()}
        options={providerOptions().map((option) => ({
          ...option,
          gutter: option.value === currentProviderID() ? undefined : option.gutter,
          onSelect: async (activeDialog) => {
            if (!(auth?.mendRunReady && auth?.providerID === option.value)) {
              await option.onSelect?.()
            }
            await mark("provider")
            reload()
            toast.show({ variant: "success", message: "Provider step accepted.", duration: 3000 })
          },
        }))}
      />
    ))
  }

  const setupModelRoles = createMemo<SetupModelRole[]>(() => {
    const agentRoles = sync.data.agent
      .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
      .map((agent) => agent.name)
      .filter((name) => name !== "default")
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
    const preset = Object.values(modelPresets).find(
      (item) => item.providerID === providerID && item.modelID === modelID,
    )
    if (preset?.authMode) return preset.authMode
    return null
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

    for (const provider of sync.data.provider
      .filter((item) => item.id !== "opencode")
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      for (const [modelID, model] of Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))) {
        if (model.status === "deprecated") continue
        options.push({
          title: model.name ?? modelID,
          value: { providerID: provider.id, modelID },
          category: provider.name,
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

  const chooseModelRoleMenu = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Model Roles"
        options={setupModelRoles().map((role) => ({
          title: roleLabel(role),
          value: role,
          category: roleCategory(role),
          description: roleDescriptions[role] || "Additional primary agent role.",
          footer: roleLabels[role] ? `role id: ${role}` : undefined,
          onSelect: () => chooseModelRole(role),
        }))}
      />
    ))
  }

  const chooseBudget = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Budget Policy"
        options={[
          {
            title: "Set USD limits",
            value: "custom",
            category: "Budget",
            description: "Choose your own warn and stop thresholds. Blank means no limit.",
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
                  { warnUsd, stopUsd, expensiveModelRequiresConfirm: current?.expensiveModelRequiresConfirm !== false },
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
        current={current?.enabled ? "enabled" : "disabled"}
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
        description: "Use the configured reviewer model only for risky shell/script/delete prompts.",
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

  const choosePackageMetadata = async () => {
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
                description: "Use the MendBug mascot as the home logo and compact activity feedback.",
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
    const logoSize =
      identityMode === "mascot"
        ? await new Promise<"compact" | "default" | "large" | null>((resolve) => {
            dialog.replace(
              () => (
                <DialogSelect
                  title="Home ASCII size"
                  current={current.surfaces.homeLogo?.size || "default"}
                  renderFilter={false}
                  options={[
                    {
                      title: "Compact",
                      value: "compact",
                      category: "Home",
                      description: "Small MendBug for tight terminal windows.",
                      onSelect: async () => resolve("compact"),
                    },
                    {
                      title: "Default",
                      value: "default",
                      category: "Home",
                      description: "Larger default MendBug identity.",
                      onSelect: async () => resolve("default"),
                    },
                    {
                      title: "Large",
                      value: "large",
                      category: "Home",
                      description: "Big MendBug for spacious home screens.",
                      onSelect: async () => resolve("large"),
                    },
                  ]}
                />
              ),
              () => resolve(null),
            )
          })
        : current.surfaces.homeLogo?.size || "default"
    if (logoSize === null) return
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
    const rightPanel = await new Promise<"actions" | "agentManager" | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="Home activity panel"
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
              homeLogo: { ...(current.surfaces.homeLogo || {}), size: logoSize },
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
  const currentProviderID = createMemo(
    () => auth()?.providerID || activeRuntimeProviderID() || connectedProviderIDs()[0] || undefined,
  )
  const providerReady = createMemo(() => {
    const status = auth()
    if (status?.providerID) return status.mendRunReady === true
    return connectedProviderIDs().length > 0
  })
  const providerStatusText = createMemo(() => {
    if (auth()?.mendRunReady) return "ready"
    if (auth()?.providerID) return "auth blocked"
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
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text}>MendCode Setup</text>
        <text fg={theme.textMuted}>j/k move · enter configure · esc leave</text>
      </box>
      <box height={1} />
      <box flexGrow={1} minHeight={0} flexDirection={narrow() ? "column" : "row"} gap={2}>
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
          borderColor={theme.border}
          borderStyle="single"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
        >
          <Show when={setupSummary()} fallback={<text fg={theme.textMuted}>Loading setup state...</text>}>
            <Switch>
              <Match when={active() === "provider"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Provider</text>
                  <text>Provider: {providerLabel()}</text>
                  <text>
                    Auth: {providerStatusText()} · {auth()?.authMode || "not pinned in project config"}
                  </text>
                  <Show when={!auth()?.providerID && connectedProviderNames().length > 0}>
                    <text fg={theme.textMuted}>
                      Runtime already has stored auth for {connectedProviderNames().join(", ")}, but no global default
                      provider/model is pinned in `~/.mendcode/models.yaml`.
                    </text>
                  </Show>
                  <Show when={!narrow()}>
                    <text fg={theme.textMuted}>
                      Enter opens the full provider picker. Configure auth here, then choose runtime models in the
                      Models step.
                    </text>
                  </Show>
                </box>
              </Match>
              <Match when={active() === "models"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Models</text>
                  <text fg={theme.textMuted}>
                    Pick the main models first. Background helpers can use cheaper models.
                  </text>
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
                  <text fg={theme.textMuted}>Enter opens all model roles. Click any visible row to edit it.</text>
                </box>
              </Match>
              <Match when={active() === "budget"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Budget</text>
                  <text>Warn USD: {budget()?.warnUsd ?? "no limit"}</text>
                  <text>Stop USD: {budget()?.stopUsd ?? "no limit"}</text>
                  <text>
                    Expensive model confirmation: {budget()?.expensiveModelRequiresConfirm === false ? "off" : "on"}
                  </text>
                  <text fg={theme.textMuted}>
                    Subscription OAuth can count tokens but cannot enforce API-priced USD spend.
                  </text>
                  <text fg={theme.textMuted}>
                    API-key priced models can warn/stop by USD thresholds before provider calls.
                  </text>
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
                </box>
              </Match>
              <Match when={active() === "package"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Package Metadata</text>
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
                  <text>Snapshot: mend-package.json + .mendcode/runtime-pack.json</text>
                  <text fg={theme.textMuted}>
                    This metadata feeds generated `mend-package.json`, runtime-pack snapshots, and registry previews.
                  </text>
                  <text fg={theme.textMuted}>
                    Enter edits metadata and updates the local package snapshot. Ctrl+P Packages opens the artifact checklist.
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
                  <text fg={theme.textMuted}>
                    Mascot mode uses MendBug by default and can be overridden from global TUI config.
                  </text>
                  <text fg={theme.textMuted}>
                    Setup-owned or setup-visible surfaces: {setupVisibleCapabilities.map((item) => item.id).join(", ")}
                  </text>
                </box>
              </Match>
              <Match when={active() === "memory"}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.primary}>Memory</text>
                  <text>Enabled: {setupSummary()?.memory.enabled ? "yes" : "no"}</text>
                  <text>Input memory: {setupSummary()?.memory.use ? "on" : "off"}</text>
                  <text>Memory learning: {setupSummary()?.memory.generate ? "on" : "off"} · {memoryLearningStatus()}</text>
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
                  <text>Consolidation model: {setupSummary()?.memory.consolidatorRole || "none"} · no background spend</text>
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
                  <text>Smart trigger: risky shell/script/delete prompts only</text>
                  <text>
                    Permission reviewer model:{" "}
                    {modelLabel(modelRole(setupSummary()?.permissions.reviewerRole || "permissionReviewer"))}
                  </text>
                  <text fg={theme.textMuted}>
                    Smart Approval uses the reviewer model for fast allow/reject/ask decisions; non-risky permission
                    prompts still use the normal prompt.
                  </text>
                  <text fg={theme.textMuted}>
                    Full Access is the renamed auto-accept mode for the TUI session. It does not change OS sandboxing by
                    itself.
                  </text>
                  <text fg={theme.textMuted}>Enter changes the global default in your MendCode config.</text>
                </box>
              </Match>
            </Switch>
          </Show>
          <box flexGrow={1} />
          <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={theme.textMuted}>
              Required: provider, models, budget, prompt · optional: package, tui, memory, permissions
            </text>
            <text fg={complete() ? theme.success : theme.textMuted} onMouseDown={() => void finish()}>
              Finish setup
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

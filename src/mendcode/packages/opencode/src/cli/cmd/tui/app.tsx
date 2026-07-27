import { render, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import * as Selection from "@tui/util/selection"
import { createCliRenderer, MouseButton, type CliRendererConfig } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
  For,
  on,
  type JSX,
} from "solid-js"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { Flag } from "@mendcode/core/flag/flag"
import semver from "semver"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { ErrorComponent } from "@tui/component/error-component"
import { PluginRouteMissing } from "@tui/component/plugin-route-missing"
import { ProjectProvider, useProject } from "@tui/context/project"
import { EditorContextProvider } from "@tui/context/editor"
import { useEvent } from "@tui/context/event"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { StartupLoading, startupLoadingText } from "@tui/component/startup-loading"
import { FirstRunIntro } from "@tui/component/first-run-intro"
import { SyncProvider, useSync } from "@tui/context/sync"
import { SyncProviderV2 } from "@tui/context/sync-v2"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogModel } from "@tui/component/dialog-model"
import { useConnected } from "@tui/component/use-connected"
import { DialogMcp } from "@tui/component/dialog-mcp"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogThemeList } from "@tui/component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { CommandProvider, useCommandDialog } from "@tui/component/dialog-command"
import { DialogAgent } from "@tui/component/dialog-agent"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { DialogConsoleOrg } from "@tui/component/dialog-console-org"
import { KeybindProvider, useKeybind } from "@tui/context/keybind"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { Setup } from "@tui/routes/setup"
import { Stats } from "@tui/routes/stats"
import { Memory } from "@tui/routes/memory"
import { Changes } from "@tui/routes/changes"
import { Loops } from "@tui/routes/loops"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogAlert } from "./ui/dialog-alert"
import { DialogConfirm } from "./ui/dialog-confirm"
import { DialogCustomization, type TuiCustomizationAction } from "@tui/component/dialog-customization"
import { showDialogObject } from "./ui/dialog-object"
import { DialogPrompt } from "./ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "./ui/dialog-select"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Session as SessionApi } from "@/session/session"
import { TuiEvent } from "./event"
import { KVProvider, useKV } from "./context/kv"
import { Provider } from "@/provider/provider"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig } from "./context/tui-config"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { createTuiApi } from "@/cli/cmd/tui/plugin/api"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import type { RouteMap } from "@/cli/cmd/tui/plugin/api"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { Locale } from "@/util/locale"
import { backgroundTaskToast } from "@tui/util/background-task-notification"

import type { EventSource, SDKConnectionRefresh } from "./context/sdk"
import { DialogVariant } from "./component/dialog-variant"
import { MendTuiProfileProvider, useMendTuiProfile } from "./context/mend"
import type { MendTuiProfile } from "@/mend/profile"
import { pathToFileURL } from "url"
import { mendStatusSummary } from "@/mend/commands/status"
import {
  activateMflow,
  deactivateMflow,
  mflowLocalRelayGuide,
  mflowControlStatus,
  removeMflowConfig,
  scanMflowRelays,
  startMflowDaemon,
  stopMflowDaemon,
  type MflowRelayMode,
} from "@/mend/config/mflow"
import { activateTsm, deactivateTsm, removeTsm, setupTsm, tsmPlan, tsmStatus } from "@/mend/config/tsm"
import {
  worktreeAdopt,
  worktreeCreate,
  worktreeOpen,
  worktreeRemove,
  worktreeReset,
  worktreeStatus,
} from "@/mend/config/worktree"
import { mendTuiCapabilityVersion, visibleCustomizationCapabilities } from "@/mend/tui/capabilities"
import {
  applyRuntimePack,
  deleteLocalRuntimePack,
  formatRuntimePackPlan,
  globalRuntimePackAuthorRoot,
  prepareGlobalRuntimePackAuthorRoot,
  runtimePackArtifactCandidates,
  runtimePackPlan,
  type RuntimePackSelection,
} from "@/mend/runtime/pack"
import { packageMetadata, packageMetadataSet, syncProject } from "@/mend/config/project"
import { cyclePromptMode, writePromptMode, type MendPromptMode } from "@/mend/prompt/mode"
import { readActiveTuiProfile, writeActiveTuiProfile } from "@/mend/tui/profile-actions"
import {
  DEFAULT_MEND_TUI_CUSTOMIZATION,
  readMendTuiCustomization,
  resolveMendTerminalTitle,
  writeMendTuiCustomization,
} from "@/mend/tui/customization"
import { setupReadiness } from "@/mend/runtime/readiness"
import { isSetupComplete, readSetupState } from "@/mend/setup/state"
import {
  runtimeRegistryAdd,
  runtimeRegistryInstallPack,
  runtimeRegistryRemove,
  runtimeRegistrySearch,
  runtimeRegistryShow,
  runtimeRegistryStatus,
} from "@/mend/runtime/registry"
import type { RegistryMarketplacePackManifest } from "@/mend/runtime/registry/marketplace"
import {
  disableAllMendPackages,
  listMendPackages,
  removeMendPackage,
  setMendPackageEnabled,
} from "@/mend/runtime/packages"
import { resolveProjectMemoryRoot, writeProjectMemoryConfig, type MemoryConfig } from "@/mend/memory/config"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "@/mend/config/permissions"
import { initialTuiPluginReady, themeModeWaitMs, tuiFastBootEnabled } from "@/cli/cmd/tui/util/fast-boot"
import { FIRST_RUN_INTRO_SEEN_KEY, shouldShowFirstRunIntro } from "@/cli/cmd/tui/util/first-run-intro"
import {
  appendMemoryEntry,
  deleteMemoryEntry,
  memoryStatus,
  readMemoryEntries,
  updateMemoryEntry,
  type MemoryEntry,
} from "@/mend/memory/store"
import {
  applyMemoryProposal,
  listMemoryProposals,
  rejectMemoryProposal,
  updateMemoryProposal,
  type MemoryProposal,
} from "@/mend/memory/proposals"
import type { MendPromptChromePreset } from "@/mend/tui/prompt-chrome"
import { defaultPromptStatus, type MendPromptStatusBuiltin, type MendPromptStatusItem } from "@/mend/tui/prompt-status"
import {
  messageRendererForPresentationProfile,
  presentationProfileTitle,
  resolveTuiPresentation,
  type MendCompactionArcade,
  type MendCompactionStyle,
  type MendMessageRenderer,
  type MendPresentationProfile,
} from "@/mend/tui/presentation"
import { defaultHomeMascot } from "@/mend/tui/mascot"
import {
  clearMendOverlay,
  focusMendOverlay,
  listMendOverlays,
  mendOverlayRenderContext,
  readFocusedMendOverlayID,
  type MendOverlayEntry,
} from "@/mend/tui/overlays"
import { formatDiagnostics, type DiagnosticsSnapshot } from "@/util/process-memory"

function rendererConfig(_config: TuiConfig.Info): CliRendererConfig {
  const mouseEnabled = !Flag.OPENCODE_DISABLE_MOUSE && (_config.mouse ?? true)

  return {
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: mouseEnabled,
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      onCopySelection: (text) => {
        Clipboard.copy(text).catch((error) => {
          console.error(`Failed to copy console selection to clipboard: ${error}`)
        })
      },
    },
  }
}

function canStartInteractiveTui() {
  return process.stdin.isTTY && (process.stdout.isTTY || process.stderr.isTTY)
}

function releaseTerminalInputModes() {
  const out = process.stdout.isTTY ? process.stdout : process.stderr.isTTY ? process.stderr : undefined
  out?.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l")
  const stdin = process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => unknown }
  if (process.stdin.isTTY && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(false)
    } catch {
      // Best-effort terminal recovery before yielding control to the parent shell.
    }
  }
}

function permissionModeTitle(mode: PermissionMode) {
  if (mode === "full_access") return "Full Access"
  if (mode === "smart") return "Smart Approval"
  return "Require approval"
}

function errorMessage(error: unknown) {
  const formatted = FormatError(error)
  if (formatted !== undefined) return formatted
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return FormatUnknownError(error)
}

function overlaySize(value: MendOverlayEntry["width"], total: number, fallback: number) {
  if (typeof value === "number") return Math.max(1, Math.min(total, value))
  if (typeof value === "string" && value.endsWith("%"))
    return Math.max(1, Math.min(total, Math.floor((total * Number(value.slice(0, -1))) / 100)))
  return Math.max(1, Math.min(total, fallback))
}

function overlayFrame(item: MendOverlayEntry, dimensions: { width: number; height: number }) {
  const margin = item.margin
  const availableWidth = Math.max(1, dimensions.width - margin.left - margin.right)
  const availableHeight = Math.max(1, dimensions.height - margin.top - margin.bottom)
  const width = overlaySize(item.width, availableWidth, Math.min(90, availableWidth))
  const maxHeight = overlaySize(item.maxHeight, availableHeight, availableHeight)
  const height = Math.min(overlaySize(item.height, availableHeight, Math.min(12, availableHeight)), maxHeight)
  const centerLeft = margin.left + Math.max(0, Math.floor((availableWidth - width) / 2))
  const centerTop = margin.top + Math.max(0, Math.floor((availableHeight - height) / 2))
  return {
    width,
    height,
    left: item.anchor.endsWith("right")
      ? dimensions.width - margin.right - width
      : item.anchor.endsWith("left")
        ? margin.left
        : centerLeft,
    top: item.anchor.startsWith("bottom")
      ? dimensions.height - margin.bottom - height
      : item.anchor.startsWith("top")
        ? margin.top
        : centerTop,
  }
}

function RenderMendOverlay(props: { item: MendOverlayEntry; dimensions: { width: number; height: number } }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const frame = createMemo(() => overlayFrame(props.item, props.dimensions))
  const focused = createMemo(() => readFocusedMendOverlayID() === props.item.id)
  const rendered = createMemo(() => props.item.render(mendOverlayRenderContext(props.item)))
  const primitive = createMemo(() => {
    const value = rendered()
    if (typeof value === "string" || typeof value === "number") return String(value)
    if (typeof value === "boolean") return value ? "true" : ""
    return undefined
  })
  const fallback = (error: unknown) => (
    <box width="100%" height="100%" paddingLeft={1} paddingRight={1} overflow="hidden">
      <text fg={theme.error} wrapMode="word">
        Overlay error · {errorMessage(error)}
      </text>
    </box>
  )
  return (
    <box
      position="absolute"
      zIndex={2750}
      left={frame().left}
      top={frame().top}
      width={frame().width}
      height={frame().height}
      border={props.item.modal || focused() ? ["top", "bottom", "left", "right"] : ["left"]}
      borderColor={focused() ? theme.borderActive : theme.border}
      backgroundColor={theme.backgroundPanel}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={props.item.title ? 1 : 0}
      paddingBottom={0}
      overflow="hidden"
      onMouseDown={(event) => {
        if (props.item.nonCapturing) return
        focusMendOverlay(props.item.id)
        event.target?.focus()
      }}
      onKeyDown={(event) => {
        if (props.item.nonCapturing) return
        if (event.name !== "escape") return
        if (renderer.getSelection()?.getSelectedText()) return
        clearMendOverlay(props.item.id)
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <Show when={props.item.title}>
        {(title) => (
          <text fg={theme.textMuted} wrapMode="none">
            {title()}
          </text>
        )}
      </Show>
      <ErrorBoundary fallback={fallback}>
        <Show when={primitive() !== undefined} fallback={rendered() as JSX.Element}>
          <text fg={theme.text} wrapMode="word">
            {primitive()}
          </text>
        </Show>
      </ErrorBoundary>
    </box>
  )
}

function MendOverlayHost(props: { dimensions: { width: number; height: number } }) {
  return (
    <For each={listMendOverlays()}>{(item) => <RenderMendOverlay item={item} dimensions={props.dimensions} />}</For>
  )
}

function cleanMarketplaceVersion(version: string | undefined) {
  if (!version || version === "0") return "unversioned"
  return version
}

function OptionalSyncProviderV2(props: { children: JSX.Element }) {
  if (!Flag.OPENCODE_EXPERIMENTAL_SESSION_V2_DEBUG) return props.children
  return <SyncProviderV2>{props.children}</SyncProviderV2>
}

function marketplaceRuntimeSummary(pack: RegistryMarketplacePackManifest) {
  const runtime = pack.runtime || {}
  const items = [
    ["commands", runtime.commands],
    ["agents", runtime.agents],
    ["modes", runtime.modes],
    ["skills", runtime.skills],
    ["plugins", runtime.plugins],
    ["tools", runtime.tools],
    ["pages", runtime.pages],
    ["widgets", runtime.widgets],
    ["prompts", runtime.prompts],
    ["MCP", runtime.mcpFiles],
    ["extensions", runtime.extensions],
  ]
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([label, count]) => `${count} ${label}`)
  return items.length ? items.join(" · ") : "No runtime artifacts advertised"
}

function marketplaceShortSummary(pack: RegistryMarketplacePackManifest) {
  return Locale.truncate(marketplaceRuntimeSummary(pack), 90)
}

function marketplaceSourceIDFromURL(value: string) {
  const clean = value.trim().replace(/\.git$/, "")
  const last = clean.split(/[/:]/).filter(Boolean).at(-1) || "package-source"
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `url-${slug || "package-source"}`.slice(0, 64)
}

function isPublicGitHubMarketplaceURL(value: string) {
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

function marketplaceInstallBadge(packID: string, installed: Awaited<ReturnType<typeof listMendPackages>>["installed"]) {
  const found = installed.find((item) => item.id === packID)
  if (!found) return null
  return found.enabled ? "active" : "installed"
}

function marketplaceBadgeTitle(title: string, badge?: string | null) {
  return `${badge ? `[${badge}] ` : ""}${title}`
}

function marketplaceSearchText(parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" ")
}

function marketplaceStatusCategory(input: { badge?: string | null; sourceID?: string; channel?: string | null }) {
  const state = input.badge === "active" ? "Active" : input.badge === "installed" ? "Installed" : undefined
  const source = input.channel || input.sourceID
  return [state, source].filter(Boolean).join(" · ") || "Packages"
}

function marketplaceSourceSafetyLines(input: {
  sourceID: string
  sourceType?: string
  url?: string | null
  digest?: { algorithm: "sha256"; value: string }
  signature?: { algorithm: "sha256"; value: string }
}) {
  if (input.sourceID === "official" || input.sourceID === "local") return []
  return [
    "Security preview:",
    `- Source: ${input.url || input.sourceID}`,
    `- Type: ${input.sourceType || "unknown"}`,
    `- Digest: ${input.digest ? `${input.digest.algorithm}:${input.digest.value.slice(0, 12)}...` : "not pinned"}`,
    `- Signature: ${input.signature ? `${input.signature.algorithm}:${input.signature.value.slice(0, 12)}...` : "not signed"}`,
    "- Trust only repos you expect to run MendCode package content from.",
    "- Packages may add commands, skills, plugins, widgets, pages, scripts, and MCP config.",
    "- MendCode copies allowlisted package files only; local sessions, auth, runs, cache, and customizations stay untouched.",
  ]
}

function marketplacePackDetails(pack: RegistryMarketplacePackManifest, sourceID: string) {
  const lines = [
    `Name: ${pack.title || pack.id}`,
    `ID: ${pack.id}`,
    `Version: ${cleanMarketplaceVersion(pack.version)}`,
    `Source: ${sourceID}${pack.source?.type ? ` (${pack.source.type})` : ""}`,
    pack.channel ? `Channel: ${pack.channel}` : null,
    pack.description ? `Description: ${pack.description}` : null,
    "",
    "Runtime contents:",
    `- ${marketplaceRuntimeSummary(pack)}`,
    pack.runtime?.focusDefault ? `- Focus: ${pack.runtime.focusDefault}` : null,
    "",
    "Compatibility:",
    `- MendCode: ${pack.compatibility?.mendcode || "not specified"}`,
    `- Runtime pack: ${pack.compatibility?.runtimePack || "not specified"}`,
    "",
    "Trust:",
    `- Digest: ${pack.digest ? `${pack.digest.algorithm}:${pack.digest.value.slice(0, 12)}...` : "not pinned"}`,
    `- Signature: ${pack.signature ? `${pack.signature.algorithm}:${pack.signature.value.slice(0, 12)}...` : "not signed"}`,
  ]
  return lines.filter((line): line is string => line !== null).join("\n")
}

function PluginRouteError(props: { id: string; error: unknown }) {
  const { theme } = useTheme()
  const message = props.error instanceof Error ? props.error.message : String(props.error)

  onMount(() => {
    console.error("[tui.plugin.route] render error", {
      route: props.id,
      message,
    })
  })

  return (
    <box width="100%" height="100%" paddingLeft={2} paddingRight={2} paddingTop={1} overflow="hidden">
      <box flexDirection="column" gap={1}>
        <text fg={theme.error}>Plugin route failed: {props.id}</text>
        <text fg={theme.textMuted} wrapMode="word">
          {message}
        </text>
        <text fg={theme.textMuted}>esc or command palette can return to a normal route.</text>
      </box>
    </box>
  )
}

function registryStatusText(status: Awaited<ReturnType<typeof runtimeRegistryStatus>>) {
  const redactionShared = status.redaction?.shared || []
  return [
    `Registry: ${status.ok ? "ready" : "not ready"}`,
    `Registry file: ${status.path}`,
    `State file: ${status.localStatePath}`,
    `Default source: ${status.defaultSource}`,
    `Sources: ${status.enabledEntries}/${status.entries} enabled`,
    `Supported source types: ${status.supportedTypes.join(", ")}`,
    "",
    "Packages:",
    `- Installed: ${status.packages.installed}`,
    `- Enabled: ${status.packages.enabled.join(", ") || "none"}`,
    `- State file: ${status.packages.statePath}`,
    "",
    "Trust:",
    `- Signed entries: ${status.signedEntries}`,
    `- Signature required: ${status.signatureRequiredEntries}`,
    `- Secrets included: ${status.secretsIncluded ? "yes" : "no"}`,
    "",
    "Last apply:",
    status.lastApply ? `- ${status.lastApply.id} at ${status.lastApply.appliedAt}` : "- none",
    "",
    "Shared config paths:",
    ...(redactionShared.length ? redactionShared.slice(0, 12).map((item) => `- ${item}`) : ["- none"]),
    ...(redactionShared.length > 12 ? [`- ...and ${redactionShared.length - 12} more`] : []),
  ].join("\n")
}

type MemoryManagerOption = DialogSelectOption<string> & {
  previewTitle?: string
  previewBody?: string
  previewMeta?: string
}

function MemoryManagerPreview(props: { option: MemoryManagerOption }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const previewHeight = createMemo(() => Math.max(5, Math.min(12, Math.floor(dimensions().height * 0.22))))

  return (
    <box
      borderColor={theme.border}
      borderStyle="single"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.primary}>Preview</text>
      <box flexDirection="column" gap={1} paddingTop={1}>
        <text fg={theme.text} wrapMode="word">
          {props.option.previewTitle || props.option.title}
        </text>
        <Show when={props.option.previewMeta}>
          <text fg={theme.textMuted} wrapMode="word">
            {props.option.previewMeta}
          </text>
        </Show>
        <scrollbox
          maxHeight={previewHeight()}
          minHeight={Math.min(3, previewHeight())}
          scrollbarOptions={{ visible: (props.option.previewBody || props.option.description || "").length > 360 }}
        >
          <text fg={theme.textMuted} wrapMode="word">
            {props.option.previewBody || props.option.description || "No extra details."}
          </text>
        </scrollbox>
      </box>
    </box>
  )
}

export function tui(input: {
  url: string
  args: Args
  config: TuiConfig.Info
  mendProfile: {
    profile: MendTuiProfile
    root: string
    defaultPath: string
    activePath: string
    config?: unknown
  }
  onSnapshot?: () => Promise<string[]>
  onDiagnostics?: () => Promise<DiagnosticsSnapshot>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  reconnect?: {
    refresh?: SDKConnectionRefresh
  }
}) {
  // promise to prevent immediate exit
  // oxlint-disable-next-line no-async-promise-executor -- intentional: async executor used for sequential setup before resolve
  return new Promise<void>(async (resolve) => {
    if (!canStartInteractiveTui()) {
      process.stderr.write(
        "Error: mend TUI requires an interactive terminal. Use `mendcode run` for non-interactive input.\n",
      )
      process.exitCode = 1
      resolve()
      return
    }

    const unguard = win32InstallCtrlCGuard()
    win32DisableProcessedInput()

    const onExit = async () => {
      unguard?.()
      releaseTerminalInputModes()
      resolve()
    }

    const onBeforeExit = async () => {
      await TuiPluginRuntime.dispose()
    }

    const fastBoot = tuiFastBootEnabled()
    const renderer = await createCliRenderer(rendererConfig(input.config))
    // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
    void renderer.getPalette({ size: 16 }).catch(() => undefined)
    const mode = (await renderer.waitForThemeMode(themeModeWaitMs(fastBoot))) ?? "dark"

    await render(() => {
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <ErrorComponent error={error} reset={reset} onBeforeExit={onBeforeExit} onExit={onExit} mode={mode} />
          )}
        >
          <ArgsProvider {...input.args}>
            <ExitProvider onBeforeExit={onBeforeExit} onExit={onExit}>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider
                    initialRoute={
                      input.args.continue
                        ? {
                            type: "session",
                            sessionID: "dummy",
                          }
                        : input.args.initialMessage
                          ? {
                              type: "home",
                              prompt: { input: input.args.initialMessage, parts: [] },
                            }
                          : undefined
                    }
                  >
                    <TuiConfigProvider config={input.config}>
                      <MendTuiProfileProvider {...input.mendProfile} config={input.config}>
                        <SDKProvider
                          url={input.url}
                          directory={input.directory}
                          fetch={input.fetch}
                          headers={input.headers}
                          events={input.events}
                          reconnect={input.reconnect}
                        >
                          <ProjectProvider>
                            <SyncProvider>
                              <OptionalSyncProviderV2>
                                <ThemeProvider mode={mode}>
                                  <LocalProvider>
                                    <KeybindProvider>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <CommandProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <PromptRefProvider>
                                                  <EditorContextProvider>
                                                    <App
                                                      onSnapshot={input.onSnapshot}
                                                      onDiagnostics={input.onDiagnostics}
                                                    />
                                                  </EditorContextProvider>
                                                </PromptRefProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </CommandProvider>
                                        </DialogProvider>
                                      </PromptStashProvider>
                                    </KeybindProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </OptionalSyncProviderV2>
                            </SyncProvider>
                          </ProjectProvider>
                        </SDKProvider>
                      </MendTuiProfileProvider>
                    </TuiConfigProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ExitProvider>
          </ArgsProvider>
        </ErrorBoundary>
      )
    }, renderer)
  })
}

function App(props: { onSnapshot?: () => Promise<string[]>; onDiagnostics?: () => Promise<DiagnosticsSnapshot> }) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()
  const keybind = useKeybind()
  const event = useEvent()
  const mend = useMendTuiProfile()
  const project = useProject()
  const productName = () => mend.profile.identity.productName
  const normalizeProductName = (value: string) => value.trim().replace(/\s+/g, " ") || "MendCode"
  const docsPath = () => pathToFileURL(`${mend.root}/docs/tui-personalization.md`).href
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode, locked, lock, unlock } = themeState
  const sync = useSync()
  const exit = useExit()
  const promptRef = usePromptRef()
  const [firstRunIntroVisible, setFirstRunIntroVisible] = createSignal(false)
  const [firstRunIntroRun, setFirstRunIntroRun] = createSignal(0)
  const completeFirstRunIntro = () => {
    if (!firstRunIntroVisible()) return
    setFirstRunIntroVisible(false)
    kv.set(FIRST_RUN_INTRO_SEEN_KEY, true)
  }
  const replayFirstRunIntro = () => {
    dialog.clear()
    setFirstRunIntroRun((value) => value + 1)
    setFirstRunIntroVisible(true)
  }

  useKeyboard((evt) => {
    if (!firstRunIntroVisible() || evt.defaultPrevented) return
    if (keybind.match("app_exit", evt)) {
      evt.preventDefault()
      evt.stopPropagation()
      void exit()
      return
    }
    evt.preventDefault()
    evt.stopPropagation()
    completeFirstRunIntro()
  })

  const routes: RouteMap = new Map()
  const [routeRev, setRouteRev] = createSignal(0)
  const [homeRevision, setHomeRevision] = createSignal(0)
  const promptRouteActive = createMemo(() => route.data.type === "home" || route.data.type === "session")
  const routeView = (name: string) => {
    routeRev()
    return routes.get(name)?.at(-1)?.render
  }

  const api = createTuiApi({
    command,
    tuiConfig,
    dialog,
    keybind,
    kv,
    route,
    routes,
    bump: () => setRouteRev((x) => x + 1),
    event,
    sdk,
    sync,
    theme: themeState,
    toast,
    renderer,
  })
  const fastBoot = tuiFastBootEnabled()
  const [ready, setReady] = createSignal(initialTuiPluginReady(fastBoot))
  const [pluginsReady, setPluginsReady] = createSignal(false)
  onMount(() => {
    const loadPlugins = () => {
      void TuiPluginRuntime.init({
        api,
        config: tuiConfig,
      })
        .catch((error) => {
          console.error("Failed to load TUI plugins", error)
        })
        .finally(() => {
          setPluginsReady(true)
          setReady(true)
        })
    }

    if (!fastBoot) {
      loadPlugins()
      return
    }

    const pluginTimer = setTimeout(loadPlugins, 0)
    if (typeof pluginTimer === "object") pluginTimer.unref()
  })

  useKeyboard((evt) => {
    if (evt.defaultPrevented || dialog.stack.length > 0) return
    if (!evt.ctrl || evt.name !== "s") return
    evt.preventDefault()
    evt.stopPropagation()
    command.trigger("session.list")
  })

  useKeyboard((evt) => {
    if (evt.defaultPrevented || dialog.stack.length > 0) return
    if (!promptRouteActive()) return
    if (!keybind.match("agent_mode_picker", evt)) return
    evt.preventDefault()
    evt.stopPropagation()
    showAgentModePicker()
  })

  async function showDefaultPermissionMode() {
    const permissions = await readPermissionsConfig()
    dialog.replace(() => (
      <DialogSelect
        title="Default approval mode"
        current={permissions.mode}
        options={[
          {
            title: "Require approval",
            value: "approval",
            description: "Default future sessions to manual permission prompts.",
          },
          {
            title: "Smart Approval",
            value: "smart",
            description: "Default future sessions to model-reviewed risky shell prompts.",
          },
          {
            title: "Full Access",
            value: "full_access",
            description: "Default future sessions to automatically approve permission prompts.",
          },
        ]}
        onSelect={(option) => {
          if (option.value !== "approval" && option.value !== "smart" && option.value !== "full_access") return
          const mode: PermissionMode = option.value
          void writePermissionsConfig({ mode })
            .then(() => {
              toast.show({
                message: `Default approval mode saved: ${permissionModeTitle(mode)}.`,
                variant: "success",
                duration: 4000,
              })
              dialog.clear()
            })
            .catch((error) => {
              toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
            })
        }}
      />
    ))
  }

  useKeyboard((evt) => {
    if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
    const sel = renderer.getSelection()
    if (!sel) return

    // Windows Terminal-like behavior:
    // - Ctrl+C copies and dismisses selection
    // - Esc dismisses selection
    // - Most other key input dismisses selection and is passed through
    if (evt.ctrl && evt.name === "c") {
      if (!Selection.copy(renderer, toast)) {
        renderer.clearSelection()
        return
      }

      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    if (evt.name === "escape") {
      renderer.clearSelection()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    const focus = renderer.currentFocusedRenderable
    if (focus?.hasSelection() && sel.selectedRenderables.includes(focus)) {
      return
    }

    renderer.clearSelection()
  })

  createEffect(() => {
    if (promptRouteActive()) return
    promptRef.current?.blur()
    const focus = renderer.currentFocusedRenderable
    if (!focus || focus.isDestroyed) return
    focus.blur()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const tuiCustomization = createMemo(() => readMendTuiCustomization((key, fallback) => kv.get(key, fallback)))
  const terminalTitleEnabled = createMemo(() => tuiCustomization().terminalTitle)
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get(
      "paste_summary_enabled",
      sync.data.config.experimental?.disable_paste_summary === undefined
        ? mend.profile.presentation.input.pasteSummary
        : !sync.data.config.experimental.disable_paste_summary,
    ),
  )

  // Update terminal window title based on the live customization contract.
  createEffect(() => {
    const customization = tuiCustomization()
    if (Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return
    if (!customization.terminalTitle) {
      renderer.setTerminalTitle("")
      return
    }

    const session = route.data.type === "session" ? sync.session.get(route.data.sessionID) : undefined
    const routeLabel =
      route.data.type === "home"
        ? "Home"
        : route.data.type === "session"
          ? "Session"
          : route.data.type === "plugin"
            ? route.data.id
            : route.data.type === "setup"
              ? "Setup"
              : route.data.type === "memory"
                ? "Memory"
                : route.data.type === "changes"
                  ? "Changes"
                  : route.data.type === "loops"
                    ? "Loops"
                    : route.data.type
    const sessionLabel = session && !SessionApi.isDefaultTitle(session.title) ? session.title : routeLabel
    if (
      route.data.type === "home" &&
      customization.terminalTitleTemplate === DEFAULT_MEND_TUI_CUSTOMIZATION.terminalTitleTemplate
    ) {
      renderer.setTerminalTitle(productName())
      return
    }
    renderer.setTerminalTitle(
      resolveMendTerminalTitle({
        template: customization.terminalTitleTemplate,
        product: productName(),
        session: sessionLabel.length > 40 ? sessionLabel.slice(0, 37) + "..." : sessionLabel,
        route: routeLabel,
        path:
          route.data.type === "session"
            ? session?.directory || project.instance.path().directory
            : project.instance.path().directory,
      }),
    )
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Provider.parseModel(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: `Invalid model format: ${args.model}`,
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        void sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: "Failed to fork session", variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    void sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: "Failed to fork session", variant: "error" })
      }
    })
  })

  createEffect(
    on(
      () => sync.status === "complete" && sync.data.provider.length === 0,
      (isEmpty, wasEmpty) => {
        // only trigger when we transition into an empty-provider state
        if (!isEmpty || wasEmpty) return
        dialog.replace(() => <DialogProviderList />)
      },
    ),
  )

  createEffect(() => {
    if (route.data.type !== "setup") return
    command.keybinds(false)
    onCleanup(() => {
      command.keybinds(true)
    })
  })

  let setupRedirectChecked = false
  createEffect(() => {
    if (setupRedirectChecked || !ready() || !pluginsReady() || sync.status === "loading" || !kv.ready) return
    if (route.data.type !== "home") return
    setupRedirectChecked = true
    void Promise.all([readSetupState(mend.root), setupReadiness(mend.root)])
      .then(([state, readiness]) => {
        if (isSetupComplete(state)) return
        if (readiness.aiReady) return
        if (shouldShowFirstRunIntro({
          interactive: true,
          setupComplete: isSetupComplete(state),
          dismissed: Boolean(state.dismissedAt),
          seen: kv.get(FIRST_RUN_INTRO_SEEN_KEY, false) === true,
        })) {
          dialog.clear()
          setFirstRunIntroRun((value) => value + 1)
          setFirstRunIntroVisible(true)
        }
        route.navigate({ type: "setup", step: state.currentStep })
      })
      .catch(toast.error)
  })

  const connected = useConnected()
  const mendCategory = "System"
  const memoryRoot = () =>
    resolveProjectMemoryRoot(project.instance.path().worktree, project.instance.path().directory) || mend.root
  const currentSessionReturn = () =>
    route.data.type === "session" ? ({ type: "session", sessionID: route.data.sessionID } as const) : undefined
  const setupRoute = (step?: "provider" | "models" | "budget") => {
    const returnTo = currentSessionReturn()
    const base = step ? { type: "setup" as const, step } : { type: "setup" as const }
    return returnTo ? { ...base, returnTo } : base
  }
  const statsRoute = (scope: "global" | "project") => {
    const returnTo = currentSessionReturn()
    return returnTo ? { type: "stats" as const, scope, returnTo } : { type: "stats" as const, scope }
  }
  const changesRoute = () => {
    const returnTo = currentSessionReturn()
    return returnTo ? { type: "changes" as const, returnTo } : { type: "changes" as const }
  }
  const loopsRoute = (selectedID?: string) => {
    const returnTo = currentSessionReturn()
    return returnTo ? { type: "loops" as const, selectedID, returnTo } : { type: "loops" as const, selectedID }
  }
  const showMendStatus = async (title = "MendCode Status") => {
    await DialogAlert.show(dialog, title, await mendStatusSummary(mend.root))
  }
  const mflowStatusLine = async () => {
    const status = await mflowControlStatus(mend.root)
    const config = status.config
    const relayLabel =
      config.relayMode === "local"
        ? "Local"
        : config.relayMode === "legacy-public" ||
            (config.relayMode === "public" && config.signaling.includes("mflow-signal.obed0101.deno.net"))
          ? "Legacy public"
          : "Public"
    return {
      status,
      line: `${status.mode} · ${config.relayMode} · ${config.room}`,
      relay: `${relayLabel} · ${config.signaling}`,
      daemon: status.daemon.running ? "daemon running" : "daemon stopped",
      locks: status.locks.checked ? "locks available" : "locks unavailable",
    }
  }
  const mflowDaemonValue = (status: Awaited<ReturnType<typeof mflowControlStatus>>, label: string) => {
    const parsed = status.daemon.output?.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"))?.[1]?.trim()
    if (parsed) return parsed
    if (!status.daemon.checked) return label === "State" ? "not checked" : "unavailable"
    if (!status.daemon.running) return label === "State" ? "not running" : "unavailable"
    return "unknown"
  }
  const showTsmManager = async () => {
    const status = await tsmStatus(mend.root)
    const workspace = status.workspace
    const currentLabel = workspace.isLinkedWorktree
      ? `worktree ${workspace.currentBranch || "detached"}`
      : `base ${workspace.currentBranch || "detached"}`
    dialog.replace(() => (
      <DialogSelect
        title="tsm"
        size="large"
        renderFilter={false}
        current="status"
        options={[
          {
            title: `TSM ${status.lifecycle}`,
            value: "status",
            category: "Status",
            description: `${status.enabled ? "enabled" : "disabled"} · ${status.worktreeCapable ? "worktree capable" : "no worktree capability"}`,
            onSelect: () => {},
          },
          {
            title: `Current ${currentLabel}`,
            value: "workspace",
            category: "Status",
            description: `state at ${workspace.stateRoot}`,
            onSelect: () => void showDialogObject(dialog, "TSM workspace", workspace),
          },
          {
            title: "Show details",
            value: "details",
            category: "Diagnostics",
            description: status.binaryPath || "not installed",
            onSelect: () => void showDialogObject(dialog, "TSM status", status),
          },
          {
            title: "Setup plan",
            value: "plan",
            category: "Actions",
            description: "Preview install/setup commands without running them.",
            onSelect: async () => {
              const plan = await tsmPlan(mend.root)
              await showDialogObject(dialog, "TSM setup plan", plan)
              await showTsmManager()
            },
          },
          {
            title: "Refresh setup plan",
            value: "setup",
            category: "Actions",
            description: "Write MendCode's dry-run TSM plan only.",
            onSelect: async () => {
              await setupTsm(mend.root)
              toast.show({ variant: "success", message: "TSM setup plan refreshed.", duration: 4000 })
              await showTsmManager()
            },
          },
          {
            title: "Activate",
            value: "activate",
            category: "Actions",
            description: "Enable MendCode delegation only if a worktree-capable TSM binary is detected.",
            disabled: !status.binaryPath || !status.worktreeCapable,
            onSelect: async () => {
              await activateTsm(mend.root)
              toast.show({ variant: "success", message: "TSM integration active.", duration: 4000 })
              await showTsmManager()
            },
          },
          {
            title: "Deactivate",
            value: "deactivate",
            category: "Actions",
            description: "Disable delegation without touching TSM sessions or config.",
            disabled: !status.enabled,
            onSelect: async () => {
              await deactivateTsm(mend.root)
              toast.show({ variant: "success", message: "TSM integration disabled.", duration: 4000 })
              await showTsmManager()
            },
          },
          {
            title: "Remove MendCode scaffold",
            value: "remove",
            category: "Actions",
            description: "Delete only MendCode-owned TSM state and plan.",
            onSelect: async () => {
              const confirmed = await DialogConfirm.show(
                dialog,
                "Remove TSM scaffold?",
                "This removes only MendCode's local TSM state and plan. It does not uninstall TSM, kill sessions, or remove worktrees.",
              )
              if (!confirmed) return
              await removeTsm(mend.root)
              toast.show({ variant: "success", message: "TSM scaffold removed.", duration: 4000 })
              await showTsmManager()
            },
          },
        ]}
      />
    ))
  }
  const showWorktreeManager = async () => {
    const status = await worktreeStatus(mend.root)
    const workspace = status.workspace
    const currentLabel = workspace.isLinkedWorktree
      ? `worktree ${workspace.currentBranch || "detached"}`
      : `base ${workspace.currentBranch || "detached"}`
    dialog.replace(() => (
      <DialogSelect
        title="worktrees"
        size="large"
        renderFilter={false}
        current="status"
        options={[
          {
            title: `Current ${currentLabel}`,
            value: "status",
            category: "Status",
            description: workspace.currentPath,
            onSelect: () => {},
          },
          {
            title: `${status.registry.records.length} managed · ${status.registry.external.length} external`,
            value: "registry",
            category: "Status",
            description: `${status.registry.stale.length} stale · ${status.registry.drifted.length} drifted · policy ${status.policy.mode}`,
            onSelect: () => void showDialogObject(dialog, "Worktree registry", status.registry),
          },
          {
            title: "Show status",
            value: "details",
            category: "Diagnostics",
            description: `state at ${workspace.stateRoot}`,
            onSelect: () => void showDialogObject(dialog, "Worktree status", status),
          },
          {
            title: "Preview create",
            value: "create",
            category: "Actions",
            description: "Build a create plan without running git.",
            onSelect: async () => {
              const name = await DialogPrompt.show(dialog, "worktree name", { placeholder: "feature-name" })
              if (!name) return
              const plan = await worktreeCreate([name], mend.root)
              await showDialogObject(dialog, "Worktree create preview", plan.previewText || plan)
              await showWorktreeManager()
            },
          },
          {
            title: "Preview open",
            value: "open",
            category: "Actions",
            description: "Resolve target without opening shells or TSM.",
            onSelect: async () => {
              const target = await DialogPrompt.show(dialog, "worktree target", { placeholder: "id, branch, or path" })
              if (!target) return
              await showDialogObject(dialog, "Worktree open preview", await worktreeOpen([target], mend.root))
              await showWorktreeManager()
            },
          },
          {
            title: "Adopt external",
            value: "adopt",
            category: "Actions",
            description: "Record explicit ownership for an existing Git worktree.",
            onSelect: async () => {
              const target = await DialogPrompt.show(dialog, "worktree to adopt", { placeholder: "path or branch" })
              if (!target) return
              await showDialogObject(dialog, "Worktree adopted", await worktreeAdopt([target], mend.root))
              await showWorktreeManager()
            },
          },
          {
            title: "Preview remove",
            value: "remove",
            category: "Actions",
            description: "Show destructive gate; no git commands run.",
            onSelect: async () => {
              const target = await DialogPrompt.show(dialog, "worktree to remove", {
                placeholder: "id, branch, or path",
              })
              if (!target) return
              const result = await worktreeRemove([target], mend.root)
              await showDialogObject(dialog, "Worktree remove preview", result.previewText || result)
              await showWorktreeManager()
            },
          },
          {
            title: "Preview reset",
            value: "reset",
            category: "Actions",
            description: "Show destructive gate; no reset or clean runs.",
            onSelect: async () => {
              const target = await DialogPrompt.show(dialog, "worktree to reset", {
                placeholder: "id, branch, or path",
              })
              if (!target) return
              const result = await worktreeReset([target], mend.root)
              await showDialogObject(dialog, "Worktree reset preview", result.previewText || result)
              await showWorktreeManager()
            },
          },
        ]}
      />
    ))
  }
  const showMflowDetails = async () => {
    const current = await mflowStatusLine()
    const status = current.status
    const config = status.config
    const dashboard =
      status.daemon.output?.match(/https:\/\/\S+\/dashboard/)?.[0] ?? "https://mflow-signal.obed0101.deno.net/dashboard"
    const locksText = status.locks.output?.trim() || "No lock output."
    const localRelayHelp =
      config.relayMode === "local" && !status.daemon.running
        ? "Local relay is configured but not running; use the start commands from mflow details."
        : undefined
    dialog.replace(() => (
      <DialogSelect
        title="mflow details"
        size="large"
        renderFilter={false}
        current="state"
        options={[
          {
            title: status.mode,
            value: "state",
            category: "State",
            description: `${config.enabled ? "enabled" : "disabled"} · ${status.daemon.running ? "daemon running" : "daemon stopped"}`,
            onSelect: () => {},
          },
          {
            title:
              config.relayMode === "local"
                ? "Local relay"
                : config.relayMode === "legacy-public" || config.signaling.includes("mflow-signal.obed0101.deno.net")
                  ? "Legacy public relay"
                  : "Public relay URL",
            value: "relay",
            category: "Connection",
            description: localRelayHelp ?? config.signaling,
            onSelect: () => {},
          },
          {
            title: config.room,
            value: "room",
            category: "Connection",
            description: `priority ${config.hookPriority} · secret ${status.files.secretStoredLocally ? "stored locally" : "external"}`,
            onSelect: () => {},
          },
          {
            title: mflowDaemonValue(status, "State"),
            value: "daemon",
            category: "Daemon",
            description: status.daemon.running
              ? `${mflowDaemonValue(status, "Peers")} peers · ${mflowDaemonValue(status, "Files")} · ${mflowDaemonValue(status, "Ops/s")} ops/s`
              : status.daemon.output,
            onSelect: () => {},
          },
          {
            title: mflowDaemonValue(status, "Uptime"),
            value: "uptime",
            category: "Daemon",
            description: status.daemon.running
              ? `memory ${mflowDaemonValue(status, "Memory")}`
              : "daemon metrics unavailable while stopped",
            onSelect: () => {},
          },
          {
            title: locksText.length > 72 ? `${locksText.slice(0, 69)}...` : locksText,
            value: "locks",
            category: "Locks",
            description: status.locks.checked ? "lock service available" : "lock service unavailable",
            onSelect: () => {},
          },
          {
            title: "Dashboard",
            value: "dashboard",
            category: "Links",
            description: dashboard,
            onSelect: () => {},
          },
          {
            title: "Start daemon",
            value: "start-daemon",
            category: "Actions",
            description: status.config.enabled
              ? "Run mflow start with saved config."
              : "Configure and turn on mflow first.",
            disabled: !status.config.enabled || status.daemon.running,
            onSelect: () => void startMflowDaemonFromTui(),
          },
          {
            title: "Stop daemon",
            value: "stop-daemon",
            category: "Actions",
            description: "Run mflow stop for this repo.",
            disabled: !status.daemon.running,
            onSelect: () => void stopMflowDaemonFromTui(),
          },
          {
            title: "Back",
            value: "back",
            category: "Actions",
            description: "Return to mflow manager.",
            onSelect: () => void showMflowManager(),
          },
        ]}
      />
    ))
  }
  const configureAndActivateMflowFromTui = async () => {
    const current = (await mflowControlStatus(mend.root)).config
    const currentIsLegacyPublic =
      current.relayMode === "legacy-public" || current.signaling.includes("mflow-signal.obed0101.deno.net")
    const showLocalRelayPicker = async (): Promise<string | null> => {
      const scan = await scanMflowRelays()
      return new Promise((resolve) => {
        const guide = mflowLocalRelayGuide(mend.root)
        dialog.replace(
          () => (
            <DialogSelect
              title="local mflow relay"
              size="large"
              current={scan[0]?.url ?? "localhost"}
              renderFilter={false}
              options={[
                ...scan.map((relay) => ({
                  title: `${relay.host}:${relay.port}`,
                  value: relay.url,
                  category: relay.scope === "local-machine" ? "This machine" : "LAN",
                  description: `${relay.health} · rooms ${relay.roomCount ?? "unknown"} · peers ${relay.peerCount ?? "unknown"}`,
                  onSelect: () => resolve(relay.url),
                })),
                {
                  title: "Show relay start commands",
                  value: "start",
                  category: "Actions",
                  description: "Show relay-server commands; use localhost after starting one.",
                  onSelect: () =>
                    void showDialogObject(dialog, "Start local mflow relay", guide).then(() =>
                      showLocalRelayPicker().then(resolve),
                    ),
                },
                {
                  title: "Show LAN relay URL",
                  value: "copy",
                  category: "Actions",
                  description: guide.lanUrlExample,
                  onSelect: () =>
                    void showDialogObject(dialog, "LAN relay URL", guide).then(() =>
                      showLocalRelayPicker().then(resolve),
                    ),
                },
                {
                  title: "Refresh scan",
                  value: "refresh",
                  category: "Actions",
                  description: "Scan localhost and local IPv4 /24 networks for port 8787.",
                  onSelect: () => void showLocalRelayPicker().then(resolve),
                },
                {
                  title: "Use localhost:8787",
                  value: "localhost",
                  category: "Actions",
                  description:
                    "Configure MendCode for this relay URL; start the relay separately if scan did not detect it.",
                  onSelect: () => resolve(guide.recommendedUrl),
                },
              ]}
            />
          ),
          () => resolve(null),
        )
      })
    }
    const relayMode = await new Promise<MflowRelayMode | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="mflow relay"
            current={
              currentIsLegacyPublic
                ? "local"
                : current.relayMode === "remote" || current.relayMode === "custom"
                  ? "public"
                  : current.relayMode
            }
            options={[
              {
                title: "Local mflow relay",
                value: "local" as const,
                category: "Relay",
                description: "Use a relay on this computer or the local WiFi/LAN.",
                onSelect: () => resolve("local"),
              },
              {
                title: "Public relay URL",
                value: "public" as const,
                category: "Relay",
                description: "Use your own VPS/domain relay URL.",
                onSelect: () => resolve("public"),
              },
            ]}
          />
        ),
        () => resolve(null),
      )
    })
    if (!relayMode) return

    let signaling = current.signaling
    let publicRelayNoticeAccepted = true
    if (relayMode === "local") {
      const selected = await showLocalRelayPicker()
      if (!selected) return
      signaling = selected
    }
    if (relayMode === "public") {
      const value = await DialogPrompt.show(dialog, "mflow relay URL", {
        value:
          !currentIsLegacyPublic &&
          (current.relayMode === "public" || current.relayMode === "remote" || current.relayMode === "custom")
            ? current.signaling
            : "wss://",
        placeholder: "wss://relay.example.com",
      })
      if (value === null || value === undefined) return
      signaling = value.trim()
    }

    const room = await DialogPrompt.show(dialog, "mflow room", {
      value: current.room,
      placeholder: "repo/task-or-branch",
    })
    if (room === null || room === undefined) return

    const secretMode = await new Promise<"generate" | "manual" | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title="mflow room secret"
            current="generate"
            options={[
              {
                title: "Generate secret",
                value: "generate" as const,
                category: "Secret",
                description: "Create a new local room secret.",
                onSelect: () => resolve("generate"),
              },
              {
                title: "Type secret",
                value: "manual" as const,
                category: "Secret",
                description: "Use a room secret you already share with the swarm.",
                onSelect: () => resolve("manual"),
              },
            ]}
          />
        ),
        () => resolve(null),
      )
    })
    if (!secretMode) return

    const secret =
      secretMode === "manual"
        ? await DialogPrompt.show(dialog, "mflow room secret", { placeholder: "shared room secret" })
        : undefined
    if (secretMode === "manual" && (secret === null || secret === undefined)) return

    const storeSecret = await DialogConfirm.show(
      dialog,
      "Store secret locally?",
      "Store the room secret in .mflow/config.toml for this repo. Choose back to keep it outside the runtime config.",
      "back",
    )
    if (storeSecret === undefined) return

    const priorityText = await DialogPrompt.show(dialog, "mflow queue priority", {
      value: String(current.hookPriority ?? 0),
      placeholder: "0",
    })
    if (priorityText === null || priorityText === undefined) return

    await activateMflow(
      {
        relayMode,
        signaling,
        room: room.trim(),
        secret: secret?.trim(),
        generateSecret: secretMode === "generate",
        storeSecret: storeSecret === true,
        hookPriority: Number(priorityText) || 0,
        publicRelayNoticeAccepted,
      },
      mend.root,
    )
    await mend.reload()
    toast.show({
      variant: "success",
      message: "mflow configured and enabled.",
      duration: 5000,
    })
    await showMflowManager()
  }
  const deactivateMflowFromTui = async () => {
    await deactivateMflow(mend.root)
    await mend.reload()
    toast.show({ variant: "success", message: "mflow disabled.", duration: 4000 })
    await showMflowManager()
  }
  const removeMflowFromTui = async () => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Remove mflow config?",
      "This removes MendCode's local mflow state, MCP file, hook scaffold, and control guide for this repo.",
    )
    if (!confirmed) return
    await removeMflowConfig(mend.root)
    await mend.reload()
    toast.show({ variant: "success", message: "mflow config removed.", duration: 4000 })
    await showMflowManager()
  }
  const startMflowDaemonFromTui = async () => {
    const result = await startMflowDaemon(mend.root).catch((error) => {
      toast.show({
        variant: "error",
        message: `mflow daemon did not start: ${error instanceof Error ? error.message : String(error)}`,
        duration: 7000,
      })
      return undefined
    })
    if (!result) return
    toast.show({
      variant: "success",
      message: result.daemon.running ? "mflow daemon started." : "mflow start ran, but daemon is not detected yet.",
      duration: 5000,
    })
    await showMflowManager()
  }
  const stopMflowDaemonFromTui = async () => {
    const result = await stopMflowDaemon(mend.root).catch((error) => {
      toast.show({
        variant: "error",
        message: `mflow daemon did not stop: ${error instanceof Error ? error.message : String(error)}`,
        duration: 7000,
      })
      return undefined
    })
    if (!result) return
    toast.show({ variant: "success", message: "mflow daemon stopped.", duration: 4000 })
    await showMflowManager()
  }
  const showMflowManager = async () => {
    const current = await mflowStatusLine()
    dialog.replace(() => (
      <DialogSelect
        title="mflow"
        size="large"
        renderFilter={false}
        current="status"
        options={[
          {
            title: current.status.config.enabled ? "Enabled" : "Disabled",
            value: "status",
            category: "Status",
            description: `${current.line} · ${current.daemon} · ${current.locks}`,
            onSelect: () => {},
          },
          {
            title: "Configure and turn on",
            value: "activate",
            category: "Actions",
            description: "Choose local/public relay, room, secret handling, and queue priority.",
            onSelect: () => void configureAndActivateMflowFromTui(),
          },
          {
            title: "Start daemon",
            value: "start-daemon",
            category: "Actions",
            description: current.status.config.enabled
              ? "Run mflow start for this repo using the saved room/relay/secret."
              : "Configure and turn on mflow first.",
            disabled: !current.status.config.enabled || current.status.daemon.running,
            onSelect: () => void startMflowDaemonFromTui(),
          },
          {
            title: "Stop daemon",
            value: "stop-daemon",
            category: "Actions",
            description: "Run mflow stop for this repo.",
            disabled: !current.status.daemon.running,
            onSelect: () => void stopMflowDaemonFromTui(),
          },
          {
            title: "Turn off",
            value: "deactivate",
            category: "Actions",
            description: "Disable pre-edit locks and MCP projection without deleting local config.",
            disabled: !current.status.config.enabled,
            onSelect: () => void deactivateMflowFromTui(),
          },
          {
            title: "Remove local config",
            value: "remove",
            category: "Actions",
            description: "Delete local mflow state, MCP file, hook scaffold, and control guide.",
            onSelect: () => void removeMflowFromTui(),
          },
          {
            title: "Show details",
            value: "details",
            category: "Diagnostics",
            description: current.relay,
            onSelect: () => void showMflowDetails(),
          },
        ]}
      />
    ))
  }
  const updateMemoryConfigFromDialog = async (
    patch: Partial<MemoryConfig>,
    message: string,
    tab: "global" | "project" | "proposals" = "proposals",
  ) => {
    await writeProjectMemoryConfig(patch, memoryRoot())
    await mend.reload()
    toast.show({ variant: "success", message, duration: 4000 })
    await showMemoryManager(tab)
  }
  const showPromptModes = () => {
    const modes: Array<{ mode: MendPromptMode; title: string; description: string }> = [
      { mode: "minimal", title: "Minimal", description: "Small MendCode boundary only." },
      { mode: "focus", title: "Focus", description: "Provider-aware harness behavior." },
      { mode: "full", title: "Full", description: "Focus plus MendCode runtime context." },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="MendCode Prompt Context"
        current={mend.promptMode as MendPromptMode}
        options={modes.map((item) => ({
          title: item.title,
          value: item.mode,
          description: item.description,
          category: "Prompt Context",
          onSelect: async () => {
            const result = await writePromptMode(item.mode, mend.root)
            await mend.reload()
            toast.show({
              variant: "info",
              message: `Prompt mode is now ${result.mode}.`,
              duration: 4000,
            })
            dialog.clear()
          },
        }))}
      />
    ))
  }
  const showAgentModePicker = () => {
    dialog.setSize("large")
    dialog.replace(() => (
      <DialogSelect
        title="Select mode"
        current={local.agent.current()?.name}
        placeholder="Search modes"
        cycleKeybind="agent_mode_picker"
        options={local.agent.list().map((item) => ({
          value: item.name,
          title: item.name,
          description: item.native ? "native" : item.description,
        }))}
        onSelect={(option) => {
          local.agent.set(option.value)
          local.model.pinAgentCurrent()
          toast.show({
            variant: "info",
            message: `Mode is now ${option.value}.`,
            duration: 3000,
          })
          dialog.clear()
        }}
      />
    ))
  }
  const updatePromptChrome = async (
    update: (
      profile: Awaited<ReturnType<typeof readActiveTuiProfile>>,
    ) => Awaited<ReturnType<typeof readActiveTuiProfile>>,
    message?: string,
  ) => {
    const current = await readActiveTuiProfile(mend.root)
    const next = update(current)
    await writeActiveTuiProfile(next, mend.root)
    await mend.reload()
    if (route.data.type === "home") setHomeRevision((value) => value + 1)
    if (message) toast.show({ variant: "info", message, duration: 4000 })
    dialog.clear()
  }
  const showPromptChromePresets = () => {
    const currentPreset = mend.profile.promptChrome.preset
    const options: Array<{ title: string; value: MendPromptChromePreset; description: string }> = [
      {
        title: "Full box",
        value: "box",
        description: "Full bordered prompt with outer status line below.",
      },
      {
        title: "Top + bottom only",
        value: "top-bottom",
        description: "Horizontal rules only, plus lead prompt string on the first line.",
      },
      {
        title: "Minimal panel",
        value: "minimal",
        description: "Background panel only, with outer status line and configurable lead prompt string.",
      },
      {
        title: "ASCII terminal",
        value: "ascii-box",
        description: "ASCII box prompt with mode/model metadata kept inside the prompt.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Prompt chrome"
        current={currentPreset}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "System",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                promptChrome: { ...profile.promptChrome, preset: item.value },
              }),
              `Prompt chrome is now ${item.value}.`,
            ),
        }))}
      />
    ))
  }
  const showPromptLeadString = async () => {
    const currentLead = mend.profile.promptChrome.glyphs?.leadText ?? "❭"
    const value = await DialogPrompt.show(dialog, "Prompt lead string", {
      value: currentLead,
      placeholder: "❭",
    })
    if (value === undefined || value === null) return
    await updatePromptChrome(
      (profile) => ({
        ...profile,
        promptChrome: {
          ...profile.promptChrome,
          glyphs: {
            ...(profile.promptChrome.glyphs || {}),
            leadText: value,
          },
        },
      }),
      `Prompt lead string updated to ${value || "blank"}.`,
    )
  }
  const showHomeIdentityMode = () => {
    const current = mend.profile.identity.logoMode || "title"
    dialog.replace(() => (
      <DialogSelect
        title="Home identity"
        current={current}
        options={[
          {
            title: "ASCII title",
            value: "title",
            category: "Home",
            description: "Use the generated MendCode/title ASCII on the home screen.",
            onSelect: () =>
              void updatePromptChrome(
                (profile) => ({
                  ...profile,
                  identity: { ...profile.identity, logoMode: "title" },
                }),
                "Home identity now uses the ASCII title.",
              ),
          },
          {
            title: "ASCII mascot",
            value: "mascot",
            category: "Home",
            description: "Use ASCII mascot art as the Home identity.",
            onSelect: () =>
              void updatePromptChrome(
                (profile) => ({
                  ...profile,
                  identity: { ...profile.identity, logoMode: "mascot" },
                }),
                "Home identity now uses the default mascot.",
              ),
          },
        ]}
      />
    ))
  }
  const showHomeTitleText = async () => {
    const value = await DialogPrompt.show(dialog, "Home title text", {
      value: mend.profile.identity.productName,
      placeholder: "MendCode",
      description: () => (
        <text fg={theme.textMuted}>Used for terminal title, footer labels, and generated ASCII title mode.</text>
      ),
    })
    if (value === undefined || value === null) return
    await updatePromptChrome((profile) => ({
      ...profile,
      identity: { ...profile.identity, productName: normalizeProductName(value) },
    }))
  }
  const showHomeMascotText = async () => {
    const value = await DialogPrompt.show(dialog, "Home mascot ASCII", {
      value: mend.profile.surfaces.homeLogo?.text || "",
      placeholder: defaultHomeMascot,
      description: () => (
        <text fg={theme.textMuted}>Paste custom ASCII for Home. Blank resets to the default mascot.</text>
      ),
    })
    if (value === undefined || value === null) return
    const text = value.trimEnd()
    await updatePromptChrome(
      (profile) => ({
        ...profile,
        identity: { ...profile.identity, logoMode: "mascot" },
        surfaces: {
          ...profile.surfaces,
          homeLogo: text ? { ...(profile.surfaces.homeLogo || {}), text } : {},
        },
      }),
      text ? "Home mascot ASCII updated." : "Home mascot reset to the default ASCII.",
    )
  }
  const showHomeLogoFont = () => {
    const current =
      mend.profile.identity.logoFont === "classic" || mend.profile.identity.logoFont === "opencode"
        ? "mendcode"
        : mend.profile.identity.logoFont || "mendcode"
    const options: Array<{ title: string; value: "mendcode" | "small" | "standard" | "shadow"; description: string }> =
      [
        { title: "MendCode", value: "mendcode", description: "Block tops, flat bases, compact rows." },
        { title: "Small", value: "small", description: "Compact figlet style." },
        { title: "Standard", value: "standard", description: "Readable slanted ASCII banner." },
        { title: "Shadow", value: "shadow", description: "ANSI shadow style with tighter letter spacing." },
      ]
    dialog.replace(() => (
      <DialogSelect
        title="Home title font"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Home",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                identity: { ...profile.identity, logoFont: item.value },
              }),
              `Home title font is now ${item.value}.`,
            ),
        }))}
      />
    ))
  }
  const showHomeWelcomeMode = () => {
    const current = mend.profile.surfaces.homeWelcome?.mode || "centered"
    const options: Array<{ title: string; value: "centered" | "split"; description: string }> = [
      { title: "Centered", value: "centered", description: "Current centered logo with actions underneath." },
      {
        title: "Split",
        value: "split",
        description: "Two-column welcome: identity top-left, activity panel top-right.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Home welcome mode"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Home",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                surfaces: {
                  ...profile.surfaces,
                  homeWelcome: { ...(profile.surfaces.homeWelcome || {}), mode: item.value },
                },
              }),
              `Home welcome mode is now ${item.value}.`,
            ),
        }))}
      />
    ))
  }
  const showHomeSplitPanel = () => {
    const current = mend.profile.surfaces.homeWelcome?.rightPanel || "agentManager"
    const options: Array<{ title: string; value: "actions" | "agentManager"; description: string }> = [
      { title: "Actions", value: "actions", description: "Show Resume, Open commands, and Quit in the split panel." },
      {
        title: "Agent View",
        value: "agentManager",
        description: "Show global sessions grouped by input, working, and completed.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Home split panel"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Home",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                surfaces: {
                  ...profile.surfaces,
                  homeWelcome: { ...(profile.surfaces.homeWelcome || {}), rightPanel: item.value },
                },
              }),
              `Home split panel is now ${item.title}.`,
            ),
        }))}
      />
    ))
  }
  const showPresentationProfile = () => {
    const current = mend.profile.presentation.profile
    const options: Array<{ title: string; value: MendPresentationProfile; description: string }> = [
      {
        title: "Raw",
        value: "raw",
        description: "Plain messages only: no Markdown, tables, Mermaid, or emphasis.",
      },
      {
        title: "Minimal",
        value: "minimal",
        description: "Compact activity detail with Markdown messages; Mermaid stays literal.",
      },
      {
        title: "Full",
        value: "mendcode",
        description: "Full rich messages: Markdown, lists, tables, and local Mermaid rendering.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Chat presentation"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Chat",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                presentation: resolveTuiPresentation({
                  ...profile.presentation,
                  profile: item.value,
                  message: {
                    ...profile.presentation.message,
                    renderer: messageRendererForPresentationProfile(item.value),
                  },
                }),
              }),
              `Chat presentation is now ${presentationProfileTitle(item.value)}.`,
            ),
        }))}
      />
    ))
  }
  const showMessageRenderer = () => {
    const current = mend.profile.presentation.message.renderer
    const options: Array<{ title: string; value: MendMessageRenderer; description: string }> = [
      {
        title: "Plain",
        value: "plain",
        description: "Literal assistant text: no Markdown, Mermaid, tables, or emphasis.",
      },
      {
        title: "Markdown",
        value: "markdown",
        description: "Markdown assistant text without local Mermaid conversion.",
      },
      {
        title: "Rich",
        value: "rich",
        description: "Markdown plus local Mermaid diagrams, lists, and wide table cleanup.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Message rendering"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Chat",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                presentation: resolveTuiPresentation({
                  ...profile.presentation,
                  message: {
                    ...profile.presentation.message,
                    renderer: item.value,
                  },
                }),
              }),
              `Message rendering is now ${item.value}.`,
            ),
        }))}
      />
    ))
  }
  const compactionStyleTitle = (style: MendCompactionStyle) => {
    if (style === "arcade") return "Arcade"
    if (style === "cockpit") return "Cockpit"
    if (style === "quiet") return "Quiet"
    return "Minimal"
  }
  const compactionArcadeTitle = (arcade: MendCompactionArcade) => {
    if (arcade === "off") return "Off"
    if (arcade === "snake") return "Snake"
    if (arcade === "stars") return "Stars"
    if (arcade === "blocks") return "Blocks"
    return arcade
  }
  const showCompactionStyle = () => {
    const current = mend.profile.presentation.compaction.style
    const options: Array<{ title: string; value: MendCompactionStyle; description: string }> = [
      {
        title: "Arcade",
        value: "arcade",
        description: "Show context stages, the packed summary, scratchpad, and the selected arcade game.",
      },
      {
        title: "Cockpit",
        value: "cockpit",
        description: "Show context stages, packed summary, and scratchpad without a game.",
      },
      {
        title: "Minimal",
        value: "minimal",
        description: "Show only a short packing status line.",
      },
      {
        title: "Quiet",
        value: "quiet",
        description: "Show only a compact divider while context is being packed.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Context pack presentation"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Context pack",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => {
                const compaction = profile.presentation.compaction
                return {
                  ...profile,
                  presentation: resolveTuiPresentation({
                    ...profile.presentation,
                    compaction: {
                      ...compaction,
                      style: item.value,
                      showProgress: item.value === "arcade" ? true : compaction.showProgress,
                      allowScratchpad: item.value === "arcade" ? true : compaction.allowScratchpad,
                      arcade: item.value === "arcade" && compaction.arcade === "off" ? "snake" : compaction.arcade,
                    },
                  }),
                }
              },
              `Context pack presentation is now ${compactionStyleTitle(item.value)}.`,
            ),
        }))}
      />
    ))
  }
  const showCompactionArcade = () => {
    const current = mend.profile.presentation.compaction.arcade
    const options: Array<{ title: string; value: MendCompactionArcade; description: string }> = [
      { title: "Off", value: "off", description: "Do not show an arcade game during context packing." },
      { title: "Snake", value: "snake", description: "Classic keyboard-driven Snake game." },
      { title: "Stars", value: "stars", description: "Ambient starfield animation while context is packed." },
      { title: "Blocks", value: "blocks", description: "Animated block pattern while context is packed." },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Context pack arcade"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Context pack",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                presentation: resolveTuiPresentation({
                  ...profile.presentation,
                  compaction: {
                    ...profile.presentation.compaction,
                    style: item.value === "off" ? profile.presentation.compaction.style : "arcade",
                    showProgress: item.value === "off" ? profile.presentation.compaction.showProgress : true,
                    allowScratchpad: item.value === "off" ? profile.presentation.compaction.allowScratchpad : true,
                    arcade: item.value,
                  },
                }),
              }),
              `Context pack arcade is now ${compactionArcadeTitle(item.value)}.`,
            ),
        }))}
      />
    ))
  }
  const showCompactionProgress = () => {
    const current = mend.profile.presentation.compaction.showProgress ? "on" : "off"
    const options = [
      { title: "On", value: "on", description: "Show capture, memory, tail, and continue stages." },
      { title: "Off", value: "off", description: "Hide the context packing stage row." },
    ] as const
    dialog.replace(() => (
      <DialogSelect
        title="Context pack progress"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Context pack",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                presentation: resolveTuiPresentation({
                  ...profile.presentation,
                  compaction: { ...profile.presentation.compaction, showProgress: item.value === "on" },
                }),
              }),
              `Context pack progress is now ${item.value}.`,
            ),
        }))}
      />
    ))
  }
  const showCompactionScratchpad = () => {
    const current = mend.profile.presentation.compaction.allowScratchpad ? "on" : "off"
    const options = [
      { title: "On", value: "on", description: "Show the editable follow-up scratchpad after compaction." },
      { title: "Off", value: "off", description: "Hide the follow-up scratchpad." },
    ] as const
    dialog.replace(() => (
      <DialogSelect
        title="Context pack scratchpad"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Context pack",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                presentation: resolveTuiPresentation({
                  ...profile.presentation,
                  compaction: { ...profile.presentation.compaction, allowScratchpad: item.value === "on" },
                }),
              }),
              `Context pack scratchpad is now ${item.value}.`,
            ),
        }))}
      />
    ))
  }
  const sessionSubmitScrollMode = () => {
    const value = (mend.profile.layout.zones.session as { submitScrollMode?: unknown }).submitScrollMode
    return value === "clear" ? "clear" : "bottom"
  }
  const showSessionSubmitScrollMode = () => {
    const current = sessionSubmitScrollMode()
    const options: Array<{ title: string; value: "bottom" | "clear"; description: string }> = [
      {
        title: "Normal follow",
        value: "bottom",
        description: "Keep the current flow: after submit, follow the newest session output at the bottom.",
      },
      {
        title: "Clear sent message",
        value: "clear",
        description: "After submit, place the new user message under the top menu so the next turn starts clean.",
      },
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Submit scroll behavior"
        current={current}
        options={options.map((item) => ({
          title: item.title,
          value: item.value,
          category: "Session",
          description: item.description,
          onSelect: () =>
            void updatePromptChrome(
              (profile) => ({
                ...profile,
                layout: {
                  ...profile.layout,
                  zones: {
                    ...profile.layout.zones,
                    session: {
                      ...profile.layout.zones.session,
                      submitScrollMode: item.value,
                    },
                  },
                },
              }),
              `Submit scroll behavior is now ${item.title}.`,
            ),
        }))}
      />
    ))
  }
  const showPromptStatusPlacement = () => {
    const preset = mend.profile.promptChrome.preset
    const currentPlacement =
      mend.profile.promptStatus.placementByPreset?.[preset] || (preset === "ascii-box" ? "inside" : "outside")
    dialog.replace(() => (
      <DialogSelect
        title={`Prompt status placement (${preset})`}
        current={currentPlacement}
        options={[
          {
            title: "Outside prompt",
            value: "outside",
            category: "System",
            description: "Render mode/model/context in the bottom status row under the prompt.",
            onSelect: () =>
              void updatePromptChrome(
                (profile) => ({
                  ...profile,
                  promptStatus: {
                    ...profile.promptStatus,
                    placementByPreset: {
                      ...(profile.promptStatus.placementByPreset || {}),
                      [preset]: "outside",
                    },
                  },
                }),
                `Prompt status for ${preset} now renders outside the prompt.`,
              ),
          },
          {
            title: "Inside prompt",
            value: "inside",
            category: "System",
            description: "Render mode/model/context inside the prompt box itself.",
            onSelect: () =>
              void updatePromptChrome(
                (profile) => ({
                  ...profile,
                  promptStatus: {
                    ...profile.promptStatus,
                    placementByPreset: {
                      ...(profile.promptStatus.placementByPreset || {}),
                      [preset]: "inside",
                    },
                  },
                }),
                `Prompt status for ${preset} now renders inside the prompt.`,
              ),
          },
        ]}
      />
    ))
  }
  const showPromptStatusScript = async (side: "left" | "right") => {
    const currentCommand = mend.profile.promptStatus.scripts?.[side]?.command || ""
    const value = await DialogPrompt.show(dialog, `Prompt status ${side} script`, {
      value: currentCommand,
      placeholder: "./.mendcode/tui/prompt-status.sh",
    })
    if (value === undefined || value === null) return
    await updatePromptChrome(
      (profile) => ({
        ...profile,
        promptStatus: {
          ...profile.promptStatus,
          scripts: {
            ...(profile.promptStatus.scripts || {}),
            [side]: {
              ...(profile.promptStatus.scripts?.[side] || {}),
              enabled: Boolean(value.trim()),
              command: value,
            },
          },
          script: {
            ...(profile.promptStatus.script || {}),
            enabled:
              side === "left" &&
              !(profile.promptStatus.scripts?.right?.enabled && profile.promptStatus.scripts?.right?.command?.trim())
                ? Boolean(value.trim())
                : profile.promptStatus.script?.enabled,
            command:
              side === "left" &&
              !(profile.promptStatus.scripts?.right?.enabled && profile.promptStatus.scripts?.right?.command?.trim())
                ? value
                : profile.promptStatus.script?.command || "",
          },
        },
      }),
      value.trim() ? `Prompt status ${side} script updated.` : `Prompt status ${side} script disabled.`,
    )
  }
  const PROMPT_STATUS_BUILTINS: MendPromptStatusBuiltin[] = [
    "mode",
    "model",
    "provider",
    "reasoning",
    "variant",
    "context",
    "permissionMode",
    "commandsHint",
    "agentsHint",
  ]
  const PROMPT_STATUS_BUILTIN_META: Record<
    MendPromptStatusBuiltin,
    {
      title: string
      description: string
    }
  > = {
    mode: {
      title: "Mode",
      description: "Current prompt mode or active agent label, like Build, Spec, or Shell.",
    },
    model: {
      title: "Model",
      description: "Resolved model name for the current session.",
    },
    provider: {
      title: "Provider",
      description: "Resolved provider label for the current model.",
    },
    reasoning: {
      title: "Reasoning",
      description: "Current model effort variant, when the selected model exposes one.",
    },
    variant: {
      title: "Variant",
      description: "Alias of the current model variant when you want it explicitly in the row.",
    },
    context: {
      title: "Context",
      description: "Context usage summary, for example 81.1K (31%).",
    },
    permissionMode: {
      title: "Permission mode",
      description: "Current interactive permission mode and pending permission prompt count.",
    },
    commandsHint: {
      title: "Commands hint",
      description: "Shortcut hint for opening the commands palette.",
    },
    agentsHint: {
      title: "Agents hint",
      description: "Shortcut hint for cycling or opening agents.",
    },
  }
  const defaultPromptStatusSide = (side: "left" | "right") => defaultPromptStatus()[side].map((item) => item.value)
  const parsePromptStatusBuiltins = (raw: string): MendPromptStatusItem[] => {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item): item is MendPromptStatusBuiltin =>
        PROMPT_STATUS_BUILTINS.includes(item as MendPromptStatusBuiltin),
      )
      .map((value) => ({ type: "builtin" as const, value }))
  }
  const writePromptStatusBuiltins = async (
    side: "left" | "right",
    values: MendPromptStatusBuiltin[],
    message: string,
    options?: { reopen?: boolean },
  ) => {
    const current = await readActiveTuiProfile(mend.root)
    const next = values.map((value) => ({ type: "builtin" as const, value }))
    await writeActiveTuiProfile(
      {
        ...current,
        promptStatus: {
          ...current.promptStatus,
          [side]: next,
        },
      },
      mend.root,
    )
    await mend.reload()
    toast.show({ variant: "info", message, duration: 4000 })
    if (options?.reopen) {
      showPromptStatusBuiltins(side)
      return
    }
    dialog.clear()
  }
  const showPromptStatusBuiltinsManual = async (side: "left" | "right") => {
    const current = mend.profile.promptStatus[side].map((item) => item.value).join(", ")
    const value = await DialogPrompt.show(dialog, `Prompt status ${side} builtins`, {
      value: current,
      placeholder: "mode, model, provider, reasoning",
    })
    if (value === undefined || value === null) return
    const parsed = parsePromptStatusBuiltins(value)
    await writePromptStatusBuiltins(
      side,
      parsed.map((item) => item.value),
      `Prompt status ${side} builtins updated.`,
    )
  }
  const showPromptStatusBuiltinActions = (side: "left" | "right", builtin: MendPromptStatusBuiltin) => {
    const current = mend.profile.promptStatus[side].map((item) => item.value)
    const index = current.indexOf(builtin)
    const meta = PROMPT_STATUS_BUILTIN_META[builtin]
    if (index < 0) {
      void writePromptStatusBuiltins(side, [...current, builtin], `${meta.title} added to prompt status ${side}.`, {
        reopen: true,
      })
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title={`${meta.title} (${side})`}
        current="move-up"
        options={[
          {
            title: "Move earlier",
            value: "move-up",
            category: "Actions",
            description: "Shift this field one slot toward the start of the row.",
            disabled: index === 0,
            onSelect: () => {
              const next = [...current]
              ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
              void writePromptStatusBuiltins(side, next, `${meta.title} moved earlier in prompt status ${side}.`, {
                reopen: true,
              })
            },
          },
          {
            title: "Move later",
            value: "move-down",
            category: "Actions",
            description: "Shift this field one slot toward the end of the row.",
            disabled: index === current.length - 1,
            onSelect: () => {
              const next = [...current]
              ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
              void writePromptStatusBuiltins(side, next, `${meta.title} moved later in prompt status ${side}.`, {
                reopen: true,
              })
            },
          },
          {
            title: "Move to start",
            value: "move-start",
            category: "Actions",
            description: "Place this field at the very beginning of the row.",
            disabled: index === 0,
            onSelect: () => {
              const next = [builtin, ...current.filter((item) => item !== builtin)]
              void writePromptStatusBuiltins(side, next, `${meta.title} moved to the start of prompt status ${side}.`, {
                reopen: true,
              })
            },
          },
          {
            title: "Move to end",
            value: "move-end",
            category: "Actions",
            description: "Place this field at the very end of the row.",
            disabled: index === current.length - 1,
            onSelect: () => {
              const next = [...current.filter((item) => item !== builtin), builtin]
              void writePromptStatusBuiltins(side, next, `${meta.title} moved to the end of prompt status ${side}.`, {
                reopen: true,
              })
            },
          },
          {
            title: "Remove field",
            value: "remove",
            category: "Actions",
            description: "Hide this field from the selected side.",
            onSelect: () => {
              const next = current.filter((item) => item !== builtin)
              void writePromptStatusBuiltins(side, next, `${meta.title} removed from prompt status ${side}.`, {
                reopen: true,
              })
            },
          },
          {
            title: "Back",
            value: "back",
            category: "Navigation",
            description: "Return to the builtins editor.",
            onSelect: () => showPromptStatusBuiltins(side),
          },
        ]}
      />
    ))
  }
  const showPromptStatusBuiltins = (side: "left" | "right") => {
    const current = mend.profile.promptStatus[side].map((item) => item.value)
    dialog.replace(() => (
      <DialogSelect
        title={`Prompt status ${side} builtins`}
        options={[
          {
            title: "Edit as text",
            value: "__manual__",
            category: "Actions",
            description: "Fallback editor for typing a raw comma-separated list.",
            onSelect: () => void showPromptStatusBuiltinsManual(side),
          },
          {
            title: "Reset to default",
            value: "__reset__",
            category: "Actions",
            description: `Restore the default ${side} row for the current CLI look.`,
            onSelect: () =>
              void writePromptStatusBuiltins(
                side,
                defaultPromptStatusSide(side),
                `Prompt status ${side} reset to defaults.`,
                {
                  reopen: true,
                },
              ),
          },
          {
            title: "Clear all fields",
            value: "__clear__",
            category: "Actions",
            description: "Leave this side empty until you add fields back.",
            disabled: current.length === 0,
            onSelect: () =>
              void writePromptStatusBuiltins(side, [], `Prompt status ${side} cleared.`, { reopen: true }),
          },
          ...PROMPT_STATUS_BUILTINS.map((builtin) => {
            const activeIndex = current.indexOf(builtin)
            const active = activeIndex >= 0
            const meta = PROMPT_STATUS_BUILTIN_META[builtin]
            return {
              title: `${active ? "[x]" : "[ ]"} ${meta.title}`,
              value: builtin,
              category: active ? `Enabled · #${activeIndex + 1}` : "Available",
              description: active
                ? `${meta.description} Select to reorder or remove it.`
                : `${meta.description} Select to add it to the ${side} row.`,
              onSelect: () => {
                if (!active) {
                  void writePromptStatusBuiltins(
                    side,
                    [...current, builtin],
                    `${meta.title} added to prompt status ${side}.`,
                    {
                      reopen: true,
                    },
                  )
                  return
                }
                showPromptStatusBuiltinActions(side, builtin)
              },
            }
          }),
        ]}
      />
    ))
  }
  const showPromptStatusSeparator = async () => {
    const value = await DialogPrompt.show(dialog, "Prompt status separator", {
      value: mend.profile.promptStatus.separator || " · ",
      placeholder: " · ",
    })
    if (value === undefined || value === null) return
    await updatePromptChrome(
      (profile) => ({
        ...profile,
        promptStatus: {
          ...profile.promptStatus,
          separator: value,
        },
      }),
      "Prompt status separator updated.",
    )
  }
  const showDialogLoading = (title: string, message: string) => {
    dialog.replace(() => (
      <box paddingLeft={4} paddingRight={4} paddingBottom={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}>{title}</text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        <text fg={theme.textMuted}>{message}</text>
      </box>
    ))
    dialog.setSize("medium")
  }
  const showRegistryMarketplace = async (initialSourceID = "local", cleanupSourceOnClose = false) => {
    showDialogLoading(
      initialSourceID === "local" ? "Loading local packages" : "Loading marketplace",
      initialSourceID === "local" ? "Reading local package catalog..." : "Fetching package catalog...",
    )
    let sourceID = initialSourceID
    let sourceRoot = sourceID === "local" ? await prepareGlobalRuntimePackAuthorRoot() : mend.root
    const result = await runtimeRegistrySearch("", sourceID, sourceRoot).catch(async (error) => {
      if (sourceID === "local") throw error
      sourceID = "local"
      sourceRoot = await prepareGlobalRuntimePackAuthorRoot()
      toast.show({
        variant: "warning",
        message: `Official packages unavailable; showing local packages. ${errorMessage(error)}`,
        duration: 5000,
      })
      return runtimeRegistrySearch("", sourceID, sourceRoot)
    })
    const packageState = await listMendPackages(mend.root)
    let keepTemporarySource = false
    dialog.replace(
      () => (
        <DialogSelect
          title="MendCode Marketplace"
          options={result.results.map((pack) => {
            const badge = marketplaceInstallBadge(pack.id, packageState.installed)
            return {
              title: marketplaceBadgeTitle(pack.title || pack.id, badge),
              value: pack.id,
              category: marketplaceStatusCategory({ badge, sourceID, channel: pack.channel }),
              description: marketplaceShortSummary(pack),
              searchText: marketplaceSearchText([
                pack.id,
                pack.title,
                pack.description,
                marketplaceRuntimeSummary(pack),
                sourceID,
                pack.channel,
                badge,
                ...(pack.tags || []),
              ]),
              footer: [cleanMarketplaceVersion(pack.version), badge].filter(Boolean).join(" · "),
              onSelect: async () => {
                try {
                  showDialogLoading("Loading package", `Reading ${pack.id}...`)
                  const detail = await runtimeRegistryShow(pack.id, sourceID, sourceRoot)
                  if (sourceID === "local") {
                    await DialogAlert.show(
                      dialog,
                      detail.pack.title || detail.pack.id,
                      marketplacePackDetails(detail.pack, sourceID),
                    )
                    return
                  }
                  const confirmed = await DialogConfirm.show(
                    dialog,
                    detail.pack.title || detail.pack.id,
                    [
                      marketplacePackDetails(detail.pack, sourceID),
                      "",
                      ...marketplaceSourceSafetyLines({
                        sourceID,
                        sourceType: detail.source.type,
                        url: detail.source.url,
                        digest: detail.digest,
                        signature: detail.pack.signature,
                      }),
                      "",
                      "Install this package overlay for the next message?",
                      "",
                      "Will not touch local skills/modes/sessions/auth.",
                    ].join("\n"),
                  )
                  if (!confirmed) {
                    if (cleanupSourceOnClose) await runtimeRegistryRemove(sourceID, mend.root).catch(() => undefined)
                    return
                  }
                  const result = await runtimeRegistryInstallPack(detail.pack.id, sourceID, mend.root)
                  keepTemporarySource = true
                  await mend.reload()
                  toast.show({
                    variant: "success",
                    message: `Package installed: ${result.package.id}.`,
                    duration: 5000,
                  })
                  await showPackageManager()
                } catch (error) {
                  if (cleanupSourceOnClose) await runtimeRegistryRemove(sourceID, mend.root).catch(() => undefined)
                  toast.show({ variant: "error", message: errorMessage(error), duration: 7000 })
                }
              },
            }
          })}
        />
      ),
      () => {
        if (!cleanupSourceOnClose || keepTemporarySource) return
        void runtimeRegistryRemove(sourceID, mend.root).catch(() => undefined)
      },
    )
    dialog.setSize("xlarge")
  }
  const refreshPackagesRuntime = async () => {
    await syncProject(mend.root)
    await mend.reload()
  }
  const showPackageAuthorWizard = async () => {
    const packageRoot = await prepareGlobalRuntimePackAuthorRoot()
    const metadata = packageMetadata(packageRoot)
    const candidates = await runtimePackArtifactCandidates(packageRoot)
    const title = await DialogPrompt.show(dialog, "Package title", {
      value: metadata.title || "",
      placeholder: "Starter Pack",
      description: () => (
        <text fg={theme.textMuted}>Human-facing package name shown in local package lists and registry previews.</text>
      ),
    })
    if (title === undefined || title === null) return
    const id = await DialogPrompt.show(dialog, "Package id", {
      value: metadata.id || "",
      placeholder: "starter-pack",
      description: () => (
        <text fg={theme.textMuted}>Stable package id. Blank keeps the generated local runtime id.</text>
      ),
    })
    if (id === undefined || id === null) return
    const description = await DialogPrompt.show(dialog, "Package description", {
      value: metadata.description || "",
      placeholder: "Reusable MendCode starter package",
      description: () => (
        <text fg={theme.textMuted}>Short summary for package search, install previews, and show output.</text>
      ),
    })
    if (description === undefined || description === null) return
    const version = await DialogPrompt.show(dialog, "Package version", {
      value: metadata.version || "0.1.0",
      placeholder: "0.1.0",
      description: () => (
        <text fg={theme.textMuted}>Optional semantic package version. This is not the manifest schema version.</text>
      ),
    })
    if (version === undefined || version === null) return
    const selection: RuntimePackSelection = { ...(metadata.selection as RuntimePackSelection) }
    type PackageFileCategoryKey =
      | "commands"
      | "agents"
      | "modes"
      | "skills"
      | "plugins"
      | "tools"
      | "prompts"
      | "mcp"
      | "context"
      | "pages"
      | "widgets"
      | "extensions"
    const fileCategories: Array<{ key: PackageFileCategoryKey; title: string; files: string[] }> = [
      { key: "commands", title: "Commands", files: candidates.commands },
      { key: "agents", title: "Agents", files: candidates.agents },
      { key: "modes", title: "Modes", files: candidates.modes },
      { key: "skills", title: "Skills", files: candidates.skills },
      { key: "plugins", title: "Plugins", files: candidates.plugins },
      { key: "tools", title: "Tool calls", files: candidates.tools },
      { key: "prompts", title: "Prompt templates", files: candidates.prompts },
      { key: "mcp", title: "MCP files", files: candidates.mcp },
      { key: "context", title: "Context files", files: candidates.context },
      { key: "pages", title: "TUI pages", files: candidates.pages },
      { key: "widgets", title: "TUI widgets", files: candidates.widgets },
      { key: "extensions", title: "Extension support files", files: candidates.extensions },
    ]
    const boolCategories: Array<{
      key: "tuiProfile" | "worktreePolicy" | "models" | "focus" | "budget" | "memory" | "permissions"
      title: string
    }> = [
      { key: "models", title: "Model roles (global config)" },
      { key: "focus", title: "Focus config (global config)" },
      { key: "budget", title: "Budget policy (global config)" },
      { key: "memory", title: "Memory settings (global config)" },
      { key: "permissions", title: "Permission settings (global config)" },
      { key: "tuiProfile", title: "TUI profile (global config)" },
      { key: "worktreePolicy", title: "Worktree policy (global config)" },
    ]
    const selectedSet = (key: PackageFileCategoryKey, files: string[]) => new Set((selection[key] ?? files) as string[])
    const selectedCount = (key: PackageFileCategoryKey, files: string[]) => selectedSet(key, files).size
    const visibleFileCategories = () =>
      fileCategories.filter((category) => category.files.length > 0 || selectedCount(category.key, category.files) > 0)
    const boolEnabled = (
      key: "tuiProfile" | "worktreePolicy" | "models" | "focus" | "budget" | "memory" | "permissions",
    ) => selection[key] !== false
    const configSelectedCount = () => boolCategories.filter((category) => boolEnabled(category.key)).length
    const packageSummaryLine = () =>
      `${selectedCount("commands", candidates.commands)} cmd · ${selectedCount("agents", candidates.agents)} agents · ${selectedCount("skills", candidates.skills)} skills · ${selectedCount("tools", candidates.tools)} tools · ${configSelectedCount()}/${boolCategories.length} config`
    const packageSummaryText = () =>
      [
        `Commands: ${selectedCount("commands", candidates.commands)}/${candidates.commands.length}`,
        `Agents/subagents: ${selectedCount("agents", candidates.agents)}/${candidates.agents.length}`,
        `Modes: ${selectedCount("modes", candidates.modes)}/${candidates.modes.length}`,
        `Skills: ${selectedCount("skills", candidates.skills)}/${candidates.skills.length}`,
        `Plugins: ${selectedCount("plugins", candidates.plugins)}/${candidates.plugins.length}`,
        `Tool calls: ${selectedCount("tools", candidates.tools)}/${candidates.tools.length}`,
        `Prompt templates: ${selectedCount("prompts", candidates.prompts)}/${candidates.prompts.length}`,
        `MCP files: ${selectedCount("mcp", candidates.mcp)}/${candidates.mcp.length}`,
        `Context files: ${selectedCount("context", candidates.context)}/${candidates.context.length}`,
        `TUI pages: ${selectedCount("pages", candidates.pages)}/${candidates.pages.length}`,
        `TUI widgets: ${selectedCount("widgets", candidates.widgets)}/${candidates.widgets.length}`,
        `Extension support files: ${selectedCount("extensions", candidates.extensions)}/${candidates.extensions.length}`,
        `Config groups: ${configSelectedCount()}/${boolCategories.length}`,
        "",
        "Package source: global MendCode configuration, not the currently opened project folder.",
        "Global skills from supported legacy and MendCode skill folders are copied into this package authoring snapshot.",
        "Original global skills/config are not deleted or moved.",
      ].join("\n")
    const openFileCategory = (category: (typeof fileCategories)[number]) => {
      const chosen = selectedSet(category.key, category.files)
      dialog.replace(() => (
        <DialogSelect
          title={category.title}
          options={[
            {
              title: "Done",
              value: "done",
              category: "Action",
              description: "Return to package contents.",
              onSelect: () => openPackageContents(),
            },
            {
              title: "Select all",
              value: "all",
              category: "Action",
              description: `${category.files.length} files`,
              onSelect: () => {
                selection[category.key] = [...category.files]
                openFileCategory(category)
              },
            },
            {
              title: "Select none",
              value: "none",
              category: "Action",
              description: "Exclude these files.",
              onSelect: () => {
                selection[category.key] = []
                openFileCategory(category)
              },
            },
            ...category.files.map((file) => ({
              title: `${chosen.has(file) ? "[x]" : "[ ]"} ${file}`,
              value: file,
              category: "Files",
              description: chosen.has(file) ? "Included" : "Excluded",
              onSelect: () => {
                const next = selectedSet(category.key, category.files)
                if (next.has(file)) next.delete(file)
                else next.add(file)
                selection[category.key] = [...next].sort()
                openFileCategory(category)
              },
            })),
          ]}
        />
      ))
      dialog.setSize("xlarge")
    }
    const openPackageContents = () => {
      dialog.replace(() => (
        <DialogSelect
          title="Package contents"
          options={[
            {
              title: "Package summary",
              value: "summary",
              category: "Summary",
              description: packageSummaryLine(),
              onSelect: () => void DialogAlert.show(dialog, "Package summary", packageSummaryText()),
            },
            {
              title: "Save snapshot",
              value: "save",
              category: "Action",
              description: "Write selected global config.",
              onSelect: async () => {
                await packageMetadataSet({ title, id, description, version, selection }, packageRoot)
                const snapshot = await applyRuntimePack(packageRoot)
                await mend.reload()
                toast.show({
                  variant: "success",
                  message: `Package ${title || id || version} snapshot updated: ${snapshot.packageManifestPath}`,
                  duration: 5000,
                })
                dialog.clear()
              },
            },
            {
              title: "Select all",
              value: "all",
              category: "Action",
              description: "Include every global file and config group.",
              onSelect: () => {
                for (const category of fileCategories) selection[category.key] = [...category.files]
                for (const category of boolCategories) selection[category.key] = true
                openPackageContents()
              },
            },
            {
              title: "Select no files",
              value: "none",
              category: "Action",
              description: "Keep config groups, exclude files.",
              onSelect: () => {
                for (const category of fileCategories) selection[category.key] = []
                openPackageContents()
              },
            },
            ...(visibleFileCategories().length
              ? visibleFileCategories().map((category) => ({
                  title: `${category.title}: ${selectedCount(category.key, category.files)}/${category.files.length}`,
                  value: category.key,
                  category: "Global files",
                  description: "Choose files.",
                  onSelect: () => openFileCategory(category),
                }))
              : [
                  {
                    title: "No global artifact files found",
                    value: "no-project-files",
                    category: "Global files",
                    description:
                      "No global MendCode commands, agents, modes, skills, plugins, prompts, MCP files, or widgets were found.",
                  },
                ]),
            ...boolCategories.map((category) => ({
              title: `${boolEnabled(category.key) ? "[x]" : "[ ]"} ${category.title}`,
              value: category.key,
              category: "Config",
              description: boolEnabled(category.key) ? "Included" : "Excluded",
              onSelect: () => {
                selection[category.key] = !boolEnabled(category.key)
                openPackageContents()
              },
            })),
          ]}
        />
      ))
      dialog.setSize("xlarge")
    }
    openPackageContents()
  }
  const packageArtifactSummary = (files: string[]) => {
    const count = (pattern: RegExp) => files.filter((file) => pattern.test(file)).length
    return [
      `Commands: ${count(/^\.mendcode\/commands\//)}`,
      `Agents: ${count(/^\.mendcode\/agents\//)}`,
      `Modes: ${count(/^\.mendcode\/modes\//)}`,
      `Skills: ${count(/^\.mendcode\/skills\//)}`,
      `Plugins: ${count(/^\.mendcode\/plugins\//)}`,
      `MCP files: ${count(/^\.mendcode\/mcp\//)}`,
      `Prompt templates: ${count(/^\.mendcode\/prompts\//)}`,
      `Widgets/components/scripts: ${count(/^\.mendcode\/(widgets|components|scripts)\//)}`,
      `Runtime snapshot/config: ${count(/^(mend-package\.json|\.mendcode\/runtime-pack\.json|\.mendcode\/mendcode\.json|\.mendcode\/models\.yaml|\.mendcode\/prompt-mode\.json|\.mendcode\/tui\/profile\.json|\.mendcode\/worktree\/policy\.yaml)$/)}`,
    ].join("\n")
  }
  const packageTransitionText = (input: {
    title: string
    action: string
    activeBefore: string[]
    activeAfter: string[]
    files: string[]
    extra?: string[]
  }) =>
    [
      input.action,
      "",
      `Active before: ${input.activeBefore.join(", ") || "none"}`,
      `Active after: ${input.activeAfter.join(", ") || "none"}`,
      "",
      "Runtime updated for next message:",
      packageArtifactSummary(input.files),
      ...(input.extra?.length ? ["", ...input.extra] : []),
      "",
      "Will not touch:",
      "- open chat/session history",
      "- local .mendcode/skills, modes, commands, plugins",
      "- provider auth, runs, cache, generated history",
      "",
      "If the current mode disappears, MendCode will switch to the first available mode and show a notification.",
    ].join("\n")
  const confirmPackageTransition = async (input: Parameters<typeof packageTransitionText>[0]) =>
    DialogConfirm.show(dialog, input.title, packageTransitionText(input))
  const showPackageManager = async () => {
    const state = await listMendPackages(mend.root)
    const installed = state.installed
    dialog.replace(() => (
      <DialogSelect
        title="MendCode Marketplace"
        options={[
          {
            title: "Create package",
            value: "create-local",
            category: "Start here",
            description: "Global snapshot wizard.",
            onSelect: () => void showPackageAuthorWizard(),
          },
          {
            title: "Install source",
            value: "install-source",
            category: "Install",
            description: "Install a single-pack source or browse a multi-pack source.",
            onSelect: async () => {
              const source = await DialogPrompt.show(dialog, "Source id or GitHub URL", {
                value: "official",
                placeholder: "official or https://github.com/org/mendcode-package",
                description: () => (
                  <text fg={theme.textMuted}>Paste a saved source id or a public GitHub repo URL.</text>
                ),
              })
              if (!source?.trim()) return
              const sourceText = source.trim()
              const sourceLooksLikeURL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(sourceText)
              if (sourceLooksLikeURL && !isPublicGitHubMarketplaceURL(sourceText)) {
                toast.show({
                  variant: "error",
                  message:
                    "Package URL must be public https://github.com/<org>/<repo> with no query, hash, or credentials.",
                  duration: 7000,
                })
                return
              }
              const sourceID = sourceLooksLikeURL ? marketplaceSourceIDFromURL(sourceText) : sourceText
              let sourceAdded = false
              try {
                if (sourceLooksLikeURL) {
                  showDialogLoading("Adding source", `Saving ${sourceID}...`)
                  await runtimeRegistryAdd(
                    [
                      sourceID,
                      "--type",
                      "github",
                      "--url",
                      sourceText,
                      "--note",
                      "TUI-added GitHub marketplace package source.",
                    ],
                    mend.root,
                  )
                  sourceAdded = true
                }
                showDialogLoading("Previewing source", `Checking ${sourceID}...`)
                const catalog = await runtimeRegistrySearch("", sourceID, mend.root)
                if (catalog.results.length !== 1) {
                  toast.show({
                    variant: "info",
                    message: `${sourceID} has ${catalog.results.length} packages. Choose one to install.`,
                    duration: 4000,
                  })
                  await showRegistryMarketplace(sourceID, sourceAdded)
                  return
                }
                const detail = await runtimeRegistryShow(catalog.results[0]!.id, sourceID, mend.root)
                const stateBefore = await listMendPackages(mend.root)
                const confirmed = await DialogConfirm.show(
                  dialog,
                  detail.pack.title || detail.pack.id,
                  [
                    marketplacePackDetails(detail.pack, sourceID),
                    "",
                    ...marketplaceSourceSafetyLines({
                      sourceID,
                      sourceType: detail.source.type,
                      url: detail.source.url,
                      digest: detail.digest,
                      signature: detail.pack.signature,
                    }),
                    "",
                    `Active before: ${stateBefore.active.join(", ") || "none"}`,
                    `Active after: ${detail.pack.id}`,
                    "",
                    "Will not touch local skills/modes/sessions/auth.",
                  ].join("\n"),
                )
                if (!confirmed) {
                  if (sourceAdded) await runtimeRegistryRemove(sourceID, mend.root).catch(() => undefined)
                  return
                }
                showDialogLoading("Installing package", `Installing ${detail.pack.id}...`)
                const result = await runtimeRegistryInstallPack(detail.pack.id, sourceID, mend.root)
                await mend.reload()
                toast.show({
                  variant: "success",
                  message: `Package installed: ${result.package.id}.`,
                  duration: 5000,
                })
                await showPackageManager()
              } catch (error) {
                if (sourceAdded) await runtimeRegistryRemove(sourceID, mend.root).catch(() => undefined)
                toast.show({ variant: "error", message: errorMessage(error), duration: 7000 })
              }
            },
          },
          {
            title: "Browse packages",
            value: "browse-packages",
            category: "Install",
            description: "Local catalog, no network.",
            onSelect: () => void showRegistryMarketplace("local"),
          },
          {
            title: "Browse official",
            value: "browse-official-packages",
            category: "Install",
            description: "GitHub registry.",
            onSelect: () => void showRegistryMarketplace("official"),
          },
          ...(state.enabled.length
            ? [
                {
                  title: "Deselect all packages",
                  value: "disable-all",
                  category: "Active",
                  description: "Return to local config.",
                  onSelect: async () => {
                    const files = state.enabled.flatMap((item) => item.copied)
                    const confirmed = await confirmPackageTransition({
                      title: "Deselect all packages",
                      action: "Deselect every active package and return to local-only runtime.",
                      activeBefore: state.active,
                      activeAfter: [],
                      files,
                    })
                    if (!confirmed) return
                    await disableAllMendPackages(mend.root)
                    await refreshPackagesRuntime()
                    toast.show({ variant: "success", message: "All packages deselected.", duration: 4000 })
                    await showPackageManager()
                  },
                },
              ]
            : []),
          ...installed.map((item) => ({
            title: marketplaceBadgeTitle(item.title || item.id, item.enabled ? "active" : "installed"),
            value: item.id,
            category: marketplaceStatusCategory({
              badge: item.enabled ? "active" : "installed",
              channel: item.channel,
              sourceID: item.sourceType,
            }),
            description: item.description || "Installed overlay.",
            searchText: marketplaceSearchText([
              item.id,
              item.title,
              item.description,
              item.root,
              item.version,
              item.channel,
              item.sourceType,
              item.enabled ? "active enabled selected" : "installed inactive disabled",
            ]),
            footer: item.version || item.channel || item.sourceType,
            onSelect: async () => {
              const activeAfter = item.enabled
                ? state.active.filter((id) => id !== item.id)
                : [...state.active.filter((id) => id !== item.id), item.id]
              const confirmed = await confirmPackageTransition({
                title: item.enabled ? "Deselect package" : "Enable package",
                action: `${item.enabled ? "Deselect" : "Enable"} ${item.title || item.id}.`,
                activeBefore: state.active,
                activeAfter,
                files: item.copied,
                extra: [
                  `Package root: ${item.root}`,
                  `Version/channel: ${item.version || item.channel || item.sourceType}`,
                ],
              })
              if (!confirmed) return
              await setMendPackageEnabled(item.id, !item.enabled, mend.root)
              await refreshPackagesRuntime()
              toast.show({
                variant: "success",
                message: `${item.title || item.id} ${item.enabled ? "deselected" : "enabled"}.`,
                duration: 4000,
              })
              await showPackageManager()
            },
          })),
          ...installed.map((item) => ({
            title: `Remove ${item.title || item.id}`,
            value: `remove:${item.id}`,
            category: "Remove",
            description: "Delete installed overlay.",
            onSelect: async () => {
              const confirmed = await confirmPackageTransition({
                title: "Remove package",
                action: `Remove installed package snapshot ${item.title || item.id}.`,
                activeBefore: state.active,
                activeAfter: state.active.filter((id) => id !== item.id),
                files: item.copied,
                extra: [
                  "The downloaded overlay copy will be deleted.",
                  "Local source/customization files stay on disk.",
                ],
              })
              if (!confirmed) return
              await removeMendPackage(item.id, mend.root)
              await refreshPackagesRuntime()
              toast.show({ variant: "success", message: `${item.title || item.id} removed.`, duration: 4000 })
              await showPackageManager()
            },
          })),
          {
            title: "Delete local snapshot",
            value: "delete-local",
            category: "Maintenance",
            description: "Remove authored snapshot only.",
            onSelect: async () => {
              const confirmed = await DialogConfirm.show(
                dialog,
                "Delete local package snapshot",
                "Remove the local package snapshot and saved artifact selection? Local skills, modes, commands, plugins, sessions, and config files stay on disk.",
              )
              if (!confirmed) return
              const result = await deleteLocalRuntimePack(globalRuntimePackAuthorRoot())
              await refreshPackagesRuntime()
              toast.show({
                variant: "success",
                message: `Local package snapshot deleted (${result.removed.length} files).`,
                duration: 4000,
              })
              await showPackageManager()
            },
          },
        ]}
      />
    ))
    dialog.setSize("xlarge")
  }
  const showMendAssets = async () => {
    const plan = await runtimePackPlan("preview", mend.root)
    await DialogAlert.show(
      dialog,
      "MendCode Assets",
      [
        `Skills: ${plan.pack.skills.length}`,
        `Slash commands: ${plan.pack.commands.length}`,
        `Agents: ${plan.pack.agents.length}`,
        `Prompt templates: ${plan.pack.prompts.templates.length}`,
        `MCP files: ${plan.pack.mcp.files.length}`,
        `Prompt mode: ${plan.pack.prompts.mode}`,
      ].join("\n"),
    )
  }
  const showSlashCommands = async () => {
    const slashes = command.slashes()
    await DialogAlert.show(
      dialog,
      "MendCode Slash Commands",
      slashes.map((item) => `${item.display}  ${item.description || ""}`).join("\n") || "No slash commands available.",
    )
  }
  function loopSlashPrompt(args: string) {
    const request = args.trim()
    return [
      request
        ? `Create or control a MendCode Loop Workflow for this request:\n${request}`
        : "Start a guided MendCode Loop Workflow setup for this session.",
      "",
      "Use exactly the `loop` tool, not shell commands. If the request already includes the objective, cadence, iteration limit, permission mode, and stop conditions, your first loop tool call must be action `activate`. Do not call `show` or `list` before creating the loop.",
      "If the request is to stop, remove, delete, pause, resume, or run the current loop and no loop id is visible, call the matching `loop` action without `workflowID`; the tool resolves the current session's contextual loop.",
      "Ask with the `question` tool only when a critical setting is missing: objective, budget mode, iteration cap or unbounded mode, cadence, model/provider, max wall-clock runtime, permission mode, or stop condition.",
      "Before activating, design the loop strategy from the goal: choose `budgetMode` as `fixed` only for exactly-N iteration jobs, `max-goal` when maxTurns is a budget cap to complete a goal as early as possible, and `unbounded-monitor` for ongoing monitors. For `max-goal`, provide concrete `completionCriteria`, `successChecks`, `targetTurns`, and `reserveTurns`; do not divide the work across every max iteration. Aim to finish in the minimum responsible turns, then use remaining turns only for retry/verification if needed. Set `notifyOwnerOnComplete: true` for goal-completion loops so the parent session gets a completion summary.",
      'Default to report-only unless I explicitly allow edits. Spanish/English requests such as codear, implementar, fixear, editar, hacer cambios, probar, compilar, run tests, or build are explicit edit permission for the loop; use permissionMode `normal` or `custom`, set `reportOnly: false`, and keep safety gates for push/merge/release/destructive shell. If I choose a model and reasoning effort/variant, pass `model` as provider/model and pass the effort as `variant` (for example `variant: "medium"`), or use provider/model#variant. For interval cadence, set `triggerMode: "interval"` and convert the interval to `intervalMs`; for a local daily schedule, set `triggerMode: "daily"`, `dailyAt` as `HH:mm`, and an explicit IANA `timezone`. Preserve the current session model by omitting `model` unless I choose one.',
      "Do not hand-render Markdown tables or duplicate status cards after the tool call. Let the Loop Workflow card render from tool metadata, then give a one-line confirmation.",
    ].join("\n")
  }
  function fillLoopSlashPrompt(args = "", submit = false) {
    const ref = promptRef.current
    if (!ref) return
    ref.set({ input: submit ? loopSlashPrompt(args) : `/loop ${args}`.trimEnd(), parts: [] })
    ref.focus()
    if (submit) setTimeout(() => promptRef.current?.submit(), 0)
  }
  const showCustomizationCapabilities = async () => {
    await DialogAlert.show(
      dialog,
      "MendCode customization capabilities",
      [
        `Contract version: ${mendTuiCapabilityVersion()}`,
        "",
        ...visibleCustomizationCapabilities().map(
          (item) =>
            `${item.label}\n- id: ${item.id}\n- tier: ${item.tier}\n- trust: ${item.trust}\n- runtime: ${item.runtimeIDs.join(", ")}\n- note: ${item.docs}`,
        ),
      ].join("\n\n"),
    )
  }
  const showCustomization = () => {
    const actions: TuiCustomizationAction[] = [
      {
        value: "advanced.home.identity",
        title: "Home identity",
        category: "Advanced profile",
        description: "Choose the generated title or mascot identity for Home.",
        status: mend.profile.identity.logoMode === "mascot" ? "ASCII mascot" : "ASCII title",
        onSelect: showHomeIdentityMode,
      },
      {
        value: "advanced.home.title",
        title: "Home title text",
        category: "Advanced profile",
        description: "Change the product name used by Home and the default terminal title.",
        status: mend.profile.identity.productName || "MendCode",
        onSelect: showHomeTitleText,
      },
      {
        value: "advanced.home.mascot",
        title: "Home mascot ASCII",
        category: "Advanced profile",
        description: "Replace or reset the Home mascot text.",
        status: mend.profile.surfaces.homeLogo?.text ? "custom" : "default",
        onSelect: showHomeMascotText,
      },
      {
        value: "advanced.home.font",
        title: "Home title font",
        category: "Advanced profile",
        description: "Choose the ASCII title renderer.",
        status:
          mend.profile.identity.logoFont === "small"
            ? "Small"
            : mend.profile.identity.logoFont === "standard"
              ? "Standard"
              : mend.profile.identity.logoFont === "shadow"
                ? "Shadow"
                : "MendCode",
        onSelect: showHomeLogoFont,
      },
      {
        value: "advanced.home.welcome",
        title: "Home welcome layout",
        category: "Advanced profile",
        description: "Choose centered or split Home content.",
        status: mend.profile.surfaces.homeWelcome?.mode === "split" ? "Split" : "Centered",
        onSelect: showHomeWelcomeMode,
      },
      {
        value: "advanced.home.panel",
        title: "Home split panel",
        category: "Advanced profile",
        description: "Choose actions or Agent View for the split panel.",
        status: mend.profile.surfaces.homeWelcome?.rightPanel === "actions" ? "Actions" : "Agent View",
        onSelect: showHomeSplitPanel,
      },
      {
        value: "advanced.prompt.chrome",
        title: "Prompt chrome",
        category: "Advanced profile",
        description: "Choose the prompt frame and border treatment.",
        status:
          mend.profile.promptChrome.preset === "top-bottom"
            ? "Top + bottom"
            : mend.profile.promptChrome.preset === "ascii-box"
              ? "ASCII box"
              : mend.profile.promptChrome.preset === "minimal"
                ? "Minimal"
                : "Full box",
        onSelect: showPromptChromePresets,
      },
      {
        value: "advanced.prompt.lead",
        title: "Prompt lead string",
        category: "Advanced profile",
        description: "Change the marker displayed before prompt input.",
        status: mend.profile.promptChrome.glyphs?.leadText || "blank",
        onSelect: showPromptLeadString,
      },
      {
        value: "advanced.prompt.status",
        title: "Prompt status placement",
        category: "Advanced profile",
        description: "Choose where prompt metadata is rendered.",
        status:
          (mend.profile.promptStatus.placementByPreset?.[mend.profile.promptChrome.preset] ||
            (mend.profile.promptChrome.preset === "ascii-box" ? "inside" : "outside")) === "inside"
            ? "Inside"
            : "Outside",
        onSelect: showPromptStatusPlacement,
      },
      {
        value: "advanced.presentation.profile",
        title: "Chat presentation",
        category: "Advanced profile",
        description: "Choose raw, minimal, or MendCode message presentation.",
        status: presentationProfileTitle(mend.profile.presentation.profile),
        onSelect: showPresentationProfile,
      },
      {
        value: "advanced.presentation.renderer",
        title: "Message renderer",
        category: "Advanced profile",
        description: "Choose plain, Markdown, or rich message rendering.",
        status: mend.profile.presentation.message.renderer,
        onSelect: showMessageRenderer,
      },
      {
        value: "advanced.compaction.style",
        title: "Context pack presentation",
        category: "Context pack",
        description: "Choose the normal, arcade, minimal, or quiet context packing surface.",
        status: compactionStyleTitle(mend.profile.presentation.compaction.style),
        onSelect: showCompactionStyle,
      },
      {
        value: "advanced.compaction.arcade",
        title: "Context pack arcade",
        category: "Context pack",
        description: "Choose Snake, Stars, Blocks, or no arcade surface during compaction.",
        status: compactionArcadeTitle(mend.profile.presentation.compaction.arcade),
        onSelect: showCompactionArcade,
      },
      {
        value: "advanced.compaction.progress",
        title: "Context pack progress",
        category: "Context pack",
        description: "Show or hide the context packing stage row.",
        status: mend.profile.presentation.compaction.showProgress ? "On" : "Off",
        onSelect: showCompactionProgress,
      },
      {
        value: "advanced.compaction.scratchpad",
        title: "Context pack scratchpad",
        category: "Context pack",
        description: "Show or hide the editable follow-up scratchpad.",
        status: mend.profile.presentation.compaction.allowScratchpad ? "On" : "Off",
        onSelect: showCompactionScratchpad,
      },
      {
        value: "advanced.prompt.submit",
        title: "Submit scroll behavior",
        category: "Advanced profile",
        description: "Choose how the session follows submitted prompts.",
        status: sessionSubmitScrollMode() === "clear" ? "Clear sent message" : "Normal follow",
        onSelect: showSessionSubmitScrollMode,
      },
      {
        value: "advanced.api",
        title: "View customization API",
        category: "About & API",
        description: "Inspect public extension surfaces and safe routing capabilities.",
        status: "read-only",
        onSelect: showCustomizationCapabilities,
      },
    ]
    dialog.replace(() => <DialogCustomization actions={actions} />)
    dialog.setSize("command")
  }
  const editMemoryEntry = async (entry: MemoryEntry) => {
    const text = await DialogPrompt.show(dialog, `Edit ${entry.scope} memory`, {
      value: entry.text,
      placeholder: "Memory text",
    })
    if (!text?.trim()) return
    await updateMemoryEntry(entry.scope, entry.id, { text }, memoryRoot())
    toast.show({ variant: "success", message: "Memory updated.", duration: 3000 })
    await showMemoryManager(entry.scope)
  }
  const deleteMemoryEntryFromDialog = async (entry: MemoryEntry) => {
    const ok = await DialogConfirm.show(
      dialog,
      "Delete Memory",
      `Delete this ${entry.scope} memory?\n\n${entry.text.slice(0, 240)}`,
      "keep",
    )
    if (!ok) return
    await deleteMemoryEntry(entry.scope, entry.id, memoryRoot())
    toast.show({ variant: "success", message: "Memory deleted.", duration: 3000 })
    await showMemoryManager(entry.scope)
  }
  const showMemoryEntryActions = (entry: MemoryEntry) => {
    dialog.replace(() => (
      <DialogSelect
        title="Memory Entry"
        options={[
          {
            title: "[edit] Edit memory",
            value: "edit",
            category: entry.scope,
            description: entry.text,
            onSelect: () => void editMemoryEntry(entry),
          },
          {
            title: "[delete] Delete memory",
            value: "delete",
            category: entry.scope,
            description: "Remove this memory entry.",
            onSelect: () => void deleteMemoryEntryFromDialog(entry),
          },
          {
            title: "[info] View details",
            value: "json",
            category: entry.scope,
            description: "Show full entry metadata.",
            onSelect: async () => {
              await showDialogObject(dialog, "Memory Entry", entry)
            },
          },
        ]}
      />
    ))
  }
  const addMemoryEntryFromDialog = async (scope: "global" | "project") => {
    const text = await DialogPrompt.show(dialog, `Add ${scope} memory`, { placeholder: "Memory text" })
    if (!text?.trim()) return
    await appendMemoryEntry({ scope, text, source: "tui-memory-manager" }, memoryRoot())
    toast.show({ variant: "success", message: `${scope} memory added.`, duration: 3000 })
    await showMemoryManager(scope)
  }
  const memoryProposalApplyLabel = (proposal: MemoryProposal) => {
    const operation = proposal.operation ?? "add"
    if (operation === "update") return "Update memory"
    if (operation === "remove") return "Remove memory"
    return "Save as memory"
  }
  const memoryProposalAppliedLabel = (proposal: MemoryProposal) => {
    const operation = proposal.operation ?? "add"
    if (operation === "update") return "Memory updated"
    if (operation === "remove") return "Memory removed"
    return "Memory saved"
  }
  const memoryProposalDescription = (proposal: MemoryProposal) => {
    const operation = proposal.operation ?? "add"
    const target = proposal.targetEntryID ? ` · target ${proposal.targetEntryID}` : ""
    return `${operation} · ${proposal.scope} · ${proposal.sensitivity}${target}`
  }
  const editMemoryProposalFromDialog = async (proposal: MemoryProposal) => {
    const text = await DialogPrompt.show(dialog, "Edit memory proposal", {
      value: proposal.text,
      placeholder: "Memory text",
    })
    if (!text?.trim()) return
    await updateMemoryProposal(proposal.id, { text }, memoryRoot())
    toast.show({ variant: "success", message: "Memory proposal updated.", duration: 3000 })
    await showMemoryManager("proposals")
  }
  const changeMemoryProposalScope = async (proposal: MemoryProposal, scope: "global" | "project") => {
    if (proposal.scope === scope) return
    await updateMemoryProposal(proposal.id, { scope }, memoryRoot())
    toast.show({ variant: "success", message: `Memory proposal moved to ${scope}.`, duration: 3000 })
    await showMemoryManager("proposals")
  }
  const showMemoryProposalActions = (proposal: MemoryProposal) => {
    dialog.replace(() => (
      <DialogSelect
        title="Memory Proposal"
        options={[
          {
            title: "[edit] Edit before saving",
            value: "edit",
            category: proposal.scope,
            description: "Adjust the proposal text before applying it.",
            disabled: proposal.status !== "pending",
            onSelect: () => void editMemoryProposalFromDialog(proposal),
          },
          {
            title: proposal.scope === "global" ? "[scope] Move to project" : "[scope] Move to global",
            value: "scope",
            category: proposal.scope,
            description:
              (proposal.operation ?? "add") === "add"
                ? "Change where this memory will live before applying it."
                : "Targeted update/remove proposals keep the scope of their target memory.",
            disabled: proposal.status !== "pending" || (proposal.operation ?? "add") !== "add",
            onSelect: () =>
              void changeMemoryProposalScope(proposal, proposal.scope === "global" ? "project" : "global"),
          },
          {
            title: `[apply] ${memoryProposalApplyLabel(proposal)}`,
            value: "apply",
            category: proposal.scope,
            description: memoryProposalDescription(proposal),
            disabled: proposal.status !== "pending",
            onSelect: async () => {
              await applyMemoryProposal(proposal.id, memoryRoot())
              toast.show({ variant: "success", message: `${memoryProposalAppliedLabel(proposal)}.`, duration: 3000 })
              await showMemoryManager("proposals")
            },
          },
          {
            title: "[reject] Dismiss proposal",
            value: "reject",
            category: proposal.scope,
            description: proposal.text,
            disabled: proposal.status !== "pending",
            onSelect: async () => {
              await rejectMemoryProposal(proposal.id, memoryRoot())
              toast.show({ variant: "success", message: "Memory proposal rejected.", duration: 3000 })
              await showMemoryManager("proposals")
            },
          },
          {
            title: "[info] View details",
            value: "json",
            category: proposal.status,
            description: proposal.reason || "Show full proposal metadata.",
            onSelect: async () => {
              await showDialogObject(dialog, "Memory Proposal", proposal)
            },
          },
        ]}
      />
    ))
  }
  const applyMemoryProposalsBulk = async (proposals: MemoryProposal[], label = "pending") => {
    const pending = proposals.filter((proposal) => proposal.status === "pending")
    if (!pending.length) return
    const ok = await DialogConfirm.show(
      dialog,
      "Apply Memory Proposals",
      `Apply ${pending.length} ${label} memory proposal${pending.length === 1 ? "" : "s"}? Add proposals create memories, update proposals replace target memories, and remove proposals delete target memories.`,
      "cancel",
    )
    if (!ok) return
    let applied = 0
    for (const proposal of pending) {
      await applyMemoryProposal(proposal.id, memoryRoot())
      applied++
    }
    toast.show({
      variant: "success",
      message: `${applied} memory proposal${applied === 1 ? "" : "s"} applied.`,
      duration: 3000,
    })
    await showMemoryManager("proposals")
  }
  const rejectMemoryProposalsBulk = async (proposals: MemoryProposal[], label = "pending") => {
    const pending = proposals.filter((proposal) => proposal.status === "pending")
    if (!pending.length) return
    const ok = await DialogConfirm.show(
      dialog,
      "Reject Memory Proposals",
      `Reject ${pending.length} ${label} memory proposal${pending.length === 1 ? "" : "s"}?`,
      "cancel",
    )
    if (!ok) return
    let rejected = 0
    for (const proposal of pending) {
      await rejectMemoryProposal(proposal.id, memoryRoot())
      rejected++
    }
    toast.show({
      variant: "success",
      message: `${rejected} memory proposal${rejected === 1 ? "" : "s"} rejected.`,
      duration: 3000,
    })
    await showMemoryManager("proposals")
  }
  const showMemoryManager = async (tab: "global" | "project" | "proposals" = "proposals") => {
    const root = memoryRoot()
    const [status, globalEntries, projectEntries, proposals] = await Promise.all([
      memoryStatus(root),
      readMemoryEntries("global", root),
      readMemoryEntries("project", root),
      listMemoryProposals(root, "pending"),
    ])
    const projectProposals = proposals.filter((proposal) => proposal.scope === "project")
    const globalProposals = proposals.filter((proposal) => proposal.scope === "global")
    const bulkOptions: MemoryManagerOption[] = [
      ...(proposals.length
        ? [
            {
              title: `[apply] Apply all pending (${proposals.length})`,
              value: "bulk-apply-all",
              category: "Bulk actions",
              description: "Apply every pending add, update, and remove proposal.",
              previewTitle: "Apply all pending proposals",
              previewBody: `Apply all ${proposals.length} pending memory proposal${proposals.length === 1 ? "" : "s"}. Add creates entries, update replaces target entries, and remove deletes target entries.`,
              previewMeta: "bulk · all scopes",
              onSelect: () => void applyMemoryProposalsBulk(proposals, "pending"),
            },
            {
              title: `[reject] Reject all pending (${proposals.length})`,
              value: "bulk-reject-all",
              category: "Bulk actions",
              description: "Dismiss every pending proposal.",
              previewTitle: "Reject all pending proposals",
              previewBody: `Reject all ${proposals.length} pending memory proposal${proposals.length === 1 ? "" : "s"}. Rejected proposals disappear from this review queue.`,
              previewMeta: "bulk · all scopes",
              onSelect: () => void rejectMemoryProposalsBulk(proposals, "pending"),
            },
          ]
        : []),
      ...(projectProposals.length
        ? [
            {
              title: `[apply] Apply project pending (${projectProposals.length})`,
              value: "bulk-apply-project",
              category: "Bulk actions",
              description: "Apply every project-scoped pending proposal.",
              previewTitle: "Apply project proposals",
              previewBody: `Apply all ${projectProposals.length} project memory proposal${projectProposals.length === 1 ? "" : "s"}.`,
              previewMeta: "bulk · project",
              onSelect: () => void applyMemoryProposalsBulk(projectProposals, "project"),
            },
            {
              title: `[reject] Reject project pending (${projectProposals.length})`,
              value: "bulk-reject-project",
              category: "Bulk actions",
              description: "Dismiss every project-scoped pending proposal.",
              previewTitle: "Reject project proposals",
              previewBody: `Reject all ${projectProposals.length} project memory proposal${projectProposals.length === 1 ? "" : "s"}.`,
              previewMeta: "bulk · project",
              onSelect: () => void rejectMemoryProposalsBulk(projectProposals, "project"),
            },
          ]
        : []),
      ...(globalProposals.length
        ? [
            {
              title: `[reject] Reject global pending (${globalProposals.length})`,
              value: "bulk-reject-global",
              category: "Bulk actions",
              description: "Dismiss every global-scoped pending proposal.",
              previewTitle: "Reject global proposals",
              previewBody: `Reject all ${globalProposals.length} global memory proposal${globalProposals.length === 1 ? "" : "s"}. Useful when project facts were proposed too broadly.`,
              previewMeta: "bulk · global",
              onSelect: () => void rejectMemoryProposalsBulk(globalProposals, "global"),
            },
          ]
        : []),
    ]
    const proposalOptions: MemoryManagerOption[] = proposals.map((proposal) => ({
      title: `[${proposal.status}][${proposal.operation ?? "add"}] ${proposal.text.slice(0, 62)}`,
      value: proposal.id,
      category: "Proposals",
      description: memoryProposalDescription(proposal),
      footer: proposal.createdAt.slice(0, 10),
      previewTitle: proposal.status === "pending" ? "Pending memory proposal" : "Memory proposal",
      previewBody: [
        memoryProposalDescription(proposal),
        proposal.text,
        proposal.reason ? `Why: ${proposal.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      previewMeta: `${proposal.scope} · ${proposal.sensitivity} · confidence ${Math.round((proposal.confidence ?? 0) * 100)}% · durability ${Math.round((proposal.durability ?? 0) * 100)}% · change risk ${Math.round((proposal.changeRisk ?? 0) * 100)}%`,
      onSelect: () => showMemoryProposalActions(proposal),
    }))
    const statusOptions: MemoryManagerOption[] = [
      {
        title: `Status: ${status.enabled ? "enabled" : "disabled"} · pending ${status.proposals.pending}`,
        value: "memory-status",
        category: "Status",
        description: `input ${status.input ? "on" : "off"} · learning ${status.output ? "on" : "off"} · extractor ${status.extractorRole}`,
        previewTitle: "MendCode Memory",
        previewBody: [
          `Status: ${status.enabled ? "enabled" : "disabled"}`,
          `Input memory: ${status.input ? "on" : "off"} · transient project memories are injected into each request`,
          `Memory learning: ${status.output ? "on" : "off"} · creates approval-gated proposals after chats`,
          `Entries: global ${status.entries.global.count} · project ${status.entries.project.count}`,
          `Proposals: pending ${status.proposals.pending} · applied ${status.proposals.applied} · rejected ${status.proposals.rejected}`,
          `Runtime caps: project ${status.projectMaxEntries}/request · global ${status.globalCompactionMaxEntries}/after compaction`,
          `Extractor: ${status.extractorRole} · output model calls ${status.outputCallsProviders ? "possible" : "off"}`,
          `Dream consolidation: ${status.dreamConsolidationPolicy}`,
          `Project path: ${status.paths.projectEntries}`,
          `Global path: ${status.paths.globalEntries}`,
        ].join("\n"),
        previewMeta: `context ${status.maxPromptTokens} tokens · max ${status.maxEntries} manual entries`,
      },
    ]
    const configOptions: MemoryManagerOption[] = [
      {
        title: status.input && !status.output ? "[on] Memory input enabled" : "Enable memory input only",
        value: "memory-enable-input",
        category: "Settings",
        description: "Inject saved memory into requests without generating new proposals.",
        previewTitle: "Enable memory input",
        previewBody:
          "Saved memory will be available to future model requests. Automatic memory proposal generation stays off.",
        previewMeta: "project config",
        onSelect: () =>
          void updateMemoryConfigFromDialog(
            { enabled: true, use: true, generate: false },
            "Memory input enabled. Output proposals remain off.",
          ),
      },
      {
        title:
          status.input && status.output ? "[on] Memory input and learning enabled" : "Enable memory input and learning",
        value: "memory-enable-io",
        category: "Settings",
        description: "Inject memory and create approval-gated proposals after chats.",
        previewTitle: "Enable memory input and learning",
        previewBody:
          "Saved memory will be available to future model requests, and durable new facts can appear here as pending proposals for review.",
        previewMeta: "project config · approval-gated",
        onSelect: () =>
          void updateMemoryConfigFromDialog(
            { enabled: true, use: true, generate: true, requireApprovalForGenerated: true },
            "Memory input and approval-gated output enabled.",
          ),
      },
      {
        title: status.enabled ? "Disable memory" : "[off] Memory disabled",
        value: "memory-disable",
        category: "Settings",
        description: "Stop memory injection and automatic proposal generation.",
        previewTitle: "Disable memory",
        previewBody:
          "Saved memory entries and pending proposals remain on disk, but they will not be injected or generated while memory is disabled.",
        previewMeta: "project config",
        onSelect: () =>
          void updateMemoryConfigFromDialog({ enabled: false, use: false, generate: false }, "Memory disabled."),
      },
    ]
    const manualActionOptions: MemoryManagerOption[] = [
      {
        title: "[+] Add global memory",
        value: "add-global",
        category: "Manual actions",
        description: "Create a memory that follows you across projects.",
        previewTitle: "Add global memory",
        previewBody:
          "Create a cross-project memory entry. Use this for durable preferences, workflow rules, and decisions that should follow you between repos.",
        previewMeta: "scope: global",
        onSelect: () => void addMemoryEntryFromDialog("global"),
      },
      {
        title: "[+] Add project memory",
        value: "add-project",
        category: "Manual actions",
        description: "Create a memory only for this repo.",
        previewTitle: "Add project memory",
        previewBody:
          "Create a memory only for the current repo. Use this for repo-specific constraints, architecture decisions, or warnings that should not leak globally.",
        previewMeta: "scope: project",
        onSelect: () => void addMemoryEntryFromDialog("project"),
      },
    ]
    const savedMemoryOptions: MemoryManagerOption[] = [
      ...globalEntries.map((entry) => ({
        title: `[global] ${entry.text.slice(0, 70)}`,
        value: entry.id,
        category: "Saved memories",
        description: entry.tags.length ? entry.tags.join(", ") : entry.source,
        footer: entry.updatedAt.slice(0, 10),
        previewTitle: "Global memory",
        previewBody: entry.text,
        previewMeta: `${entry.scope} · ${entry.sensitivity} · ${entry.updatedAt.slice(0, 10)}`,
        onSelect: () => showMemoryEntryActions(entry),
      })),
      ...projectEntries.map((entry) => ({
        title: `[project] ${entry.text.slice(0, 69)}`,
        value: entry.id,
        category: "Saved memories",
        description: entry.tags.length ? entry.tags.join(", ") : entry.source,
        footer: entry.updatedAt.slice(0, 10),
        previewTitle: "Project memory",
        previewBody: entry.text,
        previewMeta: `${entry.scope} · ${entry.sensitivity} · ${entry.updatedAt.slice(0, 10)}`,
        onSelect: () => showMemoryEntryActions(entry),
      })),
    ]
    const options: MemoryManagerOption[] = [
      ...statusOptions,
      ...configOptions,
      ...bulkOptions,
      ...proposalOptions,
      ...manualActionOptions,
      ...savedMemoryOptions,
    ]
    const current =
      tab === "global"
        ? globalEntries[0]?.id
        : tab === "project"
          ? projectEntries[0]?.id
          : (bulkOptions[0]?.value ?? proposals[0]?.id ?? statusOptions[0]?.value)
    dialog.replace(() => (
      <DialogSelect
        title="Memory Manager"
        current={current}
        options={options}
        preview={(option) => <MemoryManagerPreview option={option as MemoryManagerOption} />}
      />
    ))
    dialog.setSize("xlarge")
  }
  command.register(() => [
    {
      title: "Approval mode",
      value: "mendcode.permission.status",
      category: mendCategory,
      description: "Set the default Approval Mode for a future session",
      slash: { name: "permission", aliases: ["permissions", "approval"] },
      enabled: route.data.type === "home",
      onSelect: () => {
        void showDefaultPermissionMode().catch((error) => {
          toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
        })
      },
    },
    {
      title: "Status",
      value: "mendcode.status",
      category: mendCategory,
      suggested: true,
      onSelect: () => void showMendStatus(),
    },
    {
      title: "Setup",
      value: "mendcode.setup",
      category: mendCategory,
      slash: { name: "setup", aliases: ["configure", "onboarding"] },
      onSelect: () => {
        dialog.clear()
        route.navigate(setupRoute())
      },
    },
    {
      title: "Connect Provider",
      value: "mendcode.ai.status",
      category: mendCategory,
      onSelect: () => {
        dialog.clear()
        route.navigate(setupRoute("provider"))
      },
    },
    {
      title: "Configure Models",
      value: "mendcode.models.status",
      category: mendCategory,
      onSelect: () => {
        dialog.clear()
        route.navigate(setupRoute("models"))
      },
    },
    {
      title: "Configure Budget",
      value: "mendcode.budget.status",
      category: mendCategory,
      onSelect: () => {
        dialog.clear()
        route.navigate(setupRoute("budget"))
      },
    },
    {
      title: "Prompt context",
      value: "mendcode.prompt.mode",
      category: mendCategory,
      suggested: true,
      slash: { name: "prompt-mode", aliases: ["prompt", "modes"] },
      onSelect: showPromptModes,
    },
    {
      title: "Mode picker",
      value: "agent.mode.picker",
      keybind: "agent_mode_picker",
      category: mendCategory,
      suggested: true,
      enabled: promptRouteActive(),
      onSelect: showAgentModePicker,
    },
    {
      title: "Prompt chrome",
      value: "mendcode.prompt.chrome",
      category: mendCategory,
      suggested: true,
      slash: { name: "prompt-chrome", aliases: ["chatinput", "prompt-style", "tui-prompt"] },
      onSelect: showPromptChromePresets,
    },
    {
      title: "Chat presentation",
      value: "mendcode.presentation.profile",
      category: mendCategory,
      suggested: true,
      slash: { name: "presentation", aliases: ["chat-presentation", "render-mode"] },
      onSelect: showPresentationProfile,
    },
    {
      title: "Message rendering",
      value: "mendcode.message.renderer",
      category: mendCategory,
      suggested: true,
      slash: { name: "message-rendering", aliases: ["message-renderer", "markdown-rendering"] },
      onSelect: showMessageRenderer,
    },
    {
      title: "Submit scroll behavior",
      value: "mendcode.session.submit_scroll",
      category: mendCategory,
      suggested: true,
      slash: { name: "submit-scroll", aliases: ["send-scroll", "clear-submit"] },
      onSelect: showSessionSubmitScrollMode,
    },
    {
      title: "Prompt lead string",
      value: "mendcode.prompt.lead",
      category: mendCategory,
      onSelect: () => void showPromptLeadString(),
    },
    {
      title: "Prompt status placement",
      value: "mendcode.prompt.status.placement",
      category: mendCategory,
      onSelect: showPromptStatusPlacement,
    },
    {
      title: "Prompt status left script",
      value: "mendcode.prompt.status.script.left",
      category: mendCategory,
      onSelect: () => void showPromptStatusScript("left"),
    },
    {
      title: "Prompt status right script",
      value: "mendcode.prompt.status.script.right",
      category: mendCategory,
      onSelect: () => void showPromptStatusScript("right"),
    },
    {
      title: "Prompt status left builtins",
      value: "mendcode.prompt.status.left",
      category: mendCategory,
      onSelect: () => void showPromptStatusBuiltins("left"),
    },
    {
      title: "Prompt status right builtins",
      value: "mendcode.prompt.status.right",
      category: mendCategory,
      onSelect: () => void showPromptStatusBuiltins("right"),
    },
    {
      title: "Prompt status separator",
      value: "mendcode.prompt.status.separator",
      category: mendCategory,
      onSelect: () => void showPromptStatusSeparator(),
    },
    {
      title: "Home identity",
      value: "mendcode.home.identity",
      category: mendCategory,
      suggested: true,
      onSelect: showHomeIdentityMode,
    },
    {
      title: "Home title text",
      value: "mendcode.home.title",
      category: mendCategory,
      onSelect: () => void showHomeTitleText(),
    },
    {
      title: "Home mascot ASCII",
      value: "mendcode.home.logo.text",
      category: mendCategory,
      onSelect: () => void showHomeMascotText(),
    },
    {
      title: "Home title font",
      value: "mendcode.home.font",
      category: mendCategory,
      onSelect: showHomeLogoFont,
    },
    {
      title: "Home welcome mode",
      value: "mendcode.home.welcome",
      category: mendCategory,
      suggested: true,
      onSelect: showHomeWelcomeMode,
    },
    {
      title: "Home split panel",
      value: "mendcode.home.split.panel",
      category: mendCategory,
      suggested: true,
      onSelect: showHomeSplitPanel,
    },
    {
      title: "Cycle prompt mode",
      value: "mendcode.prompt.mode.cycle",
      category: mendCategory,
      hidden: true,
      onSelect: async () => {
        const result = await cyclePromptMode(mend.root)
        await mend.reload()
        toast.show({ variant: "info", message: `Prompt mode is now ${result.mode}.`, duration: 4000 })
      },
    },
    {
      title: "Customize TUI",
      value: "mendcode.customization.open",
      category: mendCategory,
      suggested: true,
      slash: { name: "customize", aliases: ["customization", "capabilities", "tui-customization"] },
      onSelect: showCustomization,
    },
    {
      title: "Customization capabilities",
      value: "mendcode.customization.capabilities",
      category: mendCategory,
      onSelect: () => void showCustomizationCapabilities(),
    },
    {
      title: "Create/update local package",
      value: "mendcode.packages.create",
      category: mendCategory,
      suggested: true,
      onSelect: () => void showPackageAuthorWizard(),
    },
    {
      title: "Manage/install packages",
      value: "mendcode.packages",
      category: mendCategory,
      suggested: true,
      slash: { name: "packages", aliases: ["package", "packs"] },
      onSelect: () => void showPackageManager(),
    },
    {
      title: "Deselect all packages",
      value: "mendcode.packages.disableAll",
      category: mendCategory,
      onSelect: () => void showPackageManager(),
    },
    {
      title: "Marketplace",
      value: "mendcode.marketplace",
      category: mendCategory,
      suggested: true,
      slash: { name: "marketplace" },
      onSelect: () => void showRegistryMarketplace(),
    },
    {
      title: "Runtime registry status",
      value: "mendcode.registry.status",
      category: mendCategory,
      onSelect: async () => {
        await DialogAlert.show(
          dialog,
          "MendCode Runtime Registry",
          registryStatusText(await runtimeRegistryStatus(mend.root)),
        )
      },
    },
    {
      title: "Memory Manager",
      value: "mendcode.memory.status",
      category: mendCategory,
      suggested: true,
      slash: { name: "memory-manager", aliases: ["mem", "memory"] },
      onSelect: () => void showMemoryManager("proposals"),
    },
    {
      title: "Memory Center",
      value: "mendcode.memory.manager",
      category: mendCategory,
      suggested: true,
      slash: { name: "memory-center", aliases: ["memories"] },
      onSelect: () => {
        dialog.clear()
        route.navigate({
          type: "memory",
          returnTo:
            route.data.type === "session" ? { type: "session", sessionID: route.data.sessionID } : { type: "home" },
        })
      },
    },
    {
      title: "Open Memory Graph",
      value: "mendcode.memory.graph",
      category: mendCategory,
      suggested: true,
      slash: { name: "memory-graph", aliases: ["graph"] },
      onSelect: () => {
        dialog.clear()
        route.navigate({
          type: "memory",
          view: "graph",
          returnTo:
            route.data.type === "session" ? { type: "session", sessionID: route.data.sessionID } : { type: "home" },
        })
      },
    },
    {
      title: "Enable memory input",
      value: "mendcode.memory.input.enable",
      category: mendCategory,
      hidden: true,
      onSelect: async (dialog) => {
        await writeProjectMemoryConfig({ enabled: true, use: true, generate: false }, memoryRoot())
        await mend.reload()
        toast.show({
          variant: "success",
          message: "Memory input enabled. Output proposals remain off.",
          duration: 4000,
        })
        dialog.clear()
      },
    },
    {
      title: "Enable memory input and output",
      value: "mendcode.memory.io.enable",
      category: mendCategory,
      hidden: true,
      onSelect: async (dialog) => {
        await writeProjectMemoryConfig(
          { enabled: true, use: true, generate: true, requireApprovalForGenerated: true },
          memoryRoot(),
        )
        await mend.reload()
        toast.show({ variant: "success", message: "Memory input and approval-gated output enabled.", duration: 4000 })
        dialog.clear()
      },
    },
    {
      title: "Disable memory",
      value: "mendcode.memory.disable",
      category: mendCategory,
      hidden: true,
      onSelect: async (dialog) => {
        await writeProjectMemoryConfig({ enabled: false, use: false, generate: false }, memoryRoot())
        await mend.reload()
        toast.show({ variant: "success", message: "Memory disabled.", duration: 4000 })
        dialog.clear()
      },
    },
    {
      title: "Usage Insights",
      value: "mendcode.stats.insights",
      category: mendCategory,
      suggested: true,
      slash: { name: "stats", aliases: ["usage", "insights", "activity"] },
      onSelect: (dialog) => {
        route.navigate(statsRoute("global"))
        dialog.clear()
      },
    },
    {
      title: "Project Usage Insights",
      value: "mendcode.stats.project",
      category: mendCategory,
      slash: { name: "stats-project", aliases: ["project-stats", "project-usage"] },
      onSelect: (dialog) => {
        route.navigate(statsRoute("project"))
        dialog.clear()
      },
    },
    {
      title: "Loop Workflows",
      value: "mendcode.loops.dashboard",
      category: mendCategory,
      suggested: true,
      slash: { name: "loops", aliases: ["loop-dashboard", "loop-center"] },
      onSelect: (dialog) => {
        route.navigate(loopsRoute())
        dialog.clear()
      },
    },
    {
      title: "Create Loop Workflow",
      value: "mendcode.loop.create",
      category: mendCategory,
      description: "Create or control a Loop Workflow from the current prompt",
      slash: { name: "loop" },
      enabled: route.data.type !== "session",
      onSelect: (dialog) => {
        dialog.clear()
        route.navigate({ type: "home" })
        setTimeout(() => fillLoopSlashPrompt(""), 0)
      },
      onSlash: (dialog, input) => {
        dialog.clear()
        route.navigate({ type: "home" })
        setTimeout(() => fillLoopSlashPrompt(input.arguments, true), 0)
      },
    },
    {
      title: "Changes Review",
      value: "mendcode.changes.review",
      category: mendCategory,
      suggested: true,
      slash: { name: "changes", aliases: ["diff", "review-changes"] },
      onSelect: (dialog) => {
        route.navigate(changesRoute())
        dialog.clear()
      },
    },
    {
      title: "Skills, commands, prompt assets",
      value: "mendcode.assets",
      category: mendCategory,
      slash: { name: "mend-assets" },
      onSelect: () => void showMendAssets(),
    },
    {
      title: "Slash commands",
      value: "mendcode.slash.commands",
      category: mendCategory,
      onSelect: () => void showSlashCommands(),
    },
    {
      title: "Configure runtime",
      value: "mendcode.runtime.configure",
      category: mendCategory,
      onSelect: async () => {
        const preview = formatRuntimePackPlan(await runtimePackPlan("preview", mend.root))
        const confirmed = await DialogConfirm.show(
          dialog,
          "MendCode Runtime",
          `${preview}\n\nApply this local runtime pack now?`,
        )
        if (!confirmed) return
        const result = await applyRuntimePack(mend.root)
        toast.show({
          variant: "success",
          message: `Runtime pack applied to ${result.packPath}`,
          duration: 5000,
        })
      },
    },
    {
      title: "TSM",
      value: "mendcode.tsm.status",
      category: mendCategory,
      slash: { name: "tsm" },
      onSelect: () => void showTsmManager(),
    },
    {
      title: "Worktrees",
      value: "mendcode.worktree.manager",
      category: mendCategory,
      slash: { name: "worktrees" },
      onSelect: () => void showWorktreeManager(),
    },
    {
      title: "Mflow",
      value: "mendcode.mflow.status",
      category: mendCategory,
      slash: { name: "mflow" },
      onSelect: () => void showMflowManager(),
    },
    {
      title: "Configure and turn on mflow",
      value: "mendcode.mflow.activate",
      category: mendCategory,
      onSelect: () => void configureAndActivateMflowFromTui(),
    },
    {
      title: "Deactivate mflow",
      value: "mendcode.mflow.deactivate",
      category: mendCategory,
      onSelect: () => void deactivateMflowFromTui(),
    },
    {
      title: "Remove mflow config",
      value: "mendcode.mflow.remove",
      category: mendCategory,
      onSelect: () => void removeMflowFromTui(),
    },
    {
      title: "Switch session",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      suggested: sync.data.session.length > 0,
      slash: {
        name: "sessions",
        aliases: ["resume", "continue"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: "New session",
      suggested: route.data.type === "session",
      value: "session.new",
      keybind: "session_new",
      category: "Session",
      slash: {
        name: "new",
        aliases: ["clear"],
      },
      onSelect: () => {
        route.navigate({
          type: "home",
        })
        dialog.clear()
      },
    },
    {
      title: "Switch model",
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: "Agent",
      enabled: promptRouteActive(),
      slash: {
        name: "models",
      },
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: "Model cycle",
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: "Agent",
      hidden: true,
      enabled: promptRouteActive(),
      onSelect: () => {
        local.model.cycle(1)
      },
    },
    {
      title: "Model cycle reverse",
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: "Agent",
      hidden: true,
      enabled: promptRouteActive(),
      onSelect: () => {
        local.model.cycle(-1)
      },
    },
    {
      title: "Favorite cycle",
      value: "model.cycle_favorite",
      keybind: "model_cycle_favorite",
      category: "Agent",
      hidden: true,
      enabled: promptRouteActive(),
      onSelect: () => {
        local.model.cycleFavorite(1)
      },
    },
    {
      title: "Favorite cycle reverse",
      value: "model.cycle_favorite_reverse",
      keybind: "model_cycle_favorite_reverse",
      category: "Agent",
      hidden: true,
      enabled: promptRouteActive(),
      onSelect: () => {
        local.model.cycleFavorite(-1)
      },
    },
    {
      title: "Switch agent",
      value: "agent.list",
      keybind: "agent_list",
      category: "Agent",
      enabled: promptRouteActive(),
      slash: {
        name: "agents",
      },
      onSelect: () => {
        dialog.replace(() => <DialogAgent />)
      },
    },
    {
      title: "Toggle MCPs",
      value: "mcp.list",
      category: "Agent",
      slash: {
        name: "mcps",
      },
      onSelect: () => {
        dialog.replace(() => <DialogMcp />)
      },
    },
    {
      title: "Agent cycle",
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: "Agent",
      hidden: true,
      enabled: promptRouteActive(),
      onSelect: () => {
        local.agent.move(1)
        local.model.pinAgentCurrent()
      },
    },
    {
      title: "Variant cycle",
      value: "variant.cycle",
      keybind: "variant_cycle",
      category: "Agent",
      enabled: promptRouteActive(),
      onSelect: () => {
        local.model.variant.cycle()
      },
    },
    {
      title: "Switch model variant",
      value: "variant.list",
      keybind: "variant_list",
      category: "Agent",
      hidden: local.model.variant.list().length === 0,
      enabled: promptRouteActive(),
      slash: {
        name: "variants",
      },
      onSelect: () => {
        dialog.replace(() => <DialogVariant />)
      },
    },
    {
      title: "Agent cycle reverse",
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: "Agent",
      hidden: true,
      enabled: promptRouteActive(),
      onSelect: () => {
        local.agent.move(-1)
        local.model.pinAgentCurrent()
      },
    },
    {
      title: "Connect Provider",
      value: "provider.connect",
      suggested: !connected(),
      slash: {
        name: "connect",
      },
      onSelect: () => {
        dialog.replace(() => <DialogProviderList />)
      },
      category: "Connect Provider",
    },
    ...(sync.data.console_state.switchableOrgCount > 1
      ? [
          {
            title: "Switch org",
            value: "console.org.switch",
            suggested: Boolean(sync.data.console_state.activeOrgName),
            slash: {
              name: "org",
              aliases: ["orgs", "switch-org"],
            },
            onSelect: () => {
              dialog.replace(() => <DialogConsoleOrg />)
            },
            category: "Provider",
          },
        ]
      : []),
    {
      title: "View status",
      keybind: "status_view",
      value: "mendcode.runtime.status",
      slash: {
        name: "status",
      },
      onSelect: () => {
        dialog.replace(() => <DialogStatus />)
      },
      category: "System",
    },
    {
      title: "Switch theme",
      value: "theme.switch",
      keybind: "theme_list",
      slash: {
        name: "themes",
      },
      onSelect: () => {
        dialog.replace(() => <DialogThemeList />)
      },
      category: "System",
    },
    {
      title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
      value: "theme.switch_mode",
      onSelect: (dialog) => {
        setMode(mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: "System",
    },
    {
      title: locked() ? "Unlock theme mode" : "Lock theme mode",
      value: "theme.mode.lock",
      onSelect: (dialog) => {
        if (locked()) unlock()
        else lock()
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Help",
      value: "help.show",
      keybind: ["setup", "stats", "memory", "changes", "loops"].includes(route.data.type) ? "help" : undefined,
      slash: {
        name: "help",
      },
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
      category: "System",
    },
    {
      title: "Open docs",
      value: "docs.open",
      onSelect: () => {
        open(docsPath()).catch(() => {})
        dialog.clear()
      },
      category: "System",
    },
    {
      title: "Exit the app",
      value: "app.exit",
      slash: {
        name: "exit",
        aliases: ["quit", "q"],
      },
      onSelect: () => exit(),
      category: "System",
    },
    {
      title: "Toggle debug panel",
      category: "System",
      value: "app.debug",
      onSelect: (dialog) => {
        renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: "Toggle console",
      category: "System",
      value: "app.console",
      onSelect: (dialog) => {
        renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: "Show diagnostics",
      category: "System",
      value: "app.diagnostics",
      slash: { name: "diagnostics", aliases: ["diag"] },
      hidden: !props.onDiagnostics,
      description: "Read current TUI and connected runtime diagnostics on demand.",
      onSelect: async (dialog) => {
        try {
          const diagnostics = await props.onDiagnostics?.()
          if (!diagnostics) {
            dialog.clear()
            toast.show({ variant: "error", message: "Diagnostics are unavailable.", duration: 4000 })
            return
          }
          await DialogAlert.show(
            dialog,
            "MendCode Diagnostics",
            formatDiagnostics({
              ...diagnostics,
              ui: {
                sessionCount: sync.data.session.length,
                cachedSessionCount: Object.keys(sync.data.message).length,
                cachedMessageCount: Object.values(sync.data.message).reduce(
                  (total, messages) => total + (messages?.length ?? 0),
                  0,
                ),
                cachedPartCount: Object.values(sync.data.part).reduce(
                  (total, parts) => total + (parts?.length ?? 0),
                  0,
                ),
                route: route.data.type,
              },
            }),
          )
        } catch (error) {
          dialog.clear()
          toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
        }
      },
    },
    {
      title: "Write heap snapshot",
      category: "System",
      value: "app.heap_snapshot",
      hidden: !props.onSnapshot,
      onSelect: async (dialog) => {
        const files = await props.onSnapshot?.()
        toast.show({
          variant: "info",
          message: `Heap snapshot written to ${files?.join(", ")}`,
          duration: 5000,
        })
        dialog.clear()
      },
    },
    {
      title: "Suspend terminal",
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: "System",
      hidden: true,
      enabled: tuiConfig.keybinds?.terminal_suspend !== "none",
      onSelect: () => {
        process.once("SIGCONT", () => {
          renderer.resume()
        })

        renderer.suspend()
        releaseTerminalInputModes()
        // pid=0 means send the signal to all processes in the process group
        process.kill(0, "SIGTSTP")
      },
    },
    {
      title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
      value: "terminal.title.toggle",
      keybind: "terminal_title_toggle",
      category: "System",
      onSelect: (dialog) => {
        const next = !terminalTitleEnabled()
        writeMendTuiCustomization((key, fallback) => kv.get(key, fallback), kv.set, { terminalTitle: next })
        if (!next) renderer.setTerminalTitle("")
        dialog.clear()
      },
    },
    {
      title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
      value: "app.toggle.animations",
      category: "System",
      onSelect: (dialog) => {
        kv.set("animations_enabled", !kv.get("animations_enabled", true))
        dialog.clear()
      },
    },
    {
      title: "Replay MendCode intro",
      value: "app.replay.intro",
      category: "System",
      slash: { name: "intro", aliases: ["replay-intro"] },
      description: "Preview the first-run intro without changing Setup state.",
      onSelect: () => replayFirstRunIntro(),
    },
    {
      title: kv.get("file_context_enabled", true) ? "Disable file context" : "Enable file context",
      value: "app.toggle.file_context",
      category: "System",
      onSelect: (dialog) => {
        kv.set("file_context_enabled", !kv.get("file_context_enabled", true))
        dialog.clear()
      },
    },
    {
      title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
      value: "app.toggle.paste_summary",
      category: "System",
      onSelect: (dialog) => {
        setPasteSummaryEnabled((prev) => {
          const next = !prev
          kv.set("paste_summary_enabled", next)
          return next
        })
        dialog.clear()
      },
    },
    {
      title: kv.get("session_directory_filter_enabled", true)
        ? "Disable session directory filtering"
        : "Enable session directory filtering",
      value: "app.toggle.session_directory_filter",
      category: "System",
      onSelect: async (dialog) => {
        kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
        await sync.session.refresh()
        dialog.clear()
      },
    },
    {
      title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
      value: "app.toggle.diffwrap",
      category: "System",
      onSelect: (dialog) => {
        const current = kv.get("diff_wrap_mode", "word")
        kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
        dialog.clear()
      },
    },
  ])

  event.on(TuiEvent.CommandExecute.type, (evt) => {
    command.trigger(evt.properties.command)
  })

  event.on(TuiEvent.ToastShow.type, (evt) => {
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  const backgroundTaskNotificationIDs = new Set<string>()
  const ownerWakeIDs = new Set<string>()
  event.subscribe((incoming) => {
    const evt = incoming as unknown as {
      type?: string
      properties?: {
        eventID?: string
        wakeID?: string
        parentSessionID?: string
        taskIDs?: string[]
        taskTitles?: string[]
        state?: "needs_input" | "completed" | "failed" | "cancelled" | "interrupted"
        title?: string
        summary?: string
        error?: string
      }
    }
    if (evt.type === "background_task.owner_wake" && evt.properties?.wakeID) {
      if (ownerWakeIDs.has(evt.properties.wakeID)) return
      if (ownerWakeIDs.size >= 500) {
        const oldest = ownerWakeIDs.values().next().value
        if (oldest) ownerWakeIDs.delete(oldest)
      }
      ownerWakeIDs.add(evt.properties.wakeID)
      const titles = evt.properties.taskTitles?.filter(Boolean) ?? []
      const count = evt.properties.taskIDs?.length ?? titles.length
      toast.show({
        title: "Agent resumed",
        message: `${titles.join(", ") || `${count} background task${count === 1 ? "" : "s"}`} finished; the runtime event was delivered internally`,
        variant: "info",
        duration: 5_000,
      })
      return
    }
    if (evt.type !== "background_task.notification" || !evt.properties?.eventID || !evt.properties.state) return
    if (backgroundTaskNotificationIDs.has(evt.properties.eventID)) return
    if (backgroundTaskNotificationIDs.size >= 500) {
      const oldest = backgroundTaskNotificationIDs.values().next().value
      if (oldest) backgroundTaskNotificationIDs.delete(oldest)
    }
    backgroundTaskNotificationIDs.add(evt.properties.eventID)
    const state = evt.properties.state
    const notification = backgroundTaskToast({
      state,
      title: evt.properties.title,
      summary: evt.properties.summary,
      error: evt.properties.error,
    })
    if (notification) toast.show(notification)
  })

  event.on(TuiEvent.SessionSelect.type, (evt) => {
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt) => {
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  event.on("installation.update-available", async (evt) => {
    const version = evt.properties.version

    const skipped = kv.get("skipped_version")
    if (skipped && !semver.gt(version, skipped)) return

    const choice = await DialogConfirm.show(
      dialog,
      `Update Available`,
      `A new release v${version} is available. Would you like to update now?`,
      "skip",
    )

    if (choice === false) {
      kv.set("skipped_version", version)
      return
    }

    if (choice !== true) return

    toast.show({
      variant: "info",
      message: `Updating to v${version}...`,
      duration: 30000,
    })

    const result = await sdk.client.global.upgrade({ target: version })

    if (result.error || !result.data?.success) {
      toast.show({
        variant: "error",
        title: "Update Failed",
        message: "Update failed",
        duration: 10000,
      })
      return
    }

    await DialogAlert.show(
      dialog,
      "Update Complete",
      `Successfully updated to ${productName()} runtime v${result.data.version}. Please restart the application.`,
    )

    void exit()
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "plugin") return
    const render = routeView(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    const value = render({ params: route.data.data }) as unknown
    if (typeof value === "string" || typeof value === "number") {
      return (
        <box width="100%" height="100%" paddingLeft={2} paddingRight={2} paddingTop={1} overflow="hidden">
          <text wrapMode="word">{String(value)}</text>
        </box>
      )
    }
    if (typeof value === "boolean") return null
    return value as JSX.Element
  })
  const startupReady = createMemo(() => ready() && pluginsReady() && sync.status !== "loading")
  const startupMessage = createMemo(() =>
    startupLoadingText({ pluginsReady: pluginsReady(), syncLoading: sync.status === "loading" }),
  )

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? undefined : () => Selection.copy(renderer, toast)}
    >
      <Show when={Flag.OPENCODE_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <Switch>
          <Match when={route.data.type === "home"}>
            <Home revision={homeRevision()} pluginsReady={pluginsReady()} />
          </Match>
          <Match when={route.data.type === "session"}>
            <Session />
          </Match>
          <Match when={route.data.type === "setup"}>
            <Setup />
          </Match>
          <Match when={route.data.type === "stats"}>
            <Stats />
          </Match>
          <Match when={route.data.type === "memory"}>
            <Memory />
          </Match>
          <Match when={route.data.type === "changes"}>
            <Changes />
          </Match>
          <Match when={route.data.type === "loops"}>
            <Loops />
          </Match>
        </Switch>
      </Show>
      <ErrorBoundary
        fallback={(error) => (
          <PluginRouteError id={route.data.type === "plugin" ? route.data.id : "unknown"} error={error} />
        )}
      >
        {plugin()}
      </ErrorBoundary>
      <TuiPluginRuntime.Slot name="app" />
      <MendOverlayHost dimensions={dimensions()} />
      <StartupLoading ready={startupReady} text={startupMessage} delayMs={fastBoot ? 0 : 500} />
      <Show when={firstRunIntroVisible()}>
        <FirstRunIntro
          run={firstRunIntroRun()}
          animationsEnabled={() => kv.get("animations_enabled", true) === true}
          handoffLabel={() => (route.data.type === "setup" ? "MENDCODE / SETUP" : undefined)}
          onComplete={completeFirstRunIntro}
        />
      </Show>
    </box>
  )
}

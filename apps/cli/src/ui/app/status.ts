import type { renderStatusPage } from "../lazy-pages"
import { DEFAULT_COMPACT_AT_TOKENS } from "@mendcode/protocol/wire"
import { contextLimit } from "../../view/context-meter"
import type { DaemonInfoReport, ExtensionsReport, ModelsReport } from "@mendcode/protocol"
import type { TerminalExtension } from "../../view/extensions-page"
import type { AppContext } from "./context"
import { usageInForce } from "./usage-in-force"

export function createStatus(ctx: AppContext, actions: { loadMcps(): Promise<void>; loadStorage(): Promise<void> }) {
  const { input, state, keybindingFile, permissionLabels, stateLabels, extensionProblemLines, requestFrame } = ctx
  const { loadMcps, loadStorage } = actions

  /** What each terminal extension registered here, with the problems it raised. */
  function terminalExtensions(): TerminalExtension[] {
    const runtime = state.ext
    if (!runtime) return []
    return runtime.registrations().map((registration) => {
      const loaded = runtime.loaded.find((entry) => entry.name === registration.name)
      const conflicts = [
        ...runtime.conflicts.filter((entry) => entry.winner === registration.name || entry.loser === registration.name).map((entry) => entry.message),
        ...(state.bindings.overrides ?? []).filter((entry) => entry.owner === registration.name).map((entry) => `key ${entry.key} replaces ${entry.was}${entry.source === "keybindings.json" ? " (your keybindings.json)" : ""}`),
      ]
      return { ...registration, ...(loaded ? { source: loaded.source, enabled: loaded.enabled !== false } : {}), ...(conflicts.length ? { conflicts } : {}), errors: runtime.problems.filter((problem) => problem.extension === registration.name).map((problem) => problem.message) }
    })
  }

  /** Problems no loaded extension owns: a module that failed to load, invalid keybindings, key conflicts. */
  function otherExtensionProblems(): string[] {
    const names = new Set((state.ext?.loaded ?? []).map((entry) => entry.name))
    return [...keybindingFile.problems, ...state.extKeyProblems, ...(state.ext?.problems ?? []).filter((problem) => !names.has(problem.extension)).map((problem) => `${problem.extension}: ${problem.message}`)]
  }

  function statusInput(width: number, height: number): Parameters<typeof renderStatusPage>[0] {
    const model = state.effectiveModel?.model ?? usageInForce(state)?.model
    const contextTokens = usageInForce(state)?.contextTokens
    return {
      state: state.statusState,
      width,
      height,
      connected: state.connection === "connected",
      ...(input.version ? { cliVersion: input.version } : {}),
      ...(input.daemonBuildId ? { buildId: input.daemonBuildId } : {}),
      ...(state.statusInfo ? { info: state.statusInfo } : {}),
      ...(state.statusInfoError ? { infoError: state.statusInfoError } : {}),
      ...(state.statusModels ? { models: state.statusModels } : {}),
      session: {
        ...(model ? { model } : {}),
        ...(state.effectiveModel?.effort ? { effort: state.effectiveModel.effort } : {}),
        permission: state.transcript.permissionMode,
        permissionLabel: permissionLabels[state.transcript.permissionMode],
        state: stateLabels[state.transcript.foreground],
        ...(contextTokens !== undefined ? { context: { tokens: contextTokens, threshold: contextLimit(usageInForce(state), state.settingsNow.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS) } } : {}),
      },
      ...(state.mcpsReport ? { mcps: state.mcpsReport } : {}),
      ...(state.mcpsError ? { mcpsError: state.mcpsError } : {}),
      ...(state.extensionsReport ? { extensions: state.extensionsReport } : {}),
      ...(state.extensionsError ? { extensionsError: state.extensionsError } : {}),
      terminalExtensions: { loaded: state.ext?.loaded.length ?? 0, problems: extensionProblemLines().length },
      ...(state.storageReport ? { storage: state.storageReport } : {}),
      ...(state.storageError ? { storageError: state.storageError } : {}),
      ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    }
  }

  async function loadExtensionsReport() {
    const reply = await input.send({ type: "extensions.list", directory: input.directory ?? "" })
    if (reply.ok) {
      state.extensionsReport = reply.result as ExtensionsReport
      state.extensionsError = ""
    } else state.extensionsError = reply.error.code === "invalid_command" ? "the daemon is older than this terminal; restart it" : reply.error.message
    requestFrame()
  }

  /** Read-only facts for /status; each answer repaints when it arrives. */
  async function loadStatus() {
    await Promise.all([
      input.send({ type: "daemon.info" }).then((reply) => {
        if (reply.ok) [state.statusInfo, state.statusInfoError] = [reply.result as DaemonInfoReport, ""]
        else state.statusInfoError = reply.error.message
        requestFrame()
      }),
      input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }).then((reply) => {
        if (reply.ok) state.statusModels = reply.result as ModelsReport
        requestFrame()
      }),
      loadMcps(),
      loadStorage(),
      loadExtensionsReport(),
    ])
  }

  return { terminalExtensions, otherExtensionProblems, statusInput, loadExtensionsReport, loadStatus }
}

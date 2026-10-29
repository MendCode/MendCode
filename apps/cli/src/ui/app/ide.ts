import { ideContext, ideSelectionKey, type IdeEditorName, type IdeReport } from "@mendcode/protocol/wire"
import { preload } from "../lazy-pages"
import type { AppContext } from "./context"

export type IdeState = {
  directory: string
  sessionId: string
  report?: IdeReport
  sent?: string
  dismissed?: string
  error?: string
  scroll: number
  maxScroll?: number
  loading?: boolean
  pending?: Promise<void>
}

export function createIde(ctx: AppContext) {
  const { input, state, requestFrame } = ctx

  function current() {
    const directory = input.directory ?? ""
    if (!state.ideState || state.ideState.directory !== directory || state.ideState.sessionId !== state.sessionId) {
      state.ideState = { directory, sessionId: state.sessionId, scroll: 0 }
    }
    return state.ideState
  }

  async function load() {
    if (input.remote || !input.directory || state.ideStopped) return
    const local = current()
    if (local.pending) return local.pending
    const wasVisible = local.report?.enabled === true
    local.pending = (async () => {
      try {
        const reply = await input.send({ type: "ide.query", directory: local.directory })
        if (state.ideState !== local || state.ideStopped) return
        if (!reply.ok) local.error = reply.error.message
        else {
          const report = reply.result as IdeReport | undefined
          if (!report?.status) { local.error = "IDE bridge unavailable"; return }
          // Keep the preview through a transient database failure, without submitting stale content.
          local.report = report.status === "unavailable" && local.report?.selection ? { ...report, selection: local.report.selection } : report
          delete local.error
        }
      } catch { if (state.ideState === local) local.error = "IDE bridge unavailable" }
      finally {
        delete local.pending
        delete local.loading
        if (state.ideState === local && !state.ideStopped && (state.page === "ide" || wasVisible || local.report?.enabled)) requestFrame()
      }
    })()
    return local.pending
  }

  function syncIde() {
    if (state.ideStopped || input.remote || !input.directory || !state.statusLoaded) return
    const local = current()
    // Only the private configuration is read before opt-in; an off bridge never reads Zed.
    if (!local.report && !local.error && !local.pending) void load()
    const wanted = local.report?.enabled && (state.page === "chat" || state.page === "ide")
    if (wanted && !state.ideTimer) {
      state.ideTimer = setInterval(() => void load(), 1_000)
      state.ideTimer.unref?.()
    }
    if (!wanted && state.ideTimer) { clearInterval(state.ideTimer); state.ideTimer = undefined }
  }

  async function configure(enabled: boolean, dbPath?: string, editor?: IdeEditorName) {
    if (!input.directory || input.remote) { ctx.fail("IDE bridge is local only"); return }
    const local = current()
    // Finish any older read before changing the bridge so it cannot replace the new configuration.
    await local.pending
    const reply = await input.send({ type: "ide.configure", directory: local.directory, enabled, ...(editor ? { editor } : {}), ...(dbPath ? { dbPath } : {}) })
    if (state.ideState !== local) return
    if (!reply.ok) local.error = reply.error.message
    else {
      local.report = reply.result as IdeReport
      delete local.sent
      delete local.dismissed
      delete local.error
      local.scroll = 0
    }
    requestFrame()
  }

  function clear() {
    const local = current()
    local.dismissed = ideSelectionKey(local.report?.selection)
    requestFrame()
  }

  async function open(file?: string, line?: number, character?: number) {
    const local = current()
    const selection = local.report?.selection
    const target = file ?? selection?.filePath
    if (!target) { local.error = "No IDE file selected"; requestFrame(); return }
    const position = selection?.ranges[0]?.selection.start
    const reply = await input.send({ type: "ide.open", directory: local.directory, filePath: target, line: line ?? position?.line ?? 1, character: character ?? position?.character ?? 1 })
    if (state.ideState !== local) return
    if (!reply.ok) local.error = reply.error.message
    else if (reply.result?.opened !== true) local.error = String(reply.result?.message ?? "File could not be opened")
    else { delete local.error; ctx.say(`Opened in ${local.report?.editor === "vscode" ? "VS Code" : "Zed"}`, "success") }
    requestFrame()
  }

  async function ideCommand(args: string) {
    if (input.remote || !input.directory) { ctx.fail("IDE bridge is local only"); return }
    const match = /^(on|off|clear|refresh|open)(?:\s+([\s\S]+))?$/.exec(args.trim())
    if (args.trim() && !match) { ctx.fail("usage: /ide [on [zed|vscode|db path]|off|clear|refresh|open [path:line:column]]"); return }
    if (match?.[1] === "on") {
      const target = match[2]?.trim().replace(/^"(.*)"$/, "$1")
      if (target === "zed" || target === "vscode") await configure(true, undefined, target)
      else await configure(true, target, target ? "zed" : undefined)
    }
    else if (match?.[1] === "off") await configure(false)
    else if (match?.[1] === "clear") clear()
    else if (match?.[1] === "refresh") await load()
    else if (match?.[1] === "open") {
      const target = match[2]?.replace(/^"(.*)"$/, "$1")
      const position = target ? /^(.*?):(\d+)(?::(\d+))?$/.exec(target) : undefined
      await open(position?.[1] ?? target, position ? Number(position[2]) : undefined, position?.[3] ? Number(position[3]) : undefined)
    } else {
      await preload("ide")
      state.page = "ide"
      current().loading = true
      requestFrame()
      await load()
    }
  }

  async function ideKey(key: string) {
    const local = current()
    if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "r") await load()
    else if (key === "e") await configure(!local.report?.enabled)
    else if (key === "c") clear()
    else if (key === "o") await open()
    else if (key === "\x1b[A" || key === "k") local.scroll = Math.max(0, local.scroll - 1)
    else if (key === "\x1b[B" || key === "j") local.scroll = Math.min(local.maxScroll ?? 0, local.scroll + 1)
    else if (key === "\x1b[5~") local.scroll = Math.max(0, local.scroll - 10)
    else if (key === "\x1b[6~") local.scroll = Math.min(local.maxScroll ?? 0, local.scroll + 10)
    requestFrame()
  }

  async function prepareIdeContext(): Promise<{ text: string; markSent(): void }> {
    await load()
    const local = current()
    const selection = local.report?.status === "connected" ? local.report.selection : undefined
    const key = ideSelectionKey(selection)
    if (!selection || key === local.sent || key === local.dismissed) return { text: "", markSent() {} }
    return { text: ideContext(selection), markSent() { local.sent = key } }
  }

  return { ideCommand, ideKey, syncIde, prepareIdeContext }
}

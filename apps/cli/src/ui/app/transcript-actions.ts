import type { HistoryReport, ItemId, SessionExportResult, TimelineEntry, TurnId } from "@mendcode/protocol"
import { createEditor } from "../../view/editor"
import { draftRefs, pendingFromRefs } from "../../view/attachments"
import { quoteWithComment } from "../../view/quote"
import type { ExportOptionsState, MessageActionsState, MessageEntry } from "../../view/transcript-actions-page"
import { EXPORT_FIELDS, messageEntries } from "../lazy-pages"
import { defaultExportName, parseExportArgs, writeExport, type ExportRequest } from "../export-file"
import { loadEditorLauncher } from "../external-editor"
import { osc52Copy } from "../osc52"
import type { AppContext } from "./context"
import type { createSession } from "./session"

const FORMAT_CYCLE: ExportRequest["format"][] = ["markdown", "json", "html"]
const EXTENSIONS: Record<ExportRequest["format"], string> = { markdown: "md", json: "json", html: "html" }

export function createTranscriptActions(ctx: AppContext, actions: {
  loadPage(): Promise<void>
  sessionTitle(): string
  rewind: ReturnType<typeof createSession>["rewind"]
  forkAt: ReturnType<typeof createSession>["forkAt"]
  copyAnswer(n?: number, note?: string): void
}) {
  const { state, input, env, editor, requestFrame, fail, say } = ctx
  const filename = createEditor()
  let visit = 0

  async function loadMessages(query: { before?: number; after?: number; turnId?: TurnId } = {}, itemId?: ItemId) {
    const s = state.messageActions!
    const serial = ++visit
    const sessionId = state.sessionId
    s.loading = true
    s.error = ""
    requestFrame()
    try {
      const reply = await input.send({ type: "session.history", sessionId, ...query })
      if (visit !== serial || state.page !== "messages" || state.sessionId !== sessionId) return
      if (!reply.ok) { s.error = reply.error.message; return }
      s.report = reply.result as HistoryReport
      s.entries = messageEntries(s.report, s.pick, s.backtrack)
      const at = itemId ? s.entries.findIndex((entry) => entry.itemId === itemId) : -1
      s.selected = at >= 0 ? at : query.after !== undefined ? 0 : Math.max(0, s.entries.length - 1)
      s.scroll = 0
      if (itemId && at < 0) s.error = "Message unavailable"
    } finally {
      if (visit === serial) { s.loading = false; requestFrame() }
    }
  }

  async function openMessageActions(pick = false, itemId?: ItemId, turnId?: TurnId, backtrack = false) {
    await actions.loadPage()
    state.page = "messages"
    state.notice = ""
    state.messageActions = { entries: [], selected: 0, pick, ...(backtrack ? { backtrack } : {}), menu: !!itemId, action: 0, scroll: 0, loading: false, error: "" }
    ctx.toasts.dismiss()
    await loadMessages(turnId ? { turnId } : {}, itemId)
  }

  function copy(text: string, label: string) {
    const sequence = osc52Copy(text, { tmux: Boolean(env.TMUX) })
    if (!sequence) { fail("Text is empty or too long for the terminal clipboard"); return false }
    input.screen.write?.(sequence)
    say(label, "success")
    return true
  }

  /** Forks the session at a message and puts its prompt in the editor of the new one. */
  async function forkFrom(selected: MessageEntry) {
    const entry: TimelineEntry = { turnId: selected.turnId, itemId: selected.anchorId, at: selected.at, preview: selected.prompt, reverted: false }
    if (!(await actions.forkAt(entry))) return
    editor.replaceAll(selected.prompt)
    state.attachments = pendingFromRefs(selected.promptImages)
    ctx.drafts.changed(state.sessionId, { text: editor.text, images: selected.promptImages })
  }

  async function messagesKey(key: string) {
    const s = state.messageActions!
    if (key === "\x1b" || key === "q") {
      if (s.menu) { s.menu = false; s.error = "" }
      else { visit++; state.page = "chat" }
      return requestFrame()
    }
    if (s.loading) return
    const selected = s.entries[s.selected]
    // Backtrack (Esc-Esc): Enter reverts to the prompt and puts it back in the editor, f forks from it.
    if (s.backtrack && selected && (key === "\r" || key === "f")) {
      if (selected.promptTruncated) { s.error = "Prompt is truncated; this action needs the complete text"; return requestFrame() }
      visit++
      state.page = "chat"
      if (key === "\r") await actions.rewind("undo", false, selected.anchorId, selected.prompt, selected.promptImages)
      else await forkFrom(selected)
      return requestFrame()
    }
    if (s.menu) {
      if (key === "\x1b[A") s.action = Math.max(0, s.action - 1)
      else if (key === "\x1b[B") s.action = Math.min(3, s.action + 1)
      else if (key === "\x1b[5~") s.scroll = Math.max(0, s.scroll - 8)
      else if (key === "\x1b[6~") s.scroll += 8
      else if (selected && (key === "\r" || ["c", "r", "f", "Q"].includes(key))) {
        const action = key === "\r" ? s.action : ["c", "r", "f", "Q"].indexOf(key)
        if (action === 0 || action === 3 ? selected.truncated : selected.promptTruncated) { s.error = "Message is truncated; this action needs the complete text"; return requestFrame() }
        if (action === 0) {
          if (copy(selected.text, "Copied message")) state.page = "chat"
        } else if (action === 1) {
          state.page = "chat"
          await actions.rewind("undo", false, selected.anchorId, selected.prompt, selected.promptImages)
        } else if (action === 2) await forkFrom(selected)
        else {
          editor.replaceAll(quoteWithComment(selected.text, editor.text))
          ctx.drafts.changed(state.sessionId, { text: editor.text, images: draftRefs(state.attachments, editor.text) })
          state.page = "chat"
          say("quote ready · add a comment", "success", { quiet: true })
        }
      }
    } else if (key === "\x1b[5~" && s.report?.older) await loadMessages({ before: s.report.older })
    else if (key === "\x1b[6~" && s.report?.newer) await loadMessages({ after: s.report.newer })
    else if (["\x1b[A", "k"].includes(key)) { s.selected = Math.max(0, s.selected - 1); s.scroll = 0 }
    else if (["\x1b[B", "j"].includes(key)) { s.selected = Math.min(Math.max(0, s.entries.length - 1), s.selected + 1); s.scroll = 0 }
    else if (key === "\r" && selected) {
      if (s.pick) {
        if (selected.truncated) s.error = "Response is truncated; copy unavailable"
        else if (copy(selected.text, "Copied response")) state.page = "chat"
      } else { s.menu = true; s.action = 0 }
    }
    requestFrame()
  }

  const displayOptions = () => ({ reasoning: state.tuiProfile.reasoning !== "hidden", toolDetails: state.tuiProfile.toolOutput !== "collapsed", assistantMetadata: state.tuiProfile.messageMeta !== "off", timestamps: state.tuiProfile.timestamps })

  async function copyCommand(args: string) {
    if (args === "pick") return openMessageActions(true)
    if (/^[1-9]\d*$/.test(args)) return actions.copyAnswer(Number(args))
    if (args && args !== "transcript") { state.notice = "usage: /copy [pick | n | transcript]"; return }
    const reply = await input.send({ type: "session.export", sessionId: state.sessionId, format: "markdown", ...displayOptions() })
    if (!reply.ok) return fail(reply.error.message)
    const result = reply.result as SessionExportResult
    // A session longer than the export bound or than one clipboard sequence still copies something useful: its last answer.
    const sequence = result.truncated ? undefined : osc52Copy(result.text, { tmux: Boolean(env.TMUX) })
    if (!sequence) return actions.copyAnswer(1, "transcript too long for the clipboard · /export saves it")
    input.screen.write?.(sequence)
    say("Copied session transcript", "success")
  }

  async function launchEditor(text: string, format: ExportRequest["format"]) {
    try {
      const launch = await (input.editorLauncher ?? loadEditorLauncher)()
      const result = await launch({ text, fileName: `transcript.${EXTENSIONS[format]}`, env: { VISUAL: env.VISUAL, EDITOR: env.EDITOR }, ...(input.terminal ? { suspend: input.terminal.suspend, resume: input.terminal.resume } : {}) })
      requestFrame()
      return result
    } catch { return { ok: false as const, reason: "spawn-failed" as const, message: "The external editor is not available in this install" } }
  }

  async function performExport(parsed: ExportRequest): Promise<string | undefined> {
    if (input.remote && !parsed.copy) return "remote export needs --copy"
    const reply = await input.send({ type: "session.export", sessionId: state.sessionId, format: parsed.format, ...Object.fromEntries(["reasoning", "toolDetails", "assistantMetadata", "timestamps", "sanitize"].filter((key) => parsed[key as keyof ExportRequest] !== undefined).map((key) => [key, parsed[key as keyof ExportRequest]])) })
    if (!reply.ok) return reply.error.message
    const result = reply.result as SessionExportResult
    const cut = result.truncated ? " (cut to fit)" : ""
    if (parsed.copy) {
      if (!copy(result.text, `copied the ${result.format} export${cut}`)) return "Export is too long to copy · save to a file"
      return
    }
    let text = result.text
    if (parsed.editor) {
      const edited = await launchEditor(text, parsed.format)
      if (!edited.ok) return edited.message
      text = edited.text
      if (parsed.noSave) { say(`Opened transcript in editor${cut}`, "success"); return }
    }
    const written = writeExport({ cwd: input.directory ?? process.cwd(), text, target: parsed.path ?? defaultExportName(actions.sessionTitle(), parsed.format), explicit: parsed.path !== undefined, force: parsed.force })
    if (!written.ok) return written.error
    say(`exported ${result.turns} turn${result.turns === 1 ? "" : "s"} to ${written.path}${cut}`, "success")
  }

  async function exportSession(args: string) {
    if (args.trim()) {
      const parsed = parseExportArgs(args)
      if ("error" in parsed) { state.notice = parsed.error; return }
      const error = await performExport(parsed)
      if (error) fail(error)
      return
    }
    await actions.loadPage()
    const s: ExportOptionsState = { filename: defaultExportName(actions.sessionTitle(), "markdown"), format: "markdown", ...displayOptions(), destination: input.remote ? "clipboard" : "file", openEditor: !input.remote && !!(env.VISUAL?.trim() || env.EDITOR?.trim()), selected: 0, error: "", busy: false }
    state.exportOptions = s
    filename.replaceAll(s.filename)
    state.page = "export"
    state.notice = ""
    ctx.toasts.dismiss()
    requestFrame()
  }

  async function exportKey(key: string) {
    const s = state.exportOptions!
    if (s.busy) return
    if (key === "\x1b") { state.page = "chat"; return requestFrame() }
    if (key === "\r") {
      if (s.destination === "file" && !s.filename.trim()) { s.error = "Filename is empty"; return requestFrame() }
      s.busy = true
      s.error = ""
      requestFrame()
      try {
        s.error = await performExport({ format: s.format, copy: s.destination === "clipboard", force: false, reasoning: s.reasoning, toolDetails: s.toolDetails, assistantMetadata: s.assistantMetadata, timestamps: s.timestamps, sanitize: s.sanitize ?? false, ...(s.destination === "file" ? { path: s.filename.trim(), editor: s.openEditor } : s.destination === "editor" ? { editor: true, noSave: true } : {}) }) ?? ""
        if (!s.error) state.page = "chat"
      } finally { s.busy = false; requestFrame() }
      return
    }
    if (key === "\t" || key === "\x1b[B") s.selected = (s.selected + 1) % EXPORT_FIELDS.length
    else if (key === "\x1b[Z" || key === "\x1b[A") s.selected = (s.selected + EXPORT_FIELDS.length - 1) % EXPORT_FIELDS.length
    else {
      const field = EXPORT_FIELDS[s.selected]!
      if (field === "filename") { filename.key(key); s.filename = filename.text.replace(/[\r\n]/g, "").slice(0, 4096) }
      else if ([" ", "\x1b[C", "\x1b[D"].includes(key)) {
        if (field === "format") { s.format = FORMAT_CYCLE[(FORMAT_CYCLE.indexOf(s.format) + (key === "\x1b[D" ? FORMAT_CYCLE.length - 1 : 1)) % FORMAT_CYCLE.length]!; s.filename = s.filename.replace(/\.(md|json|html)$/, `.${EXTENSIONS[s.format]}`); filename.replaceAll(s.filename); if (s.format === "html") s.toolDetails = true }
        else if (field === "destination") { const choices: ExportOptionsState["destination"][] = input.remote ? ["clipboard"] : ["file", "editor", "clipboard"]; s.destination = choices[(choices.indexOf(s.destination) + (key === "\x1b[D" ? choices.length - 1 : 1)) % choices.length]! }
        else s[field] = !s[field]
      }
    }
    requestFrame()
  }

  async function transcriptActionsKey(key: string) {
    if (state.page === "messages") await messagesKey(key)
    else await exportKey(key)
  }
  return { openMessageActions, copyCommand, exportSession, transcriptActionsKey }
}

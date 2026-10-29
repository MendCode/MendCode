import type { AsideThread } from "@mendcode/protocol"
import { createEditor, graphemes } from "../../view/editor"
import { textWidth } from "../../view/wrap"
import { modelWithEffort, sessionModelId } from "../../view/model-label"
import { boxPanel, fit } from "../../view/deck"
import { renderMarkdown } from "../../view/markdown"
import type { Line } from "../theme"
import { keyText } from "../key-labels"
import type { AppContext } from "./context"

export type SideChatState = {
  thread: AsideThread
  open: boolean
  focused: boolean
  draft: string
  editor: ReturnType<typeof createEditor>
  scroll: number
  loaded: boolean
  serial: number
}

export function sideChat(ctx: AppContext): SideChatState {
  let chat = ctx.state.sideChats.get(ctx.state.sessionId)
  if (!chat) {
    const editor = createEditor()
    chat = {
      thread: { messages: [], busy: false }, open: false, focused: false, editor,
      get draft() { return editor.text },
      set draft(value: string) { editor.replaceAll(value) },
      scroll: 0, loaded: false, serial: 0,
    }
    ctx.state.sideChats.set(ctx.state.sessionId, chat)
  }
  return chat
}

export function sideInput(chat: SideChatState, width: number) {
  const chars = graphemes(chat.draft)
  const col = chat.editor.cursor.col
  let start = 0
  const room = Math.max(1, width - 6)
  while (start < col && textWidth(chars.slice(start, col).join("")) >= room) start++
  return { text: chars.slice(start).join(""), cursor: textWidth(chars.slice(start, col).join("")) }
}

/** The side chat as a box: its name and keys on the first row, the exchange in the chat's own leads, the prompt on the last row. */
export function sideChatRows(chat: SideChatState, width: number, height: number, title = "btw"): Line[] {
  const inner = Math.max(1, width - 4)
  const lines: Line[] = []
  for (const [index, message] of chat.thread.messages.entries()) {
    if (!message.text.trim()) continue
    // A tool the answer ran: one muted row, under the question it serves.
    if (message.role === "tool") {
      lines.push(fit([{ text: "  ⎿ ", fg: "border" }, { text: message.text.replace(/\s+/g, " "), fg: "muted" }], inner))
      continue
    }
    if (lines.length && chat.thread.messages[index - 1]?.role === "tool") lines.push([])
    const user = message.role === "user"
    const text = renderMarkdown(message.text, Math.max(1, inner - 2))
    text.forEach((line, index) => lines.push([{ text: index > 0 ? "  " : user ? "› " : "• ", fg: user ? "primary" : "muted" }, ...(user ? line.map((span) => ({ ...span, fg: "muted" as const })) : line)]))
    lines.push([])
  }
  if (chat.thread.busy) lines.push([{ text: `• ${chat.thread.status ?? "thinking…"}`, fg: chat.thread.status?.startsWith("Retrying") ? "warning" : "muted" }])
  if (chat.thread.error) lines.push(...renderMarkdown(chat.thread.error, inner).map((line) => line.map((span) => ({ ...span, fg: "error" as const }))))
  if (!lines.length) lines.push(...renderMarkdown("Ask something about this session without interrupting it.", inner).map((line) => line.map((span) => ({ ...span, fg: "muted" as const }))))
  // A short sheet shows the end of the last answer, not the blank row after it.
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop()
  const room = Math.max(1, height - 6)
  chat.scroll = Math.min(chat.scroll, Math.max(0, lines.length - room))
  const end = Math.max(room, lines.length - chat.scroll)
  // The keys that apply now, the longest set that fits beside the name.
  // The model answering follows the name when the keys leave room for it.
  const model = chat.thread.model ? ` · ${chat.thread.model}` : ""
  const keys = (chat.focused ? ["esc chat · ctrl+] close · /btw clear", "esc chat · ctrl+] close", "ctrl+] close"] : ["ctrl+] type · alt+] close", "ctrl+] type"]).map(keyText).find((hint) => textWidth(title) + 2 + textWidth(hint) <= inner) ?? ""
  const named = textWidth(title) + textWidth(model) + 2 + textWidth(keys) <= inner ? model : ""
  const body: Line[] = [
    [{ text: title, fg: "primary", bold: true }, ...(named ? [{ text: named, fg: "muted" as const }] : []), { text: " ".repeat(Math.max(1, inner - textWidth(title) - textWidth(named) - textWidth(keys))) }, { text: keys, fg: "muted" }],
    [], ...lines.slice(Math.max(0, end - room), end),
  ]
  while (body.length < height - 4) body.push([])
  body.push([{ text: "─".repeat(inner), fg: "border" }], fit([{ text: "› ", fg: chat.focused ? "primary" : "muted" }, { text: sideInput(chat, width).text || (chat.focused ? "Ask…" : keyText("ctrl+] to type")), fg: chat.focused && chat.draft ? "text" : "muted" }], inner))
  return boxPanel({ body, width, height, compact: true, active: chat.focused })
}

export function createAside(ctx: AppContext) {
  const { input, state, requestFrame, now } = ctx

  async function loadAside(chat = sideChat(ctx)) {
    const sessionId = state.sessionId
    const serial = chat.serial
    const reply = await input.send({ type: "session.aside.get", sessionId })
    if (serial !== chat.serial) return
    if (reply.ok && reply.result?.thread) chat.thread = reply.result.thread as AsideThread
    else if (!reply.ok) chat.thread = { ...chat.thread, error: reply.error.message }
    chat.loaded = true
    requestFrame()
  }

  async function askAside(args: string) {
    const chat = sideChat(ctx)
    const question = args.trim()
    if (!question) {
      // `/btw` alone opens it ready to type, or closes it.
      chat.open = !chat.open
      chat.focused = chat.open
      if (chat.open) { state.sidebarFocus = false; state.rightFocus = false }
      if (chat.open) await loadAside(chat)
      return requestFrame()
    }
    chat.open = true
    if (question === "clear") {
      chat.serial++
      const reply = await input.send({ type: "session.aside.clear", sessionId: state.sessionId })
      chat.thread = reply.ok ? { messages: [], busy: false } : { ...chat.thread, error: reply.error.message }
      chat.draft = ""
      chat.scroll = 0
      return requestFrame()
    }
    if (chat.thread.busy) return
    const serial = ++chat.serial
    if (!chat.loaded) await loadAside(chat)
    if (serial !== chat.serial || chat.thread.busy) return
    const sessionId = state.sessionId
    chat.thread = { ...chat.thread, messages: [...chat.thread.messages.slice(-63), { role: "user", text: question.slice(0, 4_000) }], busy: true }
    chat.scroll = 0
    requestFrame()
    const reply = await input.send({ type: "session.aside", sessionId, text: question.slice(0, 4_000) })
    // A clear wins over a late completion. Closing or switching sessions retains the live thread.
    if (serial !== chat.serial || !chat.thread.busy) return
    // The daemon sends the whole thread (tools, model); one that sends only the answer's text still fills the panel.
    if (reply.ok) chat.thread = (reply.result?.thread as AsideThread | undefined) ?? { ...chat.thread, messages: [...chat.thread.messages, { role: "assistant", text: String(reply.result?.text ?? "") }], busy: false }
    else chat.thread = { ...chat.thread, busy: false, error: reply.error.message }
    requestFrame()
  }

  function scrollAside(direction: -1 | 1) {
    const chat = sideChat(ctx)
    chat.scroll = Math.max(0, Math.min(10_000, chat.scroll - direction * 6))
    requestFrame()
  }

  function asideKey(key: string): boolean {
    if (state.page !== "chat" || state.palette) return false
    const chat = sideChat(ctx)
    if (key === "\x1d") {
      // One key for the whole life of the side chat: it opens it ready to type, takes the keyboard back to it, and closes it from inside.
      chat.open = !(chat.open && chat.focused)
      chat.focused = chat.open
      state.sidebarFocus = false
      state.rightFocus = false
      if (chat.open && !chat.loaded) void loadAside(chat)
    } else if (chat.open && key === "\x1b]") {
      chat.open = false
      chat.focused = false
    }
    // Esc inside gives the keyboard back to the prompt; outside it is the prompt's own Esc.
    else if (!chat.open || !chat.focused) return false
    else if (key === "\x1b") chat.focused = false
    else if (key === "\r") {
      const draft = chat.draft.trim()
      if (draft && !chat.thread.busy) {
        chat.draft = ""
        void askAside(draft)
      }
    } else if (key === "\x1b[5~" || key === "\x1b[6~") scrollAside(key === "\x1b[5~" ? -1 : 1)
    else {
      chat.editor.key(key === "\n" || key === "\x1b\r" ? " " : key)
      if (chat.draft.length > 4_000) chat.draft = chat.draft.slice(0, 4_000)
    }
    requestFrame()
    return true
  }

  /** `/fetch`: project and app facts from disk and from state the app already holds; nothing is sent to the daemon. */
  async function openFetch() {
    const { projectFacts } = await import("../../view/fetch-info")
    const cwd = input.directory ?? process.cwd()
    const disk = projectFacts({ cwd, now })
    const known = state.sessions.length > 0 ? state.sessions : state.paletteSessions
    const model = sessionModelId(state.effectiveModel?.model, state.transcript.lastUsage?.model, state.modelReport)
    const petRef = state.settingsNow.pet && state.settingsNow.pet !== "off" ? state.settingsNow.pet : undefined
    state.fetchFacts = {
      project: disk.project,
      branch: disk.branch,
      languages: disk.languages,
      ...(known.length > 0 ? { sessions: known.length } : {}),
      ...(model ? { model: modelWithEffort(model, state.effectiveModel?.effort, state.modelReport) } : {}),
      ...(state.todayUsage ? { usageToday: state.todayUsage } : {}),
      ...(petRef ? { pet: state.petList?.find((choice) => choice.ref === petRef)?.name ?? petRef.slice(petRef.indexOf(":") + 1) } : {}),
      ...(input.version ? { version: input.version } : {}),
      terminal: `${input.screen.size.width}x${input.screen.size.height}`,
    }
    requestFrame()
  }

  return { askAside, openFetch, scrollAside, asideKey, loadAside }
}

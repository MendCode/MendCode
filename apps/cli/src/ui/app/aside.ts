import type { AsideArchive, AsideThread } from "@mendcode/protocol"
import { createEditor, graphemes } from "../../view/editor"
import { textWidth } from "../../view/wrap"
import { modelWithEffort, sessionModelId } from "../../view/model-label"
import { boxPanel, fit } from "../../view/deck"
import { renderMarkdown } from "../../view/markdown"
import { compact } from "../../view/format"
import { parseToolTitle, toolLabel } from "../../view/tool-card"
import { asciiGlyphs, glyphOf, headerRow, marksOf, toneOf } from "../../view/tool-frame"
import { formatDuration } from "../../view/time"
import { timeAgo } from "../../view/session-list"
import type { Line } from "../theme"
import { keyText } from "../key-labels"
import type { AppContext } from "./context"

/** What the panel shows: the live chat, the list of earlier ones, or one of them (read-only). */
export type SideChatView = "chat" | "list" | "entry"

export type SideChatState = {
  thread: AsideThread
  view: SideChatView
  /** The side chats cleared before (`/btw history`), newest first, and the one selected. */
  history: AsideArchive[]
  pick: number
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
      thread: { messages: [], busy: false }, view: "chat", history: [], pick: 0, open: false, focused: false, editor,
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

/** A tool the answer ran, drawn like the transcript's own tool row: the kind's glyph (a cross when it failed), its name, its target, how long it took. */
export function sideToolRow(message: AsideThread["messages"][number], width: number, ascii = asciiGlyphs()): Line {
  const { name, detail } = parseToolTitle(message.text)
  const tone = toneOf(message.status === "running" ? "running" : message.status === "error" ? "failed" : "ok")
  const glyph = message.status === "error" ? marksOf(ascii).failed : glyphOf({ name, ascii })
  return headerRow({
    glyph: { text: glyph, fg: tone.glyph, ...(tone.dim && message.status !== "running" ? { dim: true } : {}) },
    label: toolLabel(name), ...(detail ? { target: detail.replace(/\s+/g, " ") } : {}), targetTone: "muted", plain: true, middle: true,
    ...(message.ms !== undefined && message.ms >= 1000 ? { right: formatDuration(message.ms) } : {}), width,
  })
}

/** The exchange of one thread in the chat's own leads: `›` for the question, `•` for the answer, a tool row under the question it serves. */
function threadLines(thread: Pick<AsideThread, "messages">, inner: number): Line[] {
  const lines: Line[] = []
  for (const [index, message] of thread.messages.entries()) {
    if (!message.text.trim()) continue
    if (message.role === "tool") {
      lines.push(sideToolRow(message, inner))
      continue
    }
    if (lines.length && thread.messages[index - 1]?.role === "tool") lines.push([])
    const user = message.role === "user"
    const text = renderMarkdown(message.text, Math.max(1, inner - 2))
    text.forEach((line, index) => lines.push([{ text: index > 0 ? "  " : user ? "› " : "• ", fg: user ? "primary" : "muted" }, ...(user ? line.map((span) => ({ ...span, fg: "muted" as const })) : line)]))
    lines.push([])
  }
  return lines
}

/** What the side chat has to go on, in one muted row: how much of the main session it was shown, and the side model's prompt in tokens with its cached share. */
export function sideContextText(thread: AsideThread, room = Infinity): string {
  const context = thread.context
  if (!context) return "sees the session as of your question"
  const seen = context.cut ? `saw the last ${compact(context.seen)} chars` : `saw ${compact(context.seen)} chars`
  const prompt = context.tokens ? ` · ${compact(context.tokens)} tok` : ""
  const cached = context.tokens && context.cached ? ` · ${Math.round(context.cached / context.tokens * 100)}% cached` : ""
  // A narrow bar drops the cached share, then the prompt, before it cuts what the chat sees.
  return [seen + prompt + cached, seen + prompt, seen].find((text) => textWidth(text) <= room) ?? seen
}

/** The earlier side chats, one row each: when, the model, and the first question. */
function historyLines(chat: SideChatState, inner: number, now: number): Line[] {
  if (!chat.history.length) return renderMarkdown("No earlier side chats. `/btw clear` keeps the current one here.", inner).map((line) => line.map((span) => ({ ...span, fg: "muted" as const })))
  return chat.history.map((entry, index) => {
    const question = entry.messages.find((message) => message.role === "user")?.text.replace(/\s+/g, " ") ?? ""
    const picked = index === chat.pick
    return fit([{ text: picked ? "› " : "  ", fg: "primary" }, { text: `${timeAgo(now, entry.at)}${entry.model ? ` · ${entry.model}` : ""}  `, fg: "muted" }, { text: question, fg: picked ? "text" : "muted", bold: picked }], inner)
  })
}

/** The side chat as a box: its name and keys on the first row, what it sees on the second, the exchange in the chat's own leads, the prompt on the last row. */
export function sideChatRows(chat: SideChatState, width: number, height: number, title = "btw", now = Date.now()): Line[] {
  const inner = Math.max(1, width - 4)
  const earlier = chat.view === "entry" ? chat.history[chat.pick] : undefined
  const lines: Line[] = chat.view === "list" ? historyLines(chat, inner, now) : threadLines(earlier ?? chat.thread, inner)
  if (chat.view === "chat") {
    if (chat.thread.busy) lines.push([{ text: `• ${chat.thread.status ?? "thinking…"}`, fg: chat.thread.status?.startsWith("Retrying") ? "warning" : "muted" }])
    if (chat.thread.error) lines.push(...renderMarkdown(chat.thread.error, inner).map((line) => line.map((span) => ({ ...span, fg: "error" as const }))))
    if (!lines.length) lines.push(...renderMarkdown("Ask something about this session without interrupting it.", inner).map((line) => line.map((span) => ({ ...span, fg: "muted" as const }))))
  }
  // A short sheet shows the end of the last answer, not the blank row after it.
  while (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop()
  const room = Math.max(1, height - 6)
  chat.scroll = Math.min(chat.scroll, Math.max(0, lines.length - room))
  const end = Math.max(room, lines.length - chat.scroll)
  // The keys that apply now, the longest set that fits beside the name.
  // The model answering follows the name when the keys leave room for it.
  const shown = earlier ?? chat.thread
  const model = shown.model ? ` · ${shown.model}` : ""
  const heading = chat.view === "chat" ? title : `${title} · ${chat.view === "list" ? "history" : `earlier ${timeAgo(now, earlier?.at ?? now)}`}`
  const hints = (chat.view !== "chat" ? [chat.view === "list" ? "↑↓ pick · enter open · esc back" : "pgup/pgdn · esc back", "esc back"] : chat.focused ? ["esc chat · ctrl+] close · /btw clear", "esc chat · ctrl+] close", "ctrl+] close"] : ["ctrl+] type · alt+] close", "ctrl+] type"]).map(keyText)
  // The name keeps the model beside it: the keys shrink first, and the model moves to the next row only when even the shortest keys leave no room.
  const keys = hints.find((hint) => textWidth(heading) + textWidth(model) + 2 + textWidth(hint) <= inner) ?? hints.find((hint) => textWidth(heading) + 2 + textWidth(hint) <= inner) ?? ""
  const named = textWidth(heading) + textWidth(model) + 2 + textWidth(keys) <= inner ? model : ""
  // The second row says what the answers rest on; the model goes there when the first row had no room for it.
  const rest = chat.view === "list" ? "" : earlier ? "" : sideContextText(chat.thread, inner - (!named && model ? textWidth(model) : 0))
  // (the model's own " · " lead is part of \`model\`, so its width already counts the separator)
  const body: Line[] = [
    [{ text: heading, fg: "primary", bold: true }, ...(named ? [{ text: named, fg: "muted" as const }] : []), { text: " ".repeat(Math.max(1, inner - textWidth(heading) - textWidth(named) - textWidth(keys))) }, { text: keys, fg: "muted" }],
    fit([{ text: [!named && model ? model.slice(3) : "", rest].filter(Boolean).join(" · "), fg: "muted" }], inner), ...lines.slice(Math.max(0, end - room), end),
  ]
  while (body.length < height - 4) body.push([])
  body.push([{ text: "─".repeat(inner), fg: "border" }], chat.view !== "chat"
    ? fit([{ text: "› ", fg: "muted" }, { text: "esc to go back to the side chat", fg: "muted" }], inner)
    : fit([{ text: "› ", fg: chat.focused ? "primary" : "muted" }, { text: sideInput(chat, width).text || (chat.focused ? "Ask…" : keyText("ctrl+] to type")), fg: chat.focused && chat.draft ? "text" : "muted" }], inner))
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
      chat.view = "chat"
      chat.history = []
      chat.draft = ""
      chat.scroll = 0
      return requestFrame()
    }
    if (question === "history") {
      // The side chats cleared before, newest first; the daemon keeps a few per session.
      const reply = await input.send({ type: "session.aside.get", sessionId: state.sessionId, history: true })
      chat.history = reply.ok ? (reply.result?.history as AsideArchive[] | undefined) ?? [] : []
      if (!reply.ok) chat.thread = { ...chat.thread, error: reply.error.message }
      chat.view = "list"
      chat.pick = 0
      chat.scroll = 0
      chat.focused = true
      state.sidebarFocus = false
      state.rightFocus = false
      return requestFrame()
    }
    chat.view = "chat"
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
    // The earlier side chats: pick one, read it, and Esc steps back to the list, then to the live chat.
    else if (chat.view !== "chat") {
      if (key === "\x1b") { chat.view = chat.view === "entry" ? "list" : "chat"; chat.scroll = 0 }
      else if (chat.view === "list" && (key === "\x1b[A" || key === "\x1b[B")) chat.pick = Math.max(0, Math.min(chat.history.length - 1, chat.pick + (key === "\x1b[A" ? -1 : 1)))
      else if (chat.view === "list" && key === "\r" && chat.history[chat.pick]) { chat.view = "entry"; chat.scroll = 0 }
      else if (key === "\x1b[5~" || key === "\x1b[6~") scrollAside(key === "\x1b[5~" ? -1 : 1)
    }
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
      ...(input.version ? { version: input.dev ? `${input.version} DEV` : input.version } : {}),
      terminal: `${input.screen.size.width}x${input.screen.size.height}`,
    }
    requestFrame()
  }

  return { askAside, openFetch, scrollAside, asideKey, loadAside }
}

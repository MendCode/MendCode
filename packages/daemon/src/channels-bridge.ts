import type { CommandInput, CommandReply } from "@mendcode/client"
import { startedQueueIds, type HistoryReport, type QueueId, type SessionEvent, type SessionId, type SessionSummary } from "@mendcode/protocol"
import { readChannelFile } from "./channels-files"
import { SETTINGS_PROPOSAL_LOCAL } from "./settings-tool"
import { MAX_CHANNEL_CHATS, type ChannelsConfig, type createPairing } from "./channels-config"
import type { TelegramApi, TelegramUpdate, TelegramVoice } from "./channels-telegram"
import type { Transcription } from "./voice"

/** What the bridge needs from the daemon: an ordinary full-authority client of the local socket. */
export type BridgeHost = {
  send(command: CommandInput): Promise<CommandReply>
  /** Streams the session's live events (from now on) into `onEvent`. */
  watch(sessionId: SessionId): Promise<CommandReply>
  unwatch(sessionId: SessionId): void
  mask(sessionId: string, text: string): string
}

type Api = Pick<TelegramApi, "sendMessage" | "answerCallback" | "sendTyping" | "sendDocument"> & Partial<Pick<TelegramApi, "downloadFile" | "editMessage">>
const VOICE_LIMIT_BYTES = 20 * 1024 * 1024
const VOICE_LIMIT_SECONDS = 300
type Pending = { sessionId: SessionId; requestId: string; kind: "approval" | "question"; options: string[] }
/** The one live progress message of a turn: sent at its first tool, edited at most every EDIT_MS, closed with the outcome. */
type Progress = { messageId?: number | undefined; sending?: Promise<void>; timer?: ReturnType<typeof setTimeout> | undefined; tools: number; now?: string; startedAt: number; editedAt: number; shown?: string; done?: boolean }
/** `mirrored`: a turn this chat did not start (typed in the terminal or another client); its prompt is shown too. */
type Turn = { buffered: SessionEvent[]; queueId?: string; turnId?: string; answers: Map<string, string>; items: Set<string>; users: Set<string>; mirrored: boolean; progress: Progress }
/** `seen`: the newest event seq of the session this chat read; `picks`: the sessions a /sessions list offered, by button. */
type Runtime = { sessionId?: SessionId; seen?: number | undefined; /** A watch being started: its session's events wait here until it answers. */ joining?: { sessionId: SessionId; events: SessionEvent[] } | undefined; turn?: Turn | undefined; mirror?: Turn | undefined; pending: Map<number, Pending>; picks: Set<SessionId> }

const HELP = [
  "MendCode remote control",
  "Send a message to run a turn in the session; turns started on the computer show here too.",
  "/sessions  switch to another session of the project",
  "/history [n]  the last turns of this session",
  "/stop  cancel the running turn",
  "/new  start a fresh session",
  "/status  session and turn state",
  "/file PATH  receive a project file",
  "/unpair  disconnect this chat",
].join("\n")
const DETAIL_LIMIT = 1500
const EDIT_MS = 3000
const RECAP_TURNS = 5
const MAX_RECAP_TURNS = 20
const SESSION_PICKS = 8
/** Sessions an older /sessions list may still pick; the oldest offered go first. */
const MAX_PICKS = 32

export function createChannelBridge({ api, host, config, pairing, dataDir, log, transcribe, now = Date.now }: { api: Api; host: BridgeHost; config: ChannelsConfig; pairing: ReturnType<typeof createPairing>; dataDir: string; log(level: "info" | "warn", message: string): void; transcribe?: (input: { bytes: Uint8Array; name: string; mime: string }) => Promise<Transcription>; now?: () => number }) {
  const runtimes = new Map<string, Runtime>()
  const runtime = (id: string) => { let found = runtimes.get(id); if (!found) runtimes.set(id, found = { pending: new Map(), picks: new Set() }); return found }
  const chats = () => config.read().telegram.chats
  const chatOf = (id: string) => chats().find((chat) => chat.id === id)
  let counter = 0

  const say = (id: string, text: string, buttons?: Parameters<Api["sendMessage"]>[2]) => api.sendMessage(id, text, buttons).catch((error: unknown) => { log("warn", error instanceof Error ? error.message : "[CHANNELS]: send failed"); return undefined })
  const clip = (text: string, limit = DETAIL_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}…` : text)
  const newTurn = (mirrored: boolean): Turn => ({ buffered: [], answers: new Map(), items: new Set(), users: new Set(), mirrored, progress: { tools: 0, startedAt: now(), editedAt: 0 } })

  function saveSession(id: string, sessionId: SessionId | undefined) {
    config.update((value) => { const chat = value.telegram.chats.find((entry) => entry.id === id); if (chat) { if (sessionId) chat.sessionId = sessionId; else delete chat.sessionId } })
  }

  async function ensureSession(id: string): Promise<SessionId | undefined> {
    const stored = chatOf(id)
    if (!stored) return undefined
    const state = runtime(id)
    if (state.sessionId) return state.sessionId
    if (stored.sessionId) {
      const joined = await join(state, stored.sessionId as SessionId)
      if (joined.ok) { enter(id, state, stored.sessionId as SessionId, joined.events); return state.sessionId }
    }
    const created = await host.send({ type: "session.create", directory: stored.directory, title: "Telegram" })
    const sessionId = created.ok ? created.result?.sessionId as SessionId | undefined : undefined
    if (!sessionId) { await say(id, `Could not start a session: ${created.ok ? "no session id" : clip(created.error.message, 200)}`); return undefined }
    const joined = await join(state, sessionId)
    if (!joined.ok) { await say(id, `Could not follow the session: ${clip(joined.error.message, 200)}`); return undefined }
    enter(id, state, sessionId, joined.events)
    saveSession(id, sessionId)
    return sessionId
  }

  /**
   * Starts the watch of `sessionId` for a chat without moving it yet. A turn already running replays from its start, and while the watch
   * starts every event of that session is held (live ones too, when another chat already follows it), so nothing is skipped or lost.
   */
  async function join(state: Runtime, sessionId: SessionId): Promise<({ ok: true; events: SessionEvent[] }) | { ok: false; error: { message: string } }> {
    const joining = { sessionId, events: [] as SessionEvent[] }
    state.joining = joining
    const watched = await host.watch(sessionId).finally(() => { if (state.joining === joining) state.joining = undefined })
    return watched.ok ? { ok: true, events: joining.events } : { ok: false, error: watched.error }
  }

  /** The chat moves to `sessionId` it now watches: what was held while joining is read in order, each event once. */
  function enter(id: string, state: Runtime, sessionId: SessionId, held: SessionEvent[]) {
    const previous = state.sessionId
    closeTurn(state.mirror)
    state.mirror = undefined
    state.pending.clear()
    state.sessionId = sessionId
    state.seen = undefined
    if (previous !== sessionId) release(id, previous)
    for (const event of [...held].sort((a, b) => a.seq - b.seq)) deliver(id, state, event)
  }

  /** Stops following `sessionId` for chat `id`: the shared client unsubscribes only when no other chat follows it. */
  function release(id: string, sessionId: SessionId | undefined) {
    if (!sessionId) return
    for (const [other, state] of runtimes) if (other !== id && state.sessionId === sessionId) return
    host.unwatch(sessionId)
  }

  /** The chat leaves its session: the mirrored turn stops and approvals and questions of that session can no longer be answered here. */
  function leave(id: string, state: Runtime) {
    closeTurn(state.mirror)
    state.mirror = undefined
    state.pending.clear()
    release(id, state.sessionId)
    delete state.sessionId
    state.seen = undefined
  }

  /**
   * Follows `sessionId` (the terminal's session at pairing, or one picked with /sessions) and shows its last turns; a turn already
   * running there replays into the chat (its prompt, progress and open approvals). A watch that fails leaves the chat where it was.
   */
  async function link(id: string, sessionId: SessionId, recapTurns: number) {
    const state = runtime(id)
    if (state.turn) { await say(id, "A turn is running. /stop first."); return false }
    if (recapTurns > 0) await recap(id, sessionId, recapTurns)
    if (state.sessionId !== sessionId) {
      const joined = await join(state, sessionId)
      if (!joined.ok) { await say(id, `Could not follow that session: ${clip(joined.error.message, 200)}`); return false }
      if (state.turn) { release(id, sessionId); await say(id, "A turn is running. /stop first."); return false }
      enter(id, state, sessionId, joined.events)
    }
    saveSession(id, sessionId)
    return true
  }

  /** The last turns as one readable message: what was asked and the final answer of each. */
  async function recap(id: string, sessionId: SessionId, turns: number) {
    const reply = await host.send({ type: "session.history", sessionId, limit: turns })
    if (!reply.ok) return say(id, `Could not read the history: ${clip(reply.error.message, 200)}`)
    const history = reply.result as unknown as HistoryReport
    if (!history.turns.length) return say(id, "No turns in this session yet.")
    const blocks = history.turns.map((turn) => {
      const asked = turn.items.find((item) => item.kind === "user_message")?.text ?? turn.preview
      const answer = turn.items.filter((item) => item.kind === "agent_message" && item.text.trim()).at(-1)?.text
      return [`You: ${clip(asked.trim(), 400)}`, answer ? `MendCode: ${clip(answer.trim(), 900)}` : `(${turn.outcome})`].join("\n")
    })
    return say(id, host.mask(sessionId, `${history.older ? "Last" : "All"} ${history.turns.length} turn${history.turns.length === 1 ? "" : "s"}:\n\n${blocks.join("\n\n")}`))
  }

  async function runTurn(id: string, text: string) {
    const state = runtime(id)
    if (state.turn) return say(id, "A turn is running. /stop cancels it.")
    const sessionId = await ensureSession(id)
    if (!sessionId) return
    const turn = newTurn(false)
    state.turn = turn
    void api.sendTyping(id).catch(() => {})
    const reply = await host.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (!reply.ok) { state.turn = undefined; return say(id, `Not sent: ${clip(host.mask(sessionId, reply.error.message), 300)}`) }
    if (reply.result?.handled === true) { state.turn = undefined; return say(id, String(reply.result.notice ?? "Done.")) }
    if (typeof reply.result?.queueId !== "string") { state.turn = undefined; return say(id, "The daemon did not accept the message.") }
    turn.queueId = reply.result.queueId
    for (const event of turn.buffered.splice(0)) ownEvent(id, state, turn, event)
  }

  const elapsed = (progress: Progress) => {
    const seconds = Math.max(0, Math.round((now() - progress.startedAt) / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }
  const tools = (count: number) => `${count} tool${count === 1 ? "" : "s"}`
  const progressText = (progress: Progress) => `Working · ${tools(progress.tools)}${progress.now ? ` · ${progress.now}` : ""} · ${elapsed(progress)}`

  /** Shows the turn's progress: the message is sent once, then edited no more often than EDIT_MS. */
  function touch(id: string, turn: Turn) {
    const progress = turn.progress
    if (!api.editMessage || progress.done) return
    if (progress.messageId === undefined) {
      if (progress.sending) return
      const text = progressText(progress)
      progress.sending = say(id, text).then((messageId) => {
        progress.messageId = messageId
        progress.shown = text
        progress.editedAt = now()
        if (!progress.done && progressText(progress) !== text) touch(id, turn)
      })
      return
    }
    if (progress.timer) return
    progress.timer = setTimeout(() => {
      progress.timer = undefined
      if (progress.done || progress.messageId === undefined) return
      const text = progressText(progress)
      if (text === progress.shown) return
      progress.shown = text
      progress.editedAt = now()
      void api.editMessage!(id, progress.messageId, text).catch(() => {})
    }, Math.max(0, progress.editedAt + EDIT_MS - now()))
  }

  function closeTurn(turn: Turn | undefined) {
    if (!turn) return
    turn.progress.done = true
    if (turn.progress.timer) clearTimeout(turn.progress.timer)
    turn.progress.timer = undefined
  }

  function finish(id: string, state: Runtime, turn: Turn, text: string, outcome: string) {
    if (state.turn === turn) state.turn = undefined
    if (state.mirror === turn) state.mirror = undefined
    for (const [key, pending] of state.pending) if (pending.kind === "approval" || pending.kind === "question") state.pending.delete(key)
    closeTurn(turn)
    const progress = turn.progress
    if (!progress.sending || !api.editMessage) return say(id, text)
    // The progress line closes with the outcome before the answer arrives below it.
    const closing = `${outcome} · ${tools(progress.tools)} · ${elapsed(progress)}`
    return progress.sending
      .then(() => progress.messageId === undefined ? undefined : api.editMessage!(id, progress.messageId, closing).catch(() => {}))
      .then(() => say(id, text))
  }

  /** A turn this chat started: its events count once its `turn.started` names the chat's queued message. */
  function ownEvent(id: string, state: Runtime, turn: Turn, event: SessionEvent) {
    if (!turn.turnId) {
      if (event.type === "turn.started" && turn.queueId && startedQueueIds(event).includes(turn.queueId as QueueId)) turn.turnId = event.turnId
      return
    }
    if (belongs(turn, event)) follow(id, state, turn, event)
  }

  /** Whether `event` is part of `turn`: by its turn id, or by an item the turn started (deltas and completions carry no turn id). */
  function belongs(turn: Turn, event: SessionEvent) {
    if ("turnId" in event && typeof event.turnId === "string") return event.turnId === turn.turnId
    if ("itemId" in event && typeof event.itemId === "string") return turn.items.has(event.itemId)
    return event.type === "server.request.resolved"
  }

  function follow(id: string, state: Runtime, turn: Turn, event: SessionEvent) {
    const sessionId = event.sessionId
    switch (event.type) {
      case "item.started":
        turn.items.add(event.itemId)
        if (event.kind === "agent_message") { turn.answers.set(event.itemId, ""); turn.progress.now = "writing the answer"; touch(id, turn) }
        else if (event.kind === "user_message") turn.users.add(event.itemId)
        else if (event.kind === "reasoning") { turn.progress.now = "thinking"; touch(id, turn) }
        else if (event.kind === "tool_call" && event.meta?.injected !== true && event.meta?.parentItemId === undefined) {
          turn.progress.tools++
          const tool = typeof event.meta?.tool === "string" ? event.meta.tool : "a tool"
          turn.progress.now = clip(host.mask(sessionId, tool).replace(/\s+/g, " "), 80)
          touch(id, turn)
        }
        break
      case "item.delta":
        if (turn.answers.has(event.itemId)) turn.answers.set(event.itemId, turn.answers.get(event.itemId)! + event.text)
        break
      case "item.completed":
        if (turn.answers.has(event.itemId) && !turn.answers.get(event.itemId) && event.text) turn.answers.set(event.itemId, event.text)
        // A prompt typed elsewhere shows before its answer, so the chat reads like the session.
        if (turn.mirrored && turn.users.has(event.itemId) && event.text?.trim()) void say(id, `From the computer:\n${clip(host.mask(sessionId, event.text.trim()))}`)
        break
      case "server.request": {
        if (event.kind === "approval" && (event.planReview || event.questions)) { void say(id, "A plan review needs an answer on the computer."); break }
        if (event.kind === "question" && event.questions) { void say(id, "This question needs an answer on the computer."); break }
        const number = ++counter
        const detail = clip(host.mask(sessionId, `${event.title}\n${event.detail}`.trim()))
        if (event.kind === "approval") {
          state.pending.set(number, { sessionId, requestId: event.requestId, kind: "approval", options: [] })
          void say(id, `Approve${event.tool ? ` ${event.tool}` : ""}?\n${detail}`, [[{ text: "Allow once", data: `ap:${number}:y` }, { text: "Deny", data: `ap:${number}:n` }]])
        } else if (event.title === SETTINGS_PROPOSAL_LOCAL) {
          // A settings change that names a key only the machine running MendCode sets (permission, sandbox…) is answered there, never from a chat.
          void say(id, `${detail}\nAnswer this on the computer that runs MendCode.`)
        } else {
          const options = (event.options ?? []).map((option) => option.label)
          state.pending.set(number, { sessionId, requestId: event.requestId, kind: "question", options })
          void say(id, `${detail}\nReply with your answer.`, options.length ? options.map((label, index) => [{ text: label.slice(0, 60), data: `q:${number}:${index}` }]) : undefined)
        }
        break
      }
      case "server.request.resolved":
        for (const [key, pending] of state.pending) if (pending.requestId === event.requestId) state.pending.delete(key)
        break
      case "turn.completed": {
        const answer = [...turn.answers.values()].filter((value) => value.trim()).at(-1)
        void finish(id, state, turn, answer ? host.mask(sessionId, answer) : "Done (no text answer).", "Done")
        break
      }
      case "turn.failed":
        void finish(id, state, turn, `Failed: ${event.error.code}: ${clip(host.mask(sessionId, event.error.message), 500)}`, "Failed")
        break
      case "turn.cancelled":
      case "turn.interrupted":
        void finish(id, state, turn, "Stopped.", "Stopped")
        break
    }
  }

  function onEvent(event: SessionEvent) {
    for (const [id, state] of runtimes) {
      if (state.joining?.sessionId === event.sessionId) { state.joining.events.push(event); continue }
      if (state.sessionId === event.sessionId) deliver(id, state, event)
    }
  }

  function deliver(id: string, state: Runtime, event: SessionEvent) {
    // Another chat joining the session replays its running turn on the shared client: a chat reads each event once.
    if (state.seen !== undefined && event.seq <= state.seen) return
    state.seen = event.seq
    if (state.mirror && belongs(state.mirror, event)) { follow(id, state, state.mirror, event); return }
    if (state.turn) {
      if (state.turn.queueId === undefined) state.turn.buffered.push(event)
      else ownEvent(id, state, state.turn, event)
      return
    }
    // A turn started from the terminal (or any other client) is followed like one started here.
    if (event.type === "turn.started" && !state.mirror) {
      const turn = state.mirror = newTurn(true)
      turn.turnId = event.turnId
    }
  }

  async function resolve(id: string, number: number, decision: Extract<CommandInput, { type: "request.resolve" }>["decision"], done: string, callback?: string) {
    const state = runtime(id)
    const pending = state.pending.get(number)
    // Only the chat's current session is answered from here.
    if (!pending || pending.sessionId !== state.sessionId) { if (callback) await api.answerCallback(callback, "Expired").catch(() => {}); return false }
    state.pending.delete(number)
    const reply = await host.send({ type: "request.resolve", sessionId: pending.sessionId, requestId: pending.requestId as never, decision })
    const text = reply.ok ? done : "Already answered"
    if (callback) await api.answerCallback(callback, text).catch(() => {})
    else await say(id, text)
    return reply.ok
  }

  /** The project's recent sessions as buttons; pressing one moves the chat there. */
  async function listSessions(id: string) {
    const stored = chatOf(id)
    if (!stored) return
    const reply = await host.send({ type: "session.list", directory: stored.directory, limit: SESSION_PICKS, roots: true, hideEmpty: true })
    if (!reply.ok) return say(id, `Could not list sessions: ${clip(reply.error.message, 200)}`)
    const sessions = ((reply.result as { sessions?: SessionSummary[] } | undefined)?.sessions ?? []).slice(0, SESSION_PICKS)
    if (!sessions.length) return say(id, "No sessions in this project yet; send a message to start one.")
    const state = runtime(id)
    const current = state.sessionId ?? stored.sessionId
    // A button names its session, so an older list still picks what it shows; only sessions a list offered are accepted.
    for (const session of sessions) { state.picks.delete(session.sessionId); state.picks.add(session.sessionId) }
    for (const old of state.picks) { if (state.picks.size <= MAX_PICKS) break; state.picks.delete(old) }
    return say(id, "Pick a session:", sessions.map((session) => [{ text: `${session.sessionId === current ? "• " : ""}${clip(session.title || "Untitled", 50)}${session.state !== "idle" ? " (working)" : ""}`, data: `s:${session.sessionId}` }]))
  }

  async function command(id: string, name: string, args: string) {
    const state = runtime(id)
    switch (name) {
      case "start": case "help": return say(id, HELP)
      case "status": {
        const stored = chatOf(id)
        return say(id, `Project ${stored?.directory ?? "?"}\nSession ${state.sessionId ?? stored?.sessionId ?? "none yet"}\n${state.turn || state.mirror ? "A turn is running" : "Idle"}`)
      }
      case "sessions": return listSessions(id)
      case "history": {
        const sessionId = state.sessionId ?? (chatOf(id)?.sessionId as SessionId | undefined)
        if (!sessionId) return say(id, "No session yet; send a message to start one.")
        const asked = Number.parseInt(args, 10)
        return recap(id, sessionId, Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_RECAP_TURNS) : RECAP_TURNS)
      }
      case "stop": {
        const running = state.turn ?? state.mirror
        if (!running || !state.sessionId) return say(id, "Nothing is running.")
        if (!running.turnId) return say(id, "The turn is still starting; try again.")
        const reply = await host.send({ type: "turn.cancel", sessionId: state.sessionId, turnId: running.turnId as never })
        if (!reply.ok) return say(id, `Could not stop: ${clip(reply.error.message, 200)}`)
        return
      }
      case "new":
        if (state.turn) return say(id, "A turn is running. /stop first.")
        leave(id, state)
        saveSession(id, undefined)
        return say(id, "Fresh session; your next message starts it.")
      case "file": {
        const stored = chatOf(id)
        if (!stored) return
        const file = readChannelFile({ directory: stored.directory, dataDir, input: args })
        if (!file.ok) return say(id, `Not sent: ${file.reason}`)
        return api.sendDocument(id, { name: file.name, bytes: file.bytes }).catch((error: unknown) => say(id, `Not sent: ${error instanceof Error ? clip(error.message, 200) : "upload failed"}`))
      }
      case "unpair":
        config.update((value) => { value.telegram.chats = value.telegram.chats.filter((entry) => entry.id !== id) })
        forget(id)
        return say(id, "Unpaired.")
      default: return say(id, "Unknown command. /help lists them.")
    }
  }

  function forget(id: string) {
    const state = runtimes.get(id)
    release(id, state?.sessionId)
    closeTurn(state?.turn)
    closeTurn(state?.mirror)
    runtimes.delete(id)
  }

  /** A voice message as text (opt-in `voice.enabled`); the transcript is echoed so a mishearing is visible. Undefined when nothing can be run. */
  async function hear(id: string, voice: TelegramVoice): Promise<string | undefined> {
    if (!transcribe || !api.downloadFile) { await say(id, "Voice messages are not available."); return undefined }
    if ((voice.duration ?? 0) > VOICE_LIMIT_SECONDS || (voice.file_size ?? 0) > VOICE_LIMIT_BYTES) { await say(id, "That voice message is too long; keep it under 5 minutes."); return undefined }
    let bytes: Uint8Array
    try { bytes = await api.downloadFile(voice.file_id, VOICE_LIMIT_BYTES) } catch (error) {
      await say(id, `Could not get the voice message: ${error instanceof Error ? clip(error.message, 200) : "download failed"}`)
      return undefined
    }
    const heard = await transcribe({ bytes, name: "voice.ogg", mime: voice.mime_type ?? "audio/ogg" })
    if (!heard.ok) { await say(id, `Could not transcribe: ${clip(heard.message, 200)}`); return undefined }
    if (!heard.text) { await say(id, "Heard nothing in that voice message."); return undefined }
    await say(id, `Heard: ${clip(heard.text, 500)}`)
    return heard.text
  }

  /** `/pair CODE`: pairs a new chat, or moves a paired one to the code's project and session. */
  async function claim(id: string, code: string, label: string | undefined) {
    const known = chatOf(id)
    if (!known && chats().length >= MAX_CHANNEL_CHATS) return say(id, "Too many paired chats.")
    const claimed = pairing.claim(id, code)
    if (!claimed.ok) return say(id, known ? "That code is not valid or has expired. This chat stays paired." : "That code is not valid or has expired.")
    config.update((value) => {
      const chat = value.telegram.chats.find((entry) => entry.id === id)
      if (chat) { chat.directory = claimed.directory; delete chat.sessionId }
      else value.telegram.chats.push({ id, ...(label ? { name: label.slice(0, 100) } : {}), directory: claimed.directory, pairedAt: Date.now() })
    })
    log("info", known ? "telegram chat moved" : "telegram chat paired")
    if (known) forget(id)
    await say(id, `Paired with ${claimed.directory}.\n${HELP}`)
    if (claimed.sessionId) await link(id, claimed.sessionId as SessionId, RECAP_TURNS)
  }

  async function message(chat: NonNullable<TelegramUpdate["message"]>) {
    if (chat.chat.type !== "private") return
    const id = String(chat.chat.id)
    const text = (chat.text ?? "").trim()
    const slash = /^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text)
    const name = slash?.[1]?.toLowerCase(), args = (slash?.[2] ?? "").trim()
    if (!chatOf(id)) {
      if (pairing.blocked(id)) return
      if (name === "pair") return claim(id, args, chat.chat.username ?? chat.chat.first_name)
      if (name === "start") return say(id, "Pair this chat with /pair CODE. Create the code with /remote-control in the MendCode terminal.")
      return
    }
    if (name === "pair") return pairing.blocked(id) ? undefined : claim(id, args, undefined)
    // A transcript is always a plain prompt, never a chat command.
    const spoken = !text && chat.voice ? await hear(id, chat.voice) : undefined
    if (!text && spoken === undefined) return chat.voice ? undefined : say(id, "Only text messages are supported.")
    if (name) return command(id, name, args)
    const prompt = spoken ?? text
    const state = runtime(id)
    const question = [...state.pending].find(([, pending]) => pending.kind === "question" && pending.sessionId === state.sessionId)
    if (question) return resolve(id, question[0], { kind: "answer", text: prompt }, "Sent").then(() => {})
    return runTurn(id, prompt)
  }

  async function callback(query: NonNullable<TelegramUpdate["callback_query"]>) {
    const chat = query.message?.chat
    const id = chat ? String(chat.id) : undefined
    if (!id || chat?.type !== "private" || !chatOf(id)) return
    const picked = /^s:([A-Za-z0-9_]{1,60})$/.exec(query.data ?? "")
    if (picked) {
      const sessionId = picked[1] as SessionId
      if (!runtime(id).picks.has(sessionId)) { await api.answerCallback(query.id, "Expired").catch(() => {}); return }
      const moved = await link(id, sessionId, RECAP_TURNS)
      await api.answerCallback(query.id, moved ? "Switched" : "Not switched").catch(() => {})
      return
    }
    const match = /^(ap|q):(\d+):(y|n|\d)$/.exec(query.data ?? "")
    if (!match) return
    const number = Number(match[2])
    if (match[1] === "ap") await resolve(id, number, match[3] === "y" ? { kind: "approve", scope: "once" } : { kind: "deny", reason: "denied from Telegram" }, match[3] === "y" ? "Allowed" : "Denied", query.id)
    else {
      const option = runtime(id).pending.get(number)?.options[Number(match[3])]
      if (option === undefined) await api.answerCallback(query.id, "Expired").catch(() => {})
      else await resolve(id, number, { kind: "answer", text: option }, "Sent", query.id)
    }
  }

  /** At start, follows again the session each paired chat was on, so its turns show without a message from the phone first. */
  async function resume() {
    for (const chat of chats()) {
      if (!chat.sessionId) continue
      const state = runtime(chat.id)
      const joined = await join(state, chat.sessionId as SessionId)
      if (joined.ok) enter(chat.id, state, chat.sessionId as SessionId, joined.events)
    }
  }

  return {
    async update(update: TelegramUpdate) {
      try {
        if (update.message) await message(update.message)
        else if (update.callback_query) await callback(update.callback_query)
      } catch (error) {
        log("warn", `[CHANNELS]: update failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`)
      }
    },
    onEvent,
    forget,
    resume,
    stop() { for (const id of [...runtimes.keys()]) forget(id) },
  }
}

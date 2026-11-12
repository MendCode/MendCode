import type { CommandInput, CommandReply } from "@mendcode/client"
import { startedQueueIds, type HistoryReport, type QueueId, type SessionEvent, type SessionId, type SessionSummary } from "@mendcode/protocol"
import path from "node:path"
import { readChannelFile } from "./channels-files"
import { SETTINGS_PROPOSAL_LOCAL } from "./settings-tool"
import type { ChannelApi, ChannelButton, ChannelUpdate, ChannelVoice, ChannelWords } from "./channels-api"
import { MAX_CHANNEL_CHATS, MAX_CHAT_TOPICS, type ChannelStore, type createPairing, type StoredChat } from "./channels-config"
import type { Transcription } from "./voice"

/** What the bridge needs from the daemon: an ordinary full-authority client of the local socket. */
export type BridgeHost = {
  send(command: CommandInput): Promise<CommandReply>
  /** Streams the session's live events (from now on) into `onEvent`. */
  watch(sessionId: SessionId): Promise<CommandReply>
  unwatch(sessionId: SessionId): void
  mask(sessionId: string, text: string): string
}

type Api = ChannelApi
/**
 * Where a session is followed: a paired chat (`"<chat id>"`) or one topic of it (`"<chat id>/<thread id>"`: a Telegram topic, a
 * Discord thread). Each place has its own session and project, so a chat with topics follows several sessions at once.
 */
type Place = string
const VOICE_LIMIT_BYTES = 20 * 1024 * 1024
const VOICE_LIMIT_SECONDS = 300
type Pending = { sessionId: SessionId; requestId: string; kind: "approval" | "question"; options: string[] }
/** The one live progress message of a turn: sent at its first tool, edited at most every EDIT_MS, closed with the outcome. */
type Progress = { messageId?: string | undefined; sending?: Promise<void>; timer?: ReturnType<typeof setTimeout> | undefined; tools: number; now?: string; startedAt: number; editedAt: number; shown?: string; done?: boolean }
/** `mirrored`: a turn this chat did not start (typed in the terminal or another client); its prompt is shown too. */
type Turn = { buffered: SessionEvent[]; queueId?: string; turnId?: string; answers: Map<string, string>; items: Set<string>; users: Set<string>; mirrored: boolean; progress: Progress }
/** `seen`: the newest event seq of the session this place read; `picks`: the sessions a /sessions list offered, by button, with their titles. */
type Runtime = { sessionId?: SessionId; seen?: number | undefined; /** A watch being started: its session's events wait here until it answers. */ joining?: { sessionId: SessionId; events: SessionEvent[] } | undefined; turn?: Turn | undefined; mirror?: Turn | undefined; pending: Map<number, Pending>; picks: Map<SessionId, string> }

const HELP = [
  "**MendCode remote control**",
  "Send a message to run a turn in the session; turns started on the computer show here too.",
  "`/sessions` switch to another session of the project",
  "`/history [n]` the last turns of this session",
  "`/stop` cancel the running turn",
  "`/new` start a fresh session",
  "`/status` session and turn state",
  "`/file PATH` receive a project file",
  "`/unpair` disconnect this chat",
].join("\n")
const TOPIC_GONE = /thread not found|topic_deleted|topic_closed|topic was deleted|unknown channel/i
const TELEGRAM_WORDS: ChannelWords = { topic: "topic", topics: "Topics", pairHint: "Pair this chat with /pair CODE. Create the code with /remote-control pair in the MendCode terminal.", topicsHint: "With topics on, every session has its own topic: pair from another project's terminal, `/new` or a `/sessions` pick opens one." }
const DETAIL_LIMIT = 1500
const EDIT_MS = 3000
const RECAP_TURNS = 5
const MAX_RECAP_TURNS = 20
const SESSION_PICKS = 8
/** Sessions an older /sessions list may still pick; the oldest offered go first. */
const MAX_PICKS = 32

export function createChannelBridge({ api, host, store, pairing, dataDir, log, transcribe, now = Date.now, words = TELEGRAM_WORDS, autoThread = false, service = "Telegram" }: {
  api: Api; host: BridgeHost; store: ChannelStore; pairing: ReturnType<typeof createPairing>; dataDir: string; log(level: "info" | "warn", message: string): void
  transcribe?: (input: { bytes: Uint8Array; name: string; mime: string }) => Promise<Transcription>; now?: () => number
  words?: ChannelWords
  /** A prompt sent in the chat itself (not in a topic) starts a new session in a new topic named after it, as Hermes does on Discord. */
  autoThread?: boolean
  /** The service's name, in denials recorded in the session. */
  service?: string
}) {
  const runtimes = new Map<Place, Runtime>()
  const runtime = (id: Place) => { let found = runtimes.get(id); if (!found) runtimes.set(id, found = { pending: new Map(), picks: new Map() }); return found }
  const chats = () => store.chats()
  const chatIdOf = (id: Place) => id.split("/")[0]!
  const threadOf = (id: Place) => id.split("/")[1] || undefined
  const placeOf = (chat: string, thread?: string | number) => (thread === undefined ? chat : `${chat}/${thread}`)
  const chatOf = (id: Place) => chats().find((chat) => chat.id === chatIdOf(id))
  const sameThread = (stored: string | number, thread: string | undefined) => thread !== undefined && String(stored) === thread
  const topicOf = (id: Place) => { const thread = threadOf(id); return thread === undefined ? undefined : chatOf(id)?.topics?.find((topic) => sameThread(topic.thread, thread)) }
  /** A topic the chat made itself (or one from before) runs in the chat's project. */
  const directoryOf = (id: Place) => topicOf(id)?.directory ?? chatOf(id)?.directory
  const storedSession = (id: Place) => (threadOf(id) === undefined ? chatOf(id)?.sessionId : topicOf(id)?.sessionId) as SessionId | undefined
  let counter = 0

  const topicsOn = async () => !!api.createTopic && (api.topicsEnabled ? await api.topicsEnabled().catch(() => false) : true)

  function send(id: Place, text: string, buttons: ChannelButton[][] | undefined, markdown: boolean) {
    const thread = threadOf(id)
    return api.sendMessage(chatIdOf(id), text, buttons, { ...(thread === undefined ? {} : { thread }), ...(markdown ? { markdown } : {}) }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "[CHANNELS]: send failed"
      log("warn", message)
      // The user deleted the topic: its session is no longer followed there.
      if (thread !== undefined && TOPIC_GONE.test(message)) dropTopic(id)
      return undefined
    })
  }
  const say = (id: Place, text: string, buttons?: ChannelButton[][]) => send(id, text, buttons, false)
  /** The model's Markdown (and the bridge's own bold labels), formatted for the service. */
  const md = (id: Place, text: string, buttons?: ChannelButton[][]) => send(id, text, buttons, true)
  const topicLink = (place: Place): ChannelButton[][] | undefined => {
    const url = api.topicLink?.(chatIdOf(place), threadOf(place)!)
    return url ? [[{ text: `Open the ${words.topic}`, url }]] : undefined
  }
  const clip = (text: string, limit = DETAIL_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}…` : text)
  const newTurn = (mirrored: boolean): Turn => ({ buffered: [], answers: new Map(), items: new Set(), users: new Set(), mirrored, progress: { tools: 0, startedAt: now(), editedAt: 0 } })

  /** The session a place follows; a topic not stored yet (made by the user) is stored in the chat's project. */
  function saveSession(id: Place, sessionId: SessionId | undefined) {
    let evicted: Place | undefined
    store.update((list) => {
      const chat = list.find((entry) => entry.id === chatIdOf(id))
      if (!chat) return
      const thread = threadOf(id)
      if (thread === undefined) { if (sessionId) chat.sessionId = sessionId; else delete chat.sessionId; return }
      const topics = chat.topics ??= []
      let topic = topics.find((entry) => sameThread(entry.thread, thread))
      if (!topic) { topic = { thread, directory: chat.directory }; topics.push(topic); evicted = evictOldest(chat.id, topics) }
      if (sessionId) topic.sessionId = sessionId; else delete topic.sessionId
    })
    if (evicted) forgetPlace(evicted)
  }

  /**
   * Past the cap, the oldest topic is no longer followed: its stored session and project go, and so does what runs for it here (its
   * watch, its turn), so a message there later starts fresh in the chat's project for everything, prompt and commands alike.
   */
  function evictOldest(chat: string, topics: NonNullable<StoredChat["topics"]>): Place | undefined {
    if (topics.length <= MAX_CHAT_TOPICS) return undefined
    const oldest = topics.shift()
    return oldest ? placeOf(chat, String(oldest.thread)) : undefined
  }

  /** A new topic of chat `chat` for `directory` (and `sessionId`, when there is one yet); undefined when the service refuses it. */
  async function openTopic(chat: string, name: string, directory: string, sessionId?: SessionId, fromMessage?: string): Promise<Place | undefined> {
    let thread: string
    try { thread = await api.createTopic!(chat, name, fromMessage) } catch (error) {
      log("warn", error instanceof Error ? error.message.slice(0, 200) : "[CHANNELS]: topic not created")
      return undefined
    }
    let evicted: Place | undefined
    store.update((list) => {
      const stored = list.find((entry) => entry.id === chat)
      if (!stored) return
      const topics = stored.topics ??= []
      topics.push({ thread, directory, ...(sessionId ? { sessionId } : {}) })
      evicted = evictOldest(chat, topics)
    })
    if (evicted) forgetPlace(evicted)
    return placeOf(chat, thread)
  }

  function dropTopic(id: Place) {
    const thread = threadOf(id)
    store.update((list) => { const chat = list.find((entry) => entry.id === chatIdOf(id)); if (chat?.topics) chat.topics = chat.topics.filter((topic) => !sameThread(topic.thread, thread)) })
    forgetPlace(id)
  }

  /** A topic's name: the project folder, and the session's title when it has one. */
  async function topicName(directory: string, sessionId?: SessionId, title?: string) {
    let named = title
    if (!named && sessionId) {
      const reply = await host.send({ type: "session.list", directory, limit: 50, roots: true })
      named = reply.ok ? ((reply.result as { sessions?: SessionSummary[] } | undefined)?.sessions ?? []).find((session) => session.sessionId === sessionId)?.title : undefined
    }
    const project = path.basename(directory) || directory
    return named && named !== service ? `${project} · ${clip(named, 90)}` : project
  }

  async function ensureSession(id: Place): Promise<SessionId | undefined> {
    const stored = chatOf(id)
    const directory = directoryOf(id)
    if (!stored || !directory) return undefined
    const state = runtime(id)
    if (state.sessionId) return state.sessionId
    const known = storedSession(id)
    if (known) {
      const joined = await join(id, state, known)
      if (joined.ok) { enter(id, state, known, joined.events); return state.sessionId }
      if (joined.gone) return undefined
    }
    const created = await host.send({ type: "session.create", directory, title: service })
    const sessionId = created.ok ? created.result?.sessionId as SessionId | undefined : undefined
    if (!sessionId) { await say(id, `Could not start a session: ${created.ok ? "no session id" : clip(created.error.message, 200)}`); return undefined }
    const joined = await join(id, state, sessionId)
    if (!joined.ok) { if (!joined.gone) await say(id, `Could not follow the session: ${clip(joined.error.message, 200)}`); return undefined }
    enter(id, state, sessionId, joined.events)
    saveSession(id, sessionId)
    return sessionId
  }

  /**
   * Starts the watch of `sessionId` for a chat without moving it yet. A turn already running replays from its start, and while the watch
   * starts every event of that session is held (live ones too, when another chat already follows it), so nothing is skipped or lost.
   */
  async function join(id: string, state: Runtime, sessionId: SessionId): Promise<({ ok: true; events: SessionEvent[] }) | { ok: false; gone?: true; error: { message: string } }> {
    const joining = { sessionId, events: [] as SessionEvent[] }
    state.joining = joining
    const watched = await host.watch(sessionId).finally(() => { if (state.joining === joining) state.joining = undefined })
    // Unpaired (or moved by a new code, or its topic deleted) while the watch started: what was held never reaches the chat.
    if (runtimes.get(id) !== state || !chatOf(id)) {
      if (watched.ok) release(id, sessionId)
      return { ok: false, gone: true, error: { message: "this chat is no longer paired" } }
    }
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
      const joined = await join(id, state, sessionId)
      if (!joined.ok) { if (!joined.gone) await say(id, `Could not follow that session: ${clip(joined.error.message, 200)}`); return false }
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
      return [`**You:** ${clip(asked.trim(), 400)}`, answer ? `**MendCode:** ${clip(answer.trim(), 900)}` : `_(${turn.outcome})_`].join("\n")
    })
    return md(id, host.mask(sessionId, `**${history.older ? "Last" : "All"} ${history.turns.length} turn${history.turns.length === 1 ? "" : "s"}**\n\n${blocks.join("\n\n")}`))
  }

  async function runTurn(id: string, text: string) {
    const state = runtime(id)
    if (state.turn) return say(id, "A turn is running. /stop cancels it.")
    // The session may take a message into the turn it is running, which then never starts one of this chat's own.
    if (state.mirror) return say(id, "A turn from the computer is running. Wait for its answer, or /stop it.")
    const sessionId = await ensureSession(id)
    if (!sessionId) return
    // Joining the session may have replayed a running turn into the chat.
    if (state.turn) return say(id, "A turn is running. /stop cancels it.")
    if (state.mirror) return say(id, "A turn from the computer is running. Wait for its answer, or /stop it.")
    const turn = newTurn(false)
    state.turn = turn
    void api.sendTyping(chatIdOf(id), threadOf(id)).catch(() => {})
    // Queued, never steered into a turn that started meanwhile: the message always starts a turn of its own that names it.
    const reply = await host.send({ type: "user.submit", sessionId, text, attachments: [], delivery: "queue" })
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
      void api.editMessage!(chatIdOf(id), progress.messageId, text, threadOf(id)).catch(() => {})
    }, Math.max(0, progress.editedAt + EDIT_MS - now()))
  }

  function closeTurn(turn: Turn | undefined) {
    if (!turn) return
    turn.progress.done = true
    if (turn.progress.timer) clearTimeout(turn.progress.timer)
    turn.progress.timer = undefined
  }

  /** `markdown`: the answer is the model's text, sent formatted. */
  function finish(id: string, state: Runtime, turn: Turn, text: string, outcome: string, markdown = false) {
    if (state.turn === turn) state.turn = undefined
    if (state.mirror === turn) state.mirror = undefined
    for (const [key, pending] of state.pending) if (pending.kind === "approval" || pending.kind === "question") state.pending.delete(key)
    closeTurn(turn)
    const progress = turn.progress
    const answer = () => (markdown ? md(id, text) : say(id, text))
    if (!progress.sending || !api.editMessage) return answer()
    // The progress line closes with the outcome before the answer arrives below it.
    const closing = `${outcome} · ${tools(progress.tools)} · ${elapsed(progress)}`
    return progress.sending
      .then(() => progress.messageId === undefined ? undefined : api.editMessage!(chatIdOf(id), progress.messageId, closing, threadOf(id)).catch(() => {}))
      .then(answer)
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
        if (turn.mirrored && turn.users.has(event.itemId) && event.text?.trim()) void md(id, `**From the computer:**\n${clip(host.mask(sessionId, event.text.trim()))}`)
        break
      case "server.request": {
        if (event.kind === "approval" && (event.planReview || event.questions)) { void say(id, "A plan review needs an answer on the computer."); break }
        if (event.kind === "question" && event.questions) { void say(id, "This question needs an answer on the computer."); break }
        const number = ++counter
        const detail = clip(host.mask(sessionId, `${event.title}\n${event.detail}`.trim()))
        if (event.kind === "approval") {
          state.pending.set(number, { sessionId, requestId: event.requestId, kind: "approval", options: [] })
          // The request (a command, a path, a diff) reads as written: in a code block, never as Markdown.
          const shown = clip(host.mask(sessionId, event.detail.trim())).replace(/`{3,}/g, "''\'")
          void md(id, `**Approve${event.tool ? ` ${event.tool}` : ""}?**\n${clip(host.mask(sessionId, event.title.trim()), 300)}${shown ? `\n\`\`\`\n${shown}\n\`\`\`` : ""}`, [[{ text: "Allow once", data: `ap:${number}:y` }, { text: "Deny", data: `ap:${number}:n` }]])
        } else if (event.title === SETTINGS_PROPOSAL_LOCAL) {
          // A settings change that names a key only the machine running MendCode sets (permission, sandbox…) is answered there, never from a chat.
          void say(id, `${detail}\nAnswer this on the computer that runs MendCode.`)
        } else {
          const options = (event.options ?? []).map((option) => option.label)
          state.pending.set(number, { sessionId, requestId: event.requestId, kind: "question", options })
          void md(id, `${detail}\n_Reply with your answer._`, options.length ? options.map((label, index) => [{ text: label.slice(0, 60), data: `q:${number}:${index}` }]) : undefined)
        }
        break
      }
      case "server.request.resolved":
        for (const [key, pending] of state.pending) if (pending.requestId === event.requestId) state.pending.delete(key)
        break
      case "turn.completed": {
        const answer = [...turn.answers.values()].filter((value) => value.trim()).at(-1)
        void finish(id, state, turn, answer ? host.mask(sessionId, answer) : "Done (no text answer).", "Done", answer !== undefined)
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
    // Only the place's current session is answered from here.
    if (!pending || pending.sessionId !== state.sessionId) { if (callback) await api.answerCallback(callback, "Expired").catch(() => {}); return false }
    state.pending.delete(number)
    const reply = await host.send({ type: "request.resolve", sessionId: pending.sessionId, requestId: pending.requestId as never, decision })
    const text = reply.ok ? done : "Already answered"
    if (callback) await api.answerCallback(callback, text).catch(() => {})
    else await say(id, text)
    return reply.ok
  }

  /** The project's recent sessions as buttons; pressing one moves the place there, or opens it in its own topic. */
  async function listSessions(id: Place) {
    const stored = chatOf(id)
    const directory = directoryOf(id)
    if (!stored || !directory) return
    const reply = await host.send({ type: "session.list", directory, limit: SESSION_PICKS, roots: true, hideEmpty: true })
    if (!reply.ok) return say(id, `Could not list sessions: ${clip(reply.error.message, 200)}`)
    const sessions = ((reply.result as { sessions?: SessionSummary[] } | undefined)?.sessions ?? []).slice(0, SESSION_PICKS)
    if (!sessions.length) return say(id, "No sessions in this project yet; send a message to start one.")
    const state = runtime(id)
    const current = state.sessionId ?? storedSession(id)
    // A button names its session, so an older list still picks what it shows; only sessions a list offered are accepted.
    for (const session of sessions) { state.picks.delete(session.sessionId); state.picks.set(session.sessionId, session.title) }
    for (const old of state.picks.keys()) { if (state.picks.size <= MAX_PICKS) break; state.picks.delete(old) }
    const open = new Set((stored.topics ?? []).map((topic) => topic.sessionId).filter(Boolean))
    return md(id, `**Sessions in ${path.basename(directory) || directory}**${await topicsOn() ? `\nA pick opens in its own ${words.topic}.` : ""}`, sessions.map((session) => [{ text: `${session.sessionId === current ? "• " : open.has(session.sessionId) ? "# " : ""}${clip(session.title || "Untitled", 50)}${session.state !== "idle" ? " (working)" : ""}`, data: `s:${session.sessionId}` }]))
  }

  /** A /sessions pick with topics on: the session's topic, opened (or made) and followed there; the place itself stays where it is. */
  async function pickInTopic(id: Place, sessionId: SessionId, title: string | undefined): Promise<string | undefined> {
    const chat = chatIdOf(id)
    const directory = directoryOf(id)!
    const existing = chatOf(id)?.topics?.find((topic) => topic.sessionId === sessionId)
    if (existing) {
      if (placeOf(chat, existing.thread) === id) return "Already here"
      await say(id, `That session already has its ${words.topic}.`, topicLink(placeOf(chat, existing.thread)))
      return "Already open"
    }
    const place = await openTopic(chat, await topicName(directory, sessionId, title), directory, sessionId)
    if (!place) return undefined
    await link(place, sessionId, RECAP_TURNS)
    await say(id, `Opened in its own ${words.topic}.`, topicLink(place))
    return "Opened"
  }

  async function command(id: string, name: string, args: string) {
    const state = runtime(id)
    switch (name) {
      case "start": case "help": return md(id, `${HELP}${await topicsOn() ? `\n\n${words.topicsHint}` : ""}`)
      case "status":
        return md(id, `**Project** ${directoryOf(id) ?? "?"}\n**Session** ${state.sessionId ?? storedSession(id) ?? "none yet"}\n${state.turn || state.mirror ? "A turn is running" : "Idle"}${await topicsOn() ? `\n**${words.topics}** ${(chatOf(id)?.topics ?? []).length} open` : ""}`)
      case "sessions": return listSessions(id)
      case "history": {
        const sessionId = state.sessionId ?? storedSession(id)
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
      case "new": {
        const directory = directoryOf(id)
        // With topics, a fresh session gets a topic of its own and this place keeps its session.
        if (directory && await topicsOn()) {
          const place = await openTopic(chatIdOf(id), `${path.basename(directory) || directory} · new`, directory)
          if (place) {
            await say(place, "Fresh session; your next message here starts it.")
            return say(id, `Opened a new ${words.topic}.`, topicLink(place))
          }
        }
        if (state.turn) return say(id, "A turn is running. /stop first.")
        leave(id, state)
        saveSession(id, undefined)
        return say(id, "Fresh session; your next message starts it.")
      }
      case "file": {
        const directory = directoryOf(id)
        if (!directory) return
        const file = readChannelFile({ directory, dataDir, input: args })
        if (!file.ok) return say(id, `Not sent: ${file.reason}`)
        return api.sendDocument(chatIdOf(id), { name: file.name, bytes: file.bytes }, threadOf(id)).catch((error: unknown) => say(id, `Not sent: ${error instanceof Error ? clip(error.message, 200) : "upload failed"}`))
      }
      case "unpair": {
        const chat = chatIdOf(id)
        store.update((list) => list.filter((entry) => entry.id !== chat))
        forget(chat)
        return say(id, "Unpaired.")
      }
      default: return say(id, "Unknown command. /help lists them.")
    }
  }

  function forgetPlace(id: Place) {
    const state = runtimes.get(id)
    release(id, state?.sessionId)
    closeTurn(state?.turn)
    closeTurn(state?.mirror)
    runtimes.delete(id)
  }

  /** Every place of chat `chat`: the chat and its topics. */
  function forget(chat: string) {
    for (const id of [...runtimes.keys()]) if (chatIdOf(id) === chat) forgetPlace(id)
  }

  /** A voice message as text (opt-in `voice.enabled`); the transcript is echoed so a mishearing is visible. Undefined when nothing can be run. */
  async function hear(id: string, voice: ChannelVoice): Promise<string | undefined> {
    if (!transcribe || !api.downloadFile) { await say(id, "Voice messages are not available."); return undefined }
    if ((voice.duration ?? 0) > VOICE_LIMIT_SECONDS || (voice.size ?? 0) > VOICE_LIMIT_BYTES) { await say(id, "That voice message is too long; keep it under 5 minutes."); return undefined }
    let bytes: Uint8Array
    try { bytes = await api.downloadFile(voice.file, VOICE_LIMIT_BYTES) } catch (error) {
      await say(id, `Could not get the voice message: ${error instanceof Error ? clip(error.message, 200) : "download failed"}`)
      return undefined
    }
    const heard = await transcribe({ bytes, name: "voice.ogg", mime: voice.mime ?? "audio/ogg" })
    if (!heard.ok) { await say(id, `Could not transcribe: ${clip(heard.message, 200)}`); return undefined }
    if (!heard.text) { await say(id, "Heard nothing in that voice message."); return undefined }
    await say(id, `Heard: ${clip(heard.text, 500)}`)
    return heard.text
  }

  /**
   * `/pair CODE`: pairs a new chat, or moves a paired one to the code's project and session. With topics on, the code's session opens
   * in a topic of its own instead, so a chat follows sessions of several projects side by side.
   */
  async function claim(id: Place, code: string, label: string | undefined, from: string) {
    const chat = chatIdOf(id)
    const known = chatOf(id)
    if (!known && chats().length >= MAX_CHANNEL_CHATS) return say(id, "Too many paired chats.")
    const claimed = pairing.claim(chat, code)
    if (!claimed.ok) return say(id, known ? "That code is not valid or has expired. This chat stays paired." : "That code is not valid or has expired.")
    const sessionId = claimed.sessionId as SessionId | undefined
    // The person who pairs owns the chat: in a channel others can read, only they drive it.
    if (!known) store.update((list) => { list.push({ id: chat, ...(label ? { name: label.slice(0, 100) } : {}), directory: claimed.directory, pairedAt: Date.now(), owner: from }) })
    if (await topicsOn() && (known || sessionId)) {
      const place = await openTopic(chat, await topicName(claimed.directory, sessionId), claimed.directory, sessionId)
      if (place) {
        log("info", `${service.toLowerCase()} ${known ? words.topic : "chat"} paired`)
        if (!known) await md(chat, `Paired.\n\n${HELP}\n\n${words.topicsHint}`)
        await md(place, `**Paired with** \`${claimed.directory}\``)
        if (sessionId) await link(place, sessionId, RECAP_TURNS)
        if (known) await say(id, `Paired ${path.basename(claimed.directory) || claimed.directory} in its own ${words.topic}.`, topicLink(place))
        return
      }
    }
    if (known) store.update((list) => { const entry = list.find((stored) => stored.id === chat); if (entry) { entry.directory = claimed.directory; delete entry.sessionId; delete entry.topics } })
    log("info", `${service.toLowerCase()} chat ${known ? "moved" : "paired"}`)
    if (known) forget(chat)
    await md(chat, `**Paired with** \`${claimed.directory}\`\n\n${HELP}`)
    if (sessionId) await link(chat, sessionId, RECAP_TURNS)
  }

  /** A paired chat answers only the person who paired it; chats paired before owners were kept answer their chat as before. */
  const foreign = (id: Place, from: string) => { const owner = chatOf(id)?.owner; return owner !== undefined && owner !== from }

  async function message(update: Extract<ChannelUpdate, { kind: "message" }>) {
    if (!update.allowed) return
    const id = placeOf(update.chat, update.thread)
    if (foreign(id, update.from)) return
    const text = (update.text ?? "").trim()
    const slash = /^[/!]([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text)
    const name = slash?.[1]?.toLowerCase(), args = (slash?.[2] ?? "").trim()
    if (!chatOf(id)) {
      if (pairing.blocked(chatIdOf(id))) return
      if (name === "pair") return claim(id, args, update.label, update.from)
      if (name === "start") return say(id, words.pairHint)
      return
    }
    if (name === "pair") return pairing.blocked(chatIdOf(id)) ? undefined : claim(id, args, undefined, update.from)
    // A transcript is always a plain prompt, never a chat command.
    const spoken = !text && update.voice ? await hear(id, update.voice) : undefined
    if (!text && spoken === undefined) return update.voice ? undefined : say(id, "Only text messages are supported.")
    if (name) return command(id, name, args)
    const prompt = spoken ?? text
    const state = runtime(id)
    const question = [...state.pending].find(([, pending]) => pending.kind === "question" && pending.sessionId === state.sessionId)
    if (question) return resolve(id, question[0], { kind: "answer", text: prompt }, "Sent").then(() => {})
    // A prompt in the channel itself starts a new session in a thread named after it; the channel stays a lobby.
    if (autoThread && update.thread === undefined && await topicsOn()) {
      const directory = directoryOf(id)
      const place = directory ? await openTopic(chatIdOf(id), clip(prompt.replace(/\s+/g, " "), 90), directory, undefined, update.messageId) : undefined
      if (place) return runTurn(place, prompt)
    }
    return runTurn(id, prompt)
  }

  async function callback(query: Extract<ChannelUpdate, { kind: "press" }>) {
    if (!query.allowed) return
    const id = placeOf(query.chat, query.thread)
    if (!chatOf(id)) return
    if (foreign(id, query.from)) { await api.answerCallback(query.id, "Only the person who paired this chat can answer").catch(() => {}); return }
    const picked = /^s:([A-Za-z0-9_]{1,60})$/.exec(query.data ?? "")
    if (picked) {
      const sessionId = picked[1] as SessionId
      const picks = runtime(id).picks
      if (!picks.has(sessionId)) { await api.answerCallback(query.id, "Expired").catch(() => {}); return }
      const opened = await topicsOn() ? await pickInTopic(id, sessionId, picks.get(sessionId)) : undefined
      if (opened) { await api.answerCallback(query.id, opened).catch(() => {}); return }
      const moved = await link(id, sessionId, RECAP_TURNS)
      await api.answerCallback(query.id, moved ? "Switched" : "Not switched").catch(() => {})
      return
    }
    const match = /^(ap|q):(\d+):(y|n|\d)$/.exec(query.data ?? "")
    if (!match) return
    const number = Number(match[2])
    if (match[1] === "ap") await resolve(id, number, match[3] === "y" ? { kind: "approve", scope: "once" } : { kind: "deny", reason: `denied from ${service}` }, match[3] === "y" ? "Allowed" : "Denied", query.id)
    else {
      const option = runtime(id).pending.get(number)?.options[Number(match[3])]
      if (option === undefined) await api.answerCallback(query.id, "Expired").catch(() => {})
      else await resolve(id, number, { kind: "answer", text: option }, "Sent", query.id)
    }
  }

  /** At start, follows again the session of each paired chat and topic, so its turns show without a message from the phone first. */
  async function resume() {
    for (const chat of chats()) {
      const places: Array<[Place, string | undefined]> = [[chat.id, chat.sessionId], ...(chat.topics ?? []).map((topic): [Place, string | undefined] => [placeOf(chat.id, topic.thread), topic.sessionId])]
      for (const [id, sessionId] of places) {
        if (!sessionId) continue
        const state = runtime(id)
        const joined = await join(id, state, sessionId as SessionId)
        if (joined.ok) enter(id, state, sessionId as SessionId, joined.events)
      }
    }
  }

  return {
    async update(update: ChannelUpdate) {
      try {
        if (update.kind === "message") await message(update)
        else await callback(update)
      } catch (error) {
        log("warn", `[CHANNELS]: update failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`)
      }
    },
    onEvent,
    forget,
    resume,
    stop() { for (const id of [...runtimes.keys()]) forgetPlace(id) },
  }
}

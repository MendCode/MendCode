import type { CommandInput, CommandReply } from "@mendcode/client"
import { startedQueueIds, type QueueId, type SessionEvent, type SessionId } from "@mendcode/protocol"
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

type Api = Pick<TelegramApi, "sendMessage" | "answerCallback" | "sendTyping" | "sendDocument"> & Partial<Pick<TelegramApi, "downloadFile">>
const VOICE_LIMIT_BYTES = 20 * 1024 * 1024
const VOICE_LIMIT_SECONDS = 300
type Pending = { sessionId: SessionId; requestId: string; kind: "approval" | "question"; options: string[] }
type Turn = { buffered: SessionEvent[]; queueId?: string; turnId?: string; answers: Map<string, string> }
type Runtime = { sessionId?: SessionId; turn?: Turn | undefined; pending: Map<number, Pending> }

const HELP = [
  "MendCode remote control",
  "Send a message to run a turn in your project session.",
  "/stop  cancel the running turn",
  "/new  start a fresh session",
  "/status  session and turn state",
  "/file PATH  receive a project file",
  "/unpair  disconnect this chat",
].join("\n")
const DETAIL_LIMIT = 1500

export function createChannelBridge({ api, host, config, pairing, dataDir, log, transcribe }: { api: Api; host: BridgeHost; config: ChannelsConfig; pairing: ReturnType<typeof createPairing>; dataDir: string; log(level: "info" | "warn", message: string): void; transcribe?: (input: { bytes: Uint8Array; name: string; mime: string }) => Promise<Transcription> }) {
  const runtimes = new Map<string, Runtime>()
  const runtime = (id: string) => { let found = runtimes.get(id); if (!found) runtimes.set(id, found = { pending: new Map() }); return found }
  const chats = () => config.read().telegram.chats
  const chatOf = (id: string) => chats().find((chat) => chat.id === id)
  let counter = 0

  const say = (id: string, text: string, buttons?: Parameters<Api["sendMessage"]>[2]) => api.sendMessage(id, text, buttons).catch((error: unknown) => log("warn", error instanceof Error ? error.message : "[CHANNELS]: send failed"))
  const clip = (text: string, limit = DETAIL_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}…` : text)

  function saveSession(id: string, sessionId: SessionId | undefined) {
    config.update((value) => { const chat = value.telegram.chats.find((entry) => entry.id === id); if (chat) { if (sessionId) chat.sessionId = sessionId; else delete chat.sessionId } })
  }

  async function ensureSession(id: string): Promise<SessionId | undefined> {
    const stored = chatOf(id)
    if (!stored) return undefined
    const state = runtime(id)
    if (state.sessionId) return state.sessionId
    if (stored.sessionId) {
      const watched = await host.watch(stored.sessionId as SessionId)
      if (watched.ok) return state.sessionId = stored.sessionId as SessionId
    }
    const created = await host.send({ type: "session.create", directory: stored.directory, title: "Telegram" })
    const sessionId = created.ok ? created.result?.sessionId as SessionId | undefined : undefined
    if (!sessionId) { await say(id, `Could not start a session: ${created.ok ? "no session id" : clip(created.error.message, 200)}`); return undefined }
    const watched = await host.watch(sessionId)
    if (!watched.ok) { await say(id, `Could not follow the session: ${clip(watched.error.message, 200)}`); return undefined }
    saveSession(id, sessionId)
    return state.sessionId = sessionId
  }

  async function runTurn(id: string, text: string) {
    const state = runtime(id)
    if (state.turn) return say(id, "A turn is running. /stop cancels it.")
    const sessionId = await ensureSession(id)
    if (!sessionId) return
    const turn: Turn = { buffered: [], answers: new Map() }
    state.turn = turn
    void api.sendTyping(id).catch(() => {})
    const reply = await host.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (!reply.ok) { state.turn = undefined; return say(id, `Not sent: ${clip(host.mask(sessionId, reply.error.message), 300)}`) }
    if (reply.result?.handled === true) { state.turn = undefined; return say(id, String(reply.result.notice ?? "Done.")) }
    if (typeof reply.result?.queueId !== "string") { state.turn = undefined; return say(id, "The daemon did not accept the message.") }
    turn.queueId = reply.result.queueId
    for (const event of turn.buffered.splice(0)) handleEvent(id, state, turn, event)
  }

  function finish(id: string, state: Runtime, turn: Turn, text: string) {
    if (state.turn === turn) state.turn = undefined
    for (const [key, pending] of state.pending) if (pending.kind === "approval" || pending.kind === "question") state.pending.delete(key)
    return say(id, text)
  }

  function handleEvent(id: string, state: Runtime, turn: Turn, event: SessionEvent) {
    if (!turn.turnId) {
      if (event.type === "turn.started" && turn.queueId && startedQueueIds(event).includes(turn.queueId as QueueId)) turn.turnId = event.turnId
      else return
    }
    if ("turnId" in event && event.turnId !== turn.turnId) return
    const sessionId = event.sessionId
    switch (event.type) {
      case "item.started":
        if (event.kind === "agent_message") turn.answers.set(event.itemId, "")
        break
      case "item.delta":
        if (turn.answers.has(event.itemId)) turn.answers.set(event.itemId, turn.answers.get(event.itemId)! + event.text)
        break
      case "item.completed":
        if (turn.answers.has(event.itemId) && !turn.answers.get(event.itemId) && event.text) turn.answers.set(event.itemId, event.text)
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
        void finish(id, state, turn, answer ? host.mask(sessionId, answer) : "Done (no text answer).")
        break
      }
      case "turn.failed":
        void finish(id, state, turn, `Failed: ${event.error.code}: ${clip(host.mask(sessionId, event.error.message), 500)}`)
        break
      case "turn.cancelled":
      case "turn.interrupted":
        void finish(id, state, turn, "Stopped.")
        break
    }
  }

  function onEvent(event: SessionEvent) {
    for (const [id, state] of runtimes) {
      if (state.sessionId !== event.sessionId || !state.turn) continue
      if (state.turn.queueId === undefined) state.turn.buffered.push(event)
      else handleEvent(id, state, state.turn, event)
    }
  }

  async function resolve(id: string, number: number, decision: Extract<CommandInput, { type: "request.resolve" }>["decision"], done: string, callback?: string) {
    const state = runtime(id)
    const pending = state.pending.get(number)
    if (!pending) { if (callback) await api.answerCallback(callback, "Expired").catch(() => {}); return false }
    state.pending.delete(number)
    const reply = await host.send({ type: "request.resolve", sessionId: pending.sessionId, requestId: pending.requestId as never, decision })
    const text = reply.ok ? done : "Already answered"
    if (callback) await api.answerCallback(callback, text).catch(() => {})
    else await say(id, text)
    return reply.ok
  }

  async function command(id: string, name: string, args: string) {
    const state = runtime(id)
    switch (name) {
      case "start": case "help": return say(id, HELP)
      case "pair": return say(id, "This chat is already paired.")
      case "status": {
        const stored = chatOf(id)
        return say(id, `Project ${stored?.directory ?? "?"}\nSession ${state.sessionId ?? stored?.sessionId ?? "none yet"}\n${state.turn ? "A turn is running" : "Idle"}`)
      }
      case "stop":
        if (!state.turn || !state.sessionId) return say(id, "Nothing is running.")
        if (!state.turn.turnId) return say(id, "The turn is still starting; try again.")
        { const reply = await host.send({ type: "turn.cancel", sessionId: state.sessionId, turnId: state.turn.turnId as never }); if (!reply.ok) return say(id, `Could not stop: ${clip(reply.error.message, 200)}`) }
        return
      case "new":
        if (state.turn) return say(id, "A turn is running. /stop first.")
        if (state.sessionId) host.unwatch(state.sessionId)
        delete state.sessionId
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
    if (state?.sessionId) host.unwatch(state.sessionId)
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

  async function message(chat: NonNullable<TelegramUpdate["message"]>) {
    if (chat.chat.type !== "private") return
    const id = String(chat.chat.id)
    const text = (chat.text ?? "").trim()
    const slash = /^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text)
    const name = slash?.[1]?.toLowerCase(), args = (slash?.[2] ?? "").trim()
    if (!chatOf(id)) {
      if (pairing.blocked(id)) return
      if (name === "pair") {
        if (chats().length >= MAX_CHANNEL_CHATS) return say(id, "Too many paired chats.")
        const claimed = pairing.claim(id, args)
        if (!claimed.ok) return say(id, "That code is not valid or has expired.")
        const label = chat.chat.username ?? chat.chat.first_name
        config.update((value) => { value.telegram.chats.push({ id, ...(label ? { name: label.slice(0, 100) } : {}), directory: claimed.directory, pairedAt: Date.now() }) })
        log("info", "telegram chat paired")
        return say(id, `Paired with ${claimed.directory}.\n${HELP}`)
      }
      if (name === "start") return say(id, "Pair this chat with /pair CODE. Create the code with /remote-control in the MendCode terminal.")
      return
    }
    // A transcript is always a plain prompt, never a chat command.
    const spoken = !text && chat.voice ? await hear(id, chat.voice) : undefined
    if (!text && spoken === undefined) return chat.voice ? undefined : say(id, "Only text messages are supported.")
    if (name) return command(id, name, args)
    const prompt = spoken ?? text
    const state = runtime(id)
    const question = [...state.pending].find(([, pending]) => pending.kind === "question")
    if (question) return resolve(id, question[0], { kind: "answer", text: prompt }, "Sent").then(() => {})
    return runTurn(id, prompt)
  }

  async function callback(query: NonNullable<TelegramUpdate["callback_query"]>) {
    const chat = query.message?.chat
    const id = chat ? String(chat.id) : undefined
    if (!id || chat?.type !== "private" || !chatOf(id)) return
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
    stop() { for (const id of [...runtimes.keys()]) forget(id) },
  }
}

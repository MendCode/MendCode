/** Telegram Bot API over an injected `fetch` (tests pass a local fake; nothing here opens a socket itself). */
import type { ChannelApi, ChannelUpdate } from "./channels-api"
export type TelegramChat = { id: number; type: string; first_name?: string; username?: string }
export type TelegramVoice = { file_id: string; duration?: number; file_size?: number; mime_type?: string }
export type TelegramUpdate = {
  update_id: number
  /** `message_thread_id` names a topic only when `is_topic_message` is set (bot topics in a private chat). */
  message?: { message_id: number; chat: TelegramChat; from?: { id: number }; text?: string; voice?: TelegramVoice; message_thread_id?: number; is_topic_message?: boolean }
  callback_query?: { id: string; from?: { id: number }; data?: string; message?: { chat: TelegramChat; message_thread_id?: number; is_topic_message?: boolean } }
}
/** A button answers the bot (`data`) or opens a link (`url`, such as a topic's t.me link). */
export type TelegramButton = { text: string; data: string } | { text: string; url: string }
/** Where a message goes: the chat, or one topic of it; `markdown` sends the text formatted. */
export type TelegramSend = { thread?: number | undefined; markdown?: boolean | undefined }
export type TelegramApi = ReturnType<typeof createTelegramApi>

const MESSAGE_LIMIT = 3800

/** Splits at line breaks where it can, so a long answer arrives in readable parts under Telegram's 4096 limit. */
export function splitMessage(text: string, limit = MESSAGE_LIMIT) {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit)
    const at = cut > limit / 2 ? cut : limit
    parts.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) parts.push(rest)
  return parts.length ? parts : [""]
}

export function createTelegramApi({ token, fetch: request = fetch, base = "https://api.telegram.org" }: { token: string; fetch?: typeof fetch; base?: string }) {
  /** The token is part of every URL: no error, log line or message may carry it. */
  const scrub = (text: string) => text.split(token).join("***")

  async function call<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const form = body instanceof FormData
    let response: Response
    try {
      response = await request(`${base}/bot${token}/${method}`, {
        method: "POST",
        ...(form ? {} : { headers: { "content-type": "application/json" } }),
        body: form ? body : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error(`[CHANNELS]: telegram ${method} failed: ${scrub(error instanceof Error ? error.message : String(error))}`)
    }
    let payload: { ok?: boolean; result?: T; description?: string }
    try { payload = await response.json() as typeof payload } catch { throw new Error(`[CHANNELS]: telegram ${method} failed: HTTP ${response.status}`) }
    if (!response.ok || payload.ok !== true) throw new Error(`[CHANNELS]: telegram ${method} failed: ${scrub(payload.description ?? `HTTP ${response.status}`).slice(0, 200)}`)
    return payload.result as T
  }

  const keyboard = (rows: TelegramButton[][]) => ({ inline_keyboard: rows.map((row) => row.map((button) => "url" in button ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data })) })
  const threadOf = (thread: number | undefined) => (thread === undefined ? {} : { message_thread_id: thread })

  /** One part, formatted when asked; a part Telegram cannot parse goes again as the plain text it came from. */
  async function sendPart(chatId: string, part: string, options: TelegramSend, markup: Record<string, unknown>, html?: (markdown: string) => string) {
    const base = { chat_id: chatId, disable_web_page_preview: true, ...threadOf(options.thread), ...markup }
    if (html) {
      try {
        return await call<{ message_id?: number } | undefined>("sendMessage", { ...base, text: html(part) || "(empty)", parse_mode: "HTML" }, 30_000)
      } catch (error) {
        if (!(error instanceof Error && /can't parse entities|can't find end|unsupported start tag|unexpected end tag/i.test(error.message))) throw error
      }
    }
    return call<{ message_id?: number } | undefined>("sendMessage", { ...base, text: part || "(empty)" }, 30_000)
  }

  return {
    getMe: (signal?: AbortSignal) => call<{ username?: string; has_topics_enabled?: boolean }>("getMe", {}, 15_000, signal),
    getUpdates: ({ offset, timeoutSeconds, signal }: { offset?: number; timeoutSeconds: number; signal?: AbortSignal }) =>
      call<TelegramUpdate[]>("getUpdates", { ...(offset === undefined ? {} : { offset }), timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }, timeoutSeconds * 1000 + 15_000, signal),
    /** Sends `text` in parts under the size limit; resolves to the id of the last part (what `editMessage` can change). */
    async sendMessage(chatId: string, text: string, buttons?: TelegramButton[][], options: TelegramSend = {}): Promise<number | undefined> {
      // The formatter is loaded by the first formatted message, never with the daemon.
      const format = options.markdown ? await import("./channels-format") : undefined
      const parts = format ? format.balanceFences(splitMessage(text)) : splitMessage(text)
      let last: number | undefined
      for (const [index, part] of parts.entries()) {
        const sent = await sendPart(chatId, part, options, buttons && index === parts.length - 1 ? { reply_markup: keyboard(buttons) } : {}, format?.markdownToTelegramHtml)
        last = typeof sent?.message_id === "number" ? sent.message_id : undefined
      }
      return last
    },
    /** A topic of the private chat with the bot (topic mode on in @BotFather); resolves to its thread id. */
    async createTopic(chatId: string, name: string): Promise<number> {
      const topic = await call<{ message_thread_id?: number }>("createForumTopic", { chat_id: chatId, name: name.slice(0, 128) || "MendCode" }, 15_000)
      if (typeof topic?.message_thread_id !== "number") throw new Error("[CHANNELS]: telegram createForumTopic returned no topic")
      return topic.message_thread_id
    },
    /** Replaces a message's text (the live progress line); text past the limit is cut, never split. */
    editMessage: (chatId: string, messageId: number, text: string) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, text: (text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text) || "(empty)", disable_web_page_preview: true }, 15_000),
    answerCallback: (id: string, text?: string) => call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 180) } : {}) }, 15_000),
    sendTyping: (chatId: string, thread?: number) => call("sendChatAction", { chat_id: chatId, action: "typing", ...threadOf(thread) }, 15_000),
    /** A file the chat sent (a voice message); the download URL carries the token, so errors are scrubbed. */
    async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
      const info = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, 15_000)
      if (!info.file_path) throw new Error("[CHANNELS]: telegram getFile returned no path")
      if (info.file_size !== undefined && info.file_size > maxBytes) throw new Error("[CHANNELS]: voice message is too large")
      try {
        const response = await request(`${base}/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.length > maxBytes) throw new Error("voice message is too large")
        return bytes
      } catch (error) {
        throw new Error(`[CHANNELS]: telegram file download failed: ${scrub(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
      }
    },
    sendDocument(chatId: string, file: { name: string; bytes: Uint8Array; caption?: string }, thread?: number) {
      const form = new FormData()
      form.set("chat_id", chatId)
      if (thread !== undefined) form.set("message_thread_id", String(thread))
      if (file.caption) form.set("caption", file.caption.slice(0, 900))
      form.set("document", new Blob([file.bytes as BlobPart]), file.name)
      return call("sendDocument", form, 120_000)
    },
  }
}

/** A Telegram update as the bridge reads it: only private chats run, and a topic is named only when `is_topic_message` is set. */
export function telegramUpdate(update: TelegramUpdate): ChannelUpdate | undefined {
  const message = update.message
  if (message) {
    const thread = message.is_topic_message && message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined
    const label = message.chat.username ?? message.chat.first_name
    const voice = message.voice ? { file: message.voice.file_id, duration: message.voice.duration, size: message.voice.file_size, mime: message.voice.mime_type } : undefined
    return { kind: "message", chat: String(message.chat.id), thread, messageId: String(message.message_id), from: String(message.from?.id ?? message.chat.id), label, allowed: message.chat.type === "private", text: message.text, voice }
  }
  const query = update.callback_query
  const chat = query?.message?.chat
  if (!query || !chat) return undefined
  const thread = query.message?.is_topic_message && query.message.message_thread_id !== undefined ? String(query.message.message_thread_id) : undefined
  return { kind: "press", id: query.id, chat: String(chat.id), thread, from: String(query.from?.id ?? chat.id), allowed: chat.type === "private", data: query.data }
}

const TOPICS_RECHECK_MS = 60_000

/**
 * The Telegram API as the bridge's ChannelApi. Topic mode (`getMe`) is read again at most once a minute while it is off, so turning
 * it on in @BotFather needs no restart.
 */
export function telegramChannel(api: TelegramApi, { topics = false, botName, now = Date.now }: { topics?: boolean; botName?: string | undefined; now?: () => number } = {}): ChannelApi {
  let on = topics
  let checkedAt = now()
  const thread = (value: string | undefined) => (value === undefined ? undefined : Number(value))
  return {
    sendMessage: async (chat, text, buttons, options = {}) => {
      const id = await api.sendMessage(chat, text, buttons, { thread: thread(options.thread), markdown: options.markdown })
      return id === undefined ? undefined : String(id)
    },
    answerCallback: (id, text) => api.answerCallback(id, text),
    sendTyping: (chat, topic) => api.sendTyping(chat, thread(topic)),
    sendDocument: (chat, file, topic) => api.sendDocument(chat, file, thread(topic)),
    downloadFile: (file, maxBytes) => api.downloadFile(file, maxBytes),
    editMessage: (chat, messageId, text) => api.editMessage(chat, Number(messageId), text),
    createTopic: async (chat, name) => String(await api.createTopic(chat, name)),
    async topicsEnabled() {
      if (!on && now() - checkedAt > TOPICS_RECHECK_MS) {
        checkedAt = now()
        try { on = (await api.getMe()).has_topics_enabled === true } catch {}
      }
      return on
    },
    topicLink: (_chat, topic) => (botName ? `https://t.me/${botName}/${topic}` : undefined),
  }
}

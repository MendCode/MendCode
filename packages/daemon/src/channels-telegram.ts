/** Telegram Bot API over an injected `fetch` (tests pass a local fake; nothing here opens a socket itself). */
export type TelegramChat = { id: number; type: string; first_name?: string; username?: string }
export type TelegramVoice = { file_id: string; duration?: number; file_size?: number; mime_type?: string }
export type TelegramUpdate = {
  update_id: number
  message?: { message_id: number; chat: TelegramChat; text?: string; voice?: TelegramVoice }
  callback_query?: { id: string; data?: string; message?: { chat: TelegramChat } }
}
export type TelegramButton = { text: string; data: string }
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

  const keyboard = (rows: TelegramButton[][]) => ({ inline_keyboard: rows.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) })

  return {
    getMe: (signal?: AbortSignal) => call<{ username?: string }>("getMe", {}, 15_000, signal),
    getUpdates: ({ offset, timeoutSeconds, signal }: { offset?: number; timeoutSeconds: number; signal?: AbortSignal }) =>
      call<TelegramUpdate[]>("getUpdates", { ...(offset === undefined ? {} : { offset }), timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }, timeoutSeconds * 1000 + 15_000, signal),
    async sendMessage(chatId: string, text: string, buttons?: TelegramButton[][]) {
      const parts = splitMessage(text)
      for (const [index, part] of parts.entries()) {
        await call("sendMessage", { chat_id: chatId, text: part || "(empty)", disable_web_page_preview: true, ...(buttons && index === parts.length - 1 ? { reply_markup: keyboard(buttons) } : {}) }, 30_000)
      }
    },
    answerCallback: (id: string, text?: string) => call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 180) } : {}) }, 15_000),
    sendTyping: (chatId: string) => call("sendChatAction", { chat_id: chatId, action: "typing" }, 15_000),
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
    sendDocument(chatId: string, file: { name: string; bytes: Uint8Array; caption?: string }) {
      const form = new FormData()
      form.set("chat_id", chatId)
      if (file.caption) form.set("caption", file.caption.slice(0, 900))
      form.set("document", new Blob([file.bytes as BlobPart]), file.name)
      return call("sendDocument", form, 120_000)
    },
  }
}

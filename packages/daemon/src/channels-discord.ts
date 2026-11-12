/**
 * Discord for the chat bridge (docs/channels.md): the REST API over an injected `fetch` and the gateway over an injected WebSocket
 * (tests pass local fakes). A paired channel of the user's server is the lobby; every session runs in a thread of it, as Hermes does.
 * Loaded only when the Discord bridge is turned on.
 */
import type { ChannelApi, ChannelButton, ChannelUpdate, ChannelWords } from "./channels-api"
import { balanceFences, markdownForDiscord } from "./channels-format"
import { splitMessage } from "./channels-telegram"

const API = "https://discord.com/api/v10"
const MESSAGE_LIMIT = 1900
const EDIT_LIMIT = 2000
/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT (privileged: on in the Developer Portal). */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
const THREAD_TYPES = new Set([10, 11, 12])
const DM_TYPES = new Set([1, 3])
const VOICE_MESSAGE = 1 << 13
/** Files only come from Discord's own CDN: an attachment URL is never fetched elsewhere. */
const CDN = new Set(["cdn.discordapp.com", "media.discordapp.net"])
const ARCHIVE_MINUTES = 10080

export const DISCORD_WORDS: ChannelWords = {
  topic: "thread",
  topics: "Threads",
  pairHint: "Pair this channel with /pair CODE. Create the code with /remote-control discord pair in the MendCode terminal.",
  topicsHint: "Every session has its own thread: write in the channel to start one, or pair from another project's terminal, `/new` or a `/sessions` pick.",
}

type Fetch = typeof fetch
type Json = Record<string, unknown>

export function createDiscordApi({ token, fetch: request = fetch, base = API }: { token: string; fetch?: Fetch; base?: string }) {
  const scrub = (text: string) => text.split(token).join("***")
  const headers = { authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://github.com/MendCode/MendCode, 1)" }

  async function call<T>(method: string, route: string, body?: Json | FormData, timeoutMs = 30_000, retried = false): Promise<T> {
    const form = body instanceof FormData
    let response: Response
    try {
      response = await request(`${base}${route}`, {
        method,
        headers: form || body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`[CHANNELS]: discord ${method} failed: ${scrub(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
    if (response.status === 204) return undefined as T
    let payload: Json | undefined
    try { payload = await response.json() as Json } catch { payload = undefined }
    // Rate limited: wait what Discord asks (bounded) and try once more.
    if (response.status === 429 && !retried) {
      const wait = Math.min(10, Number(payload?.retry_after ?? 1))
      await Bun.sleep(Math.max(0, wait) * 1000)
      return call<T>(method, route, body, timeoutMs, true)
    }
    if (!response.ok) {
      const detail = typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`
      throw new Error(`[CHANNELS]: discord ${method} failed: ${scrub(detail).slice(0, 200)}${payload?.code !== undefined ? ` (${String(payload.code)})` : ""}`)
    }
    return payload as T
  }

  return {
    me: () => call<{ id: string; username?: string }>("GET", "/users/@me", undefined, 15_000),
    gateway: () => call<{ url: string }>("GET", "/gateway/bot", undefined, 15_000),
    channel: (id: string) => call<{ id: string; type: number; parent_id?: string | null; guild_id?: string }>("GET", `/channels/${id}`, undefined, 15_000),
    send: (channel: string, body: Json) => call<{ id: string }>("POST", `/channels/${channel}/messages`, body),
    edit: (channel: string, message: string, body: Json) => call<unknown>("PATCH", `/channels/${channel}/messages/${message}`, body, 15_000),
    typing: (channel: string) => call<unknown>("POST", `/channels/${channel}/typing`, {}, 15_000),
    thread: (channel: string, name: string, fromMessage?: string) => fromMessage
      ? call<{ id: string }>("POST", `/channels/${channel}/messages/${fromMessage}/threads`, { name, auto_archive_duration: ARCHIVE_MINUTES }, 15_000)
      : call<{ id: string }>("POST", `/channels/${channel}/threads`, { name, type: 11, auto_archive_duration: ARCHIVE_MINUTES }, 15_000),
    /** Acknowledges a button press at once (Discord waits 3 seconds); what the bridge answers later goes as a follow-up. */
    acknowledge: (id: string, interactionToken: string) => call<unknown>("POST", `/interactions/${id}/${interactionToken}/callback`, { type: 6 }, 10_000),
    followup: (application: string, interactionToken: string, body: Json) => call<unknown>("POST", `/webhooks/${application}/${interactionToken}`, body, 15_000),
    upload(channel: string, file: { name: string; bytes: Uint8Array; caption?: string }) {
      const form = new FormData()
      form.set("payload_json", JSON.stringify({ ...(file.caption ? { content: file.caption.slice(0, 900) } : {}), allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: file.name }] }))
      form.set("files[0]", new Blob([file.bytes as BlobPart]), file.name)
      return call<unknown>("POST", `/channels/${channel}/messages`, form, 120_000)
    },
    async download(url: string, maxBytes: number): Promise<Uint8Array> {
      let host: string
      try { host = new URL(url).hostname } catch { throw new Error("[CHANNELS]: not a Discord file") }
      if (!url.startsWith("https://") || !CDN.has(host)) throw new Error("[CHANNELS]: not a Discord file")
      const response = await request(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`[CHANNELS]: discord file download failed: HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > maxBytes) throw new Error("[CHANNELS]: voice message is too large")
      return bytes
    },
  }
}
export type DiscordApi = ReturnType<typeof createDiscordApi>

/** Buttons as Discord components: at most 5 per row and 25 in all; a link opens a URL, any other button answers the bot. */
export function discordComponents(rows: ChannelButton[][]) {
  const buttons = rows.flat().slice(0, 25)
  const out: Json[] = []
  for (let index = 0; index < buttons.length; index += 5) {
    out.push({
      type: 1,
      components: buttons.slice(index, index + 5).map((button) => "url" in button
        ? { type: 2, style: 5, label: button.text.slice(0, 80), url: button.url }
        : { type: 2, style: button.data.endsWith(":y") ? 3 : button.data.endsWith(":n") ? 4 : 2, label: button.text.slice(0, 80), custom_id: button.data.slice(0, 100) }),
    })
  }
  return out
}

const CLOSE_REASONS: Record<number, string> = {
  4004: "the Discord bot token was rejected",
  4013: "the gateway refused the intents",
  4014: "turn on the Message Content intent for the bot in the Discord Developer Portal",
}

/**
 * One gateway connection: identifies, keeps the heartbeat (a missed ack closes it), hands every dispatch to `onDispatch`, and settles
 * when it closes: resolved after `signal` aborts, rejected otherwise so the caller reconnects.
 */
export function runGateway({ url, token, intents = DISCORD_INTENTS, onDispatch, signal, WebSocket: Socket = WebSocket }: { url: string; token: string; intents?: number; onDispatch(type: string, data: Json): void; signal: AbortSignal; WebSocket?: typeof WebSocket }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket(`${url}${url.includes("?") ? "&" : "?"}v=10&encoding=json`)
    let seq: number | null = null
    let acked = true
    let timer: ReturnType<typeof setInterval> | undefined
    let first: ReturnType<typeof setTimeout> | undefined
    const send = (payload: Json) => { try { socket.send(JSON.stringify(payload)) } catch {} }
    const beat = () => {
      if (!acked) { socket.close(4000, "heartbeat not acknowledged"); return }
      acked = false
      send({ op: 1, d: seq })
    }
    const abort = () => socket.close(1000, "stopped")
    signal.addEventListener("abort", abort, { once: true })
    socket.onmessage = (message) => {
      let payload: { op?: number; t?: string | null; s?: number | null; d?: unknown }
      try { payload = JSON.parse(String(message.data)) } catch { return }
      if (typeof payload.s === "number") seq = payload.s
      switch (payload.op) {
        case 10: {
          const interval = Number((payload.d as Json | undefined)?.heartbeat_interval ?? 41_250)
          first = setTimeout(() => { beat(); timer = setInterval(beat, interval) }, Math.floor(interval * Math.random()))
          send({ op: 2, d: { token, intents, properties: { os: process.platform, browser: "mendcode", device: "mendcode" } } })
          break
        }
        case 11: acked = true; break
        case 1: send({ op: 1, d: seq }); break
        case 7: case 9: socket.close(4000, "reconnect"); break
        case 0: if (payload.t) { try { onDispatch(payload.t, (payload.d ?? {}) as Json) } catch {} } break
      }
    }
    socket.onclose = (event) => {
      clearTimeout(first)
      clearInterval(timer)
      signal.removeEventListener("abort", abort)
      if (signal.aborted) resolve()
      else reject(new Error(`[CHANNELS]: discord gateway closed: ${CLOSE_REASONS[event.code] ?? `code ${event.code}`}`))
    }
  })
}

/**
 * The Discord API as the bridge's ChannelApi, with what the gateway taught it: which channels are threads (and of which channel),
 * which are direct messages, and each channel's server (for thread links).
 */
export function discordChannel(api: DiscordApi) {
  const parents = new Map<string, string>()
  const guilds = new Map<string, string>()
  const kinds = new Map<string, number>()
  const presses = new Map<string, string>()
  let application: string | undefined
  const remember = (channel: { id?: unknown; type?: unknown; parent_id?: unknown; guild_id?: unknown }, guild?: unknown) => {
    if (typeof channel.id !== "string") return
    if (typeof channel.type === "number") kinds.set(channel.id, channel.type)
    if (typeof channel.parent_id === "string" && THREAD_TYPES.has(Number(channel.type))) parents.set(channel.id, channel.parent_id)
    const server = typeof channel.guild_id === "string" ? channel.guild_id : typeof guild === "string" ? guild : undefined
    if (server) guilds.set(channel.id, server)
    if (kinds.size > 4096) { const oldest = kinds.keys().next().value!; kinds.delete(oldest); parents.delete(oldest); guilds.delete(oldest) }
  }
  /** Where a channel id sits: a thread names its parent channel; an unknown channel is asked once. */
  async function place(channel: string, hint?: Json): Promise<{ chat: string; thread?: string }> {
    if (hint) remember(hint)
    if (!kinds.has(channel)) { try { remember(await api.channel(channel)) } catch { kinds.set(channel, -1) } }
    const parent = parents.get(channel)
    return parent ? { chat: parent, thread: channel } : { chat: channel }
  }
  const target = (chat: string, thread?: string) => thread ?? chat
  const text = (value: string) => value || "(empty)"

  const channelApi: ChannelApi = {
    async sendMessage(chat, body, buttons, options = {}) {
      const parts = options.markdown ? balanceFences(splitMessage(markdownForDiscord(body), MESSAGE_LIMIT)) : splitMessage(body, MESSAGE_LIMIT)
      let last: string | undefined
      for (const [index, part] of parts.entries()) {
        const sent = await api.send(target(chat, options.thread), {
          content: text(part),
          allowed_mentions: { parse: [] },
          ...(buttons && index === parts.length - 1 ? { components: discordComponents(buttons) } : {}),
        })
        last = typeof sent?.id === "string" ? sent.id : undefined
      }
      return last
    },
    async answerCallback(id, body) {
      const token = presses.get(id)
      presses.delete(id)
      if (!token || !body || !application) return
      await api.followup(application, token, { content: body.slice(0, 180), flags: 64 })
    },
    sendTyping: (chat, thread) => api.typing(target(chat, thread)),
    sendDocument: (chat, file, thread) => api.upload(target(chat, thread), file),
    downloadFile: (file, maxBytes) => api.download(file, maxBytes),
    editMessage: (chat, messageId, body, thread) => api.edit(target(chat, thread), messageId, { content: text(body.length > EDIT_LIMIT ? `${body.slice(0, EDIT_LIMIT - 1)}…` : body) }),
    async createTopic(chat, name, fromMessage) {
      if (DM_TYPES.has(kinds.get(chat) ?? -1)) throw new Error("[CHANNELS]: threads need a server channel")
      const thread = await api.thread(chat, name.replace(/\s+/g, " ").trim().slice(0, 100) || "MendCode", fromMessage)
      parents.set(thread.id, chat)
      kinds.set(thread.id, 11)
      const guild = guilds.get(chat)
      if (guild) guilds.set(thread.id, guild)
      return thread.id
    },
    topicsEnabled: async () => true,
    topicLink: (chat, thread) => { const guild = guilds.get(chat); return guild ? `https://discord.com/channels/${guild}/${thread}` : undefined },
  }

  /** A gateway dispatch as bridge updates; button presses are acknowledged here, within Discord's 3 seconds. */
  async function dispatch(type: string, data: Json): Promise<ChannelUpdate | undefined> {
    switch (type) {
      case "READY": {
        const app = data.application as Json | undefined
        if (typeof app?.id === "string") application = app.id
        return undefined
      }
      case "GUILD_CREATE":
        for (const channel of [...(Array.isArray(data.channels) ? data.channels : []), ...(Array.isArray(data.threads) ? data.threads : [])] as Json[]) remember(channel, data.id)
        return undefined
      case "CHANNEL_CREATE": case "CHANNEL_UPDATE": case "THREAD_CREATE": case "THREAD_UPDATE":
        remember(data)
        return undefined
      case "MESSAGE_CREATE": {
        const author = data.author as Json | undefined
        // Only what a person typed (a message or a reply); system messages and bots, this one included, never run.
        if (!author || author.bot === true || typeof author.id !== "string" || typeof data.channel_id !== "string") return undefined
        if (data.type !== undefined && data.type !== 0 && data.type !== 19) return undefined
        if (typeof data.guild_id === "string") guilds.set(data.channel_id, data.guild_id)
        else kinds.set(data.channel_id, 1)
        const where = await place(data.channel_id)
        if (where.thread && typeof data.guild_id === "string") guilds.set(where.chat, data.guild_id)
        const attachments = (Array.isArray(data.attachments) ? data.attachments : []) as Json[]
        const audio = (Number(data.flags ?? 0) & VOICE_MESSAGE) !== 0 ? attachments.find((file) => typeof file.url === "string") : undefined
        return {
          kind: "message",
          ...where,
          messageId: typeof data.id === "string" ? data.id : undefined,
          from: author.id,
          label: String(author.global_name ?? author.username ?? "").slice(0, 100) || undefined,
          allowed: true,
          text: typeof data.content === "string" ? data.content : undefined,
          voice: audio ? { file: String(audio.url), duration: Number(audio.duration_secs ?? 0) || undefined, size: Number(audio.size ?? 0) || undefined, mime: typeof audio.content_type === "string" ? audio.content_type : undefined } : undefined,
        }
      }
      case "INTERACTION_CREATE": {
        if (data.type !== 3 || typeof data.id !== "string" || typeof data.token !== "string" || typeof data.channel_id !== "string") return undefined
        if (typeof data.application_id === "string") application ??= data.application_id
        await api.acknowledge(data.id, data.token).catch(() => {})
        const user = ((data.member as Json | undefined)?.user ?? data.user) as Json | undefined
        if (typeof user?.id !== "string") return undefined
        presses.set(data.id, data.token)
        if (presses.size > 256) presses.delete(presses.keys().next().value!)
        const where = await place(data.channel_id, data.channel as Json | undefined)
        return { kind: "press", id: data.id, ...where, from: user.id, allowed: true, data: typeof (data.data as Json | undefined)?.custom_id === "string" ? String((data.data as Json).custom_id) : undefined }
      }
    }
    return undefined
  }

  return { api: channelApi, dispatch }
}

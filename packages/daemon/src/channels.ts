import { statSync } from "node:fs"
import path from "node:path"
import type { CommandReply } from "@mendcode/client"
import type { ChannelsChange, ChannelsReport, HistoryReport, SessionEvent, SessionId } from "@mendcode/protocol"
import type { ChannelApi, ChannelService, ChannelUpdate, ChannelWords } from "./channels-api"
import type { createChannelBridge, BridgeHost } from "./channels-bridge"
import { channelStore, createChannelsConfig, createPairing, resolveChannelToken, type ChannelsConfig } from "./channels-config"
import { createTelegramApi, telegramChannel, telegramUpdate } from "./channels-telegram"
import type { Transcription } from "./voice"

export type ChannelsHost = BridgeHost & { close(): void }
export type ChannelsOptions = {
  dir: string
  socketPath: string
  now?: () => number
  /** Hides session secrets in what leaves for the phone. */
  mask(sessionId: string, text: string): string
  /** Telegram transport; tests pass a local fake, the daemon default is the global `fetch`. */
  fetch?: typeof fetch | undefined
  env?: Record<string, string | undefined> | undefined
  log(level: "info" | "warn", message: string): void
  /** Voice-message transcription (the opt-in `voice` setting); without it a voice message gets a plain refusal. */
  transcribe?: ((input: { bytes: Uint8Array; name: string; mime: string }) => Promise<Transcription>) | undefined
  /** The daemon client the bridge acts through; defaults to a client of the daemon's own Unix socket. */
  connect?: ((onEvent: (event: SessionEvent) => void) => Promise<ChannelsHost>) | undefined
  /** Discord transport seams; tests pass a local fake REST server and gateway. */
  discord?: { fetch?: typeof fetch; base?: string; gateway?: string; WebSocket?: typeof WebSocket } | undefined
}

/** A chat service, connected: the bridge's API, the bot's name, and `listen`, which reads updates until the connection drops. */
type Connected = {
  api: ChannelApi
  name?: string | undefined
  words?: ChannelWords
  autoThread?: boolean
  label: string
  /** Calls `ready` once updates flow; settles when the connection ends (rejects to reconnect). */
  listen(onUpdate: (update: ChannelUpdate) => Promise<void>, signal: AbortSignal, ready: () => void): Promise<void>
}
type Transport = (token: string, signal: AbortSignal) => Promise<Connected>

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * Where a chat's watch subscribes: after the log's end read first (`lastSeq`), or from the start of a running turn (its `turn.started`
 * at `runningSeq`) when that is earlier, so the chat gets that turn's prompt, progress and open approvals.
 */
/** A running turn replayed to a second chat is read in pages of this many events (fewer when a page would not fit a frame). */
const REPLAY_PAGE_EVENTS = 200

type ReplayPage = { ok: true; window: { events: SessionEvent[]; lastSeq: number; more: boolean } } | { ok: false; error: { code: string; message: string } }
/**
 * Reads the log after `from` to its end, page by page, into `onEvent`: a turn replayed to a joining chat comes whole, its open
 * approval included however long it ran. A page that does not move past its cursor fails the watch instead of reporting it complete.
 */
export async function replayAfter(load: (after: number) => Promise<ReplayPage>, from: number, onEvent: (event: SessionEvent) => void): Promise<CommandReply> {
  let after = from
  for (;;) {
    const page = await load(after)
    if (!page.ok) return page as CommandReply
    for (const event of page.window.events) onEvent(event)
    if (!page.window.more) return { ok: true }
    if (page.window.lastSeq <= after) return { ok: false, error: { code: "internal", message: "[CHANNELS]: the session log did not advance while replaying" } } as CommandReply
    after = page.window.lastSeq
  }
}

export function watchCursor(lastSeq: number, runningSeq: number | undefined): number {
  return runningSeq !== undefined && runningSeq > 0 ? Math.min(lastSeq, runningSeq - 1) : lastSeq
}

/**
 * The opt-in chat bridge (docs/channels.md). Nothing starts unless `channels.json` enables Telegram and a bot token exists;
 * then the daemon long-polls the bot API outward (no listener) and relays paired chats to ordinary sessions.
 */
function telegramTransport(options: ChannelsOptions, now: () => number): Transport {
  return async (token, signal) => {
    const api = createTelegramApi({ token, ...(options.fetch ? { fetch: options.fetch } : {}) })
    const me = await api.getMe(signal)
    return {
      api: telegramChannel(api, { topics: me.has_topics_enabled === true, botName: me.username, now }),
      name: me.username,
      label: "Telegram",
      async listen(onUpdate, listening, ready) {
        // Messages sent while the daemon was off are dropped, not replayed as turns.
        const backlog = await api.getUpdates({ offset: -1, timeoutSeconds: 0, signal: listening })
        let offset = backlog.length ? backlog[backlog.length - 1]!.update_id + 1 : undefined
        ready()
        while (!listening.aborted) {
          const updates = await api.getUpdates({ ...(offset === undefined ? {} : { offset }), timeoutSeconds: 25, signal: listening })
          for (const update of updates) {
            offset = update.update_id + 1
            const placed = telegramUpdate(update)
            if (placed) await onUpdate(placed)
          }
        }
      },
    }
  }
}

function discordTransport(options: ChannelsOptions): Transport {
  return async (token) => {
    const { createDiscordApi, discordChannel, runGateway, DISCORD_WORDS } = await import("./channels-discord")
    const seams = options.discord ?? {}
    const rest = createDiscordApi({ token, ...(seams.fetch ? { fetch: seams.fetch } : {}), ...(seams.base ? { base: seams.base } : {}) })
    const me = await rest.me()
    const channel = discordChannel(rest)
    return {
      api: channel.api,
      name: me.username,
      words: DISCORD_WORDS,
      autoThread: true,
      label: "Discord",
      async listen(onUpdate, listening, ready) {
        const url = seams.gateway ?? (await rest.gateway()).url
        // Dispatches are read in order: a message is placed (its thread looked up) before the next one.
        let queue = Promise.resolve()
        await runGateway({
          url, token, signal: listening, ...(seams.WebSocket ? { WebSocket: seams.WebSocket } : {}),
          onDispatch(type, data) {
            if (type === "READY") ready()
            channel.acknowledge(type, data)
            queue =queue.then(async () => { const update = await channel.dispatch(type, data); if (update) await onUpdate(update) }).catch(() => {})
          },
        })
      },
    }
  }
}

/**
 * One chat service of the opt-in bridge (docs/channels.md). Nothing starts unless `channels.json` enables it and a bot token exists;
 * then the daemon reaches the service outward (Telegram long polling, the Discord gateway; no listener) and relays paired chats.
 */
function createChannelService(service: ChannelService, options: ChannelsOptions, config: ChannelsConfig, transport: Transport) {
  const now = options.now ?? Date.now
  const pairing = createPairing({ now })
  const store = channelStore(config, service)
  const env = options.env ?? process.env
  let controller: AbortController | undefined
  let finished: Promise<void> | undefined
  let bridge: ReturnType<typeof createChannelBridge> | undefined
  let running = false
  let botName: string | undefined
  let problem: string | undefined

  async function defaultConnect(onEvent: (event: SessionEvent) => void): Promise<ChannelsHost> {
    const { createClient } = await import("@mendcode/client")
    const client = createClient({ socketPath: options.socketPath, name: `${service}-bridge`, reconnect: true, onEvent })
    await client.connect()
    /** Sessions this client streams (one subscription per session, shared by the chats that follow it). */
    const followed = new Set<SessionId>()
    return {
      send: (command) => client.send(command),
      async watch(sessionId: SessionId): Promise<CommandReply> {
        // The log's end is read before the running turn, so a turn that starts in between is after the cursor and replays too.
        const window = await client.loadWindow(sessionId, 1)
        if (!window.ok) return window
        const last = await client.send({ type: "session.history", sessionId, limit: 1 })
        const running = last.ok ? (last.result as unknown as HistoryReport | undefined)?.turns.find((turn) => turn.outcome === "running") : undefined
        const from = watchCursor(window.window.lastSeq, running?.seq)
        if (!followed.has(sessionId)) {
          const subscribed = await client.subscribe(sessionId, from)
          if (subscribed.ok) followed.add(sessionId)
          return subscribed
        }
        // Another chat already streams it: rewinding the shared cursor would let a live event skip the replay, so the replay is read
        // from the log and handed over; the joining chat holds it with the live events and reads both in order, each once.
        return replayAfter((after) => client.loadAfter(sessionId, after, REPLAY_PAGE_EVENTS), from, onEvent)
      },
      unwatch: (sessionId) => { followed.delete(sessionId); void client.send({ type: "client.unsubscribe", sessionId }) },
      mask: options.mask,
      close: () => client.close(),
    }
  }

  const token = () => resolveChannelToken({ service, dir: options.dir, tokenFile: config.read()[service].tokenFile, env })

  async function session(signal: AbortSignal, ready: () => void) {
    let delay = 1000
    while (!signal.aborted) {
      let host: ChannelsHost | undefined
      try {
        const resolved = token()
        if (!resolved) throw new Error(`no bot token: set MENDCODE_${service.toUpperCase()}_TOKEN or create a private ${service}-token file in the data directory`)
        if ("error" in resolved) throw new Error(resolved.error)
        const connected = await transport(resolved.token, signal)
        let current: ReturnType<typeof createChannelBridge> | undefined
        host = await (options.connect ?? defaultConnect)((event) => current?.onEvent(event))
        const { createChannelBridge } = await import("./channels-bridge")
        current = bridge = createChannelBridge({
          api: connected.api, host, store, pairing, dataDir: options.dir, log: options.log, now, service: connected.label,
          ...(connected.words ? { words: connected.words } : {}), ...(connected.autoThread ? { autoThread: true } : {}),
          ...(options.transcribe ? { transcribe: options.transcribe } : {}),
        })
        await current.resume()
        const live = current
        await connected.listen((update) => live.update(update), signal, () => {
          botName = connected.name
          problem = undefined
          running = true
          delay = 1000
          ready()
        })
      } catch (error) {
        if (!signal.aborted) {
          const message = error instanceof Error ? error.message.slice(0, 300) : "channel error"
          if (message !== problem) options.log("warn", message)
          problem = message
        }
      } finally {
        running = false
        bridge?.stop()
        bridge = undefined
        host?.close()
        ready()
      }
      await sleep(delay, signal)
      delay = Math.min(delay * 2, 60_000)
    }
  }

  async function start() {
    if (controller || !config.read()[service].enabled) return
    const own = controller = new AbortController()
    let ready!: () => void
    const first = new Promise<void>((resolve) => { ready = resolve })
    finished = session(own.signal, ready).catch(() => {})
    await first
  }

  async function stop() {
    const own = controller
    controller = undefined
    own?.abort()
    await finished
    finished = undefined
  }

  function status(): ChannelsReport["telegram"] {
    const stored = config.read()[service]
    const resolved = token()
    const expiresAt = pairing.expiresAt
    const error = problem ?? (resolved && "error" in resolved ? resolved.error : undefined)
    return {
      enabled: stored.enabled,
      tokenConfigured: resolved !== undefined && "token" in resolved,
      running,
      ...(botName ? { botName } : {}),
      chats: stored.chats.map(({ sessionId: _session, topics: _topics, owner: _owner, ...chat }) => chat),
      ...(expiresAt ? { pairingExpiresAt: expiresAt } : {}),
      ...(error ? { error } : {}),
    }
  }

  async function change(request: ChannelsChange): Promise<{ code: string; expiresAt: number } | undefined> {
    if (request.action === "enable") {
      config.update((value) => { value[service].enabled = true })
      await start()
    } else if (request.action === "disable") {
      config.update((value) => { value[service].enabled = false })
      pairing.cancel()
      await stop()
    } else if (request.action === "pair") {
      if (!config.read()[service].enabled) throw new Error(`[CHANNELS]: enable the bridge first (/remote-control${service === "telegram" ? "" : ` ${service}`} on)`)
      const directory = path.resolve(request.directory)
      let exists = false
      try { exists = statSync(directory).isDirectory() } catch {}
      if (!exists) throw new Error("[CHANNELS]: the project directory does not exist")
      return pairing.create(directory, request.sessionId)
    } else if (request.action === "unpair") {
      const known = store.chats()
      const removed = request.chatId ? known.filter((chat) => chat.id === request.chatId) : known
      if (request.chatId && !removed.length) throw new Error("[CHANNELS]: no such paired chat")
      store.update((chats) => chats.filter((chat) => !removed.some((gone) => gone.id === chat.id)))
      for (const chat of removed) bridge?.forget(chat.id)
    }
    return undefined
  }

  return { start, stop, status, change, enabled: () => config.read()[service].enabled }
}

/** The opt-in chat bridges, Telegram and Discord: each idle (no network, no listener) until channels.json enables it. */
export function createChannels(options: ChannelsOptions) {
  const now = options.now ?? Date.now
  const config = createChannelsConfig(options.dir)
  const services = {
    telegram: createChannelService("telegram", options, config, telegramTransport(options, now)),
    discord: createChannelService("discord", options, config, discordTransport(options)),
  }
  const status = (): ChannelsReport => ({ telegram: services.telegram.status(), discord: services.discord.status() })
  return {
    async start() { await Promise.all([services.telegram.start(), services.discord.start()]) },
    async stop() { await Promise.all([services.telegram.stop(), services.discord.stop()]) },
    status,
    enabled: () => services.telegram.enabled() || services.discord.enabled(),
    async change(request: ChannelsChange): Promise<{ report: ChannelsReport; pairing?: { code: string; expiresAt: number } }> {
      const pairing = await services[request.channel ?? "telegram"].change(request)
      return { report: status(), ...(pairing ? { pairing } : {}) }
    },
  }
}
export type Channels = ReturnType<typeof createChannels>

import { statSync } from "node:fs"
import path from "node:path"
import type { CommandReply } from "@mendcode/client"
import type { ChannelsChange, ChannelsReport, SessionEvent, SessionId } from "@mendcode/protocol"
import { createChannelBridge, type BridgeHost } from "./channels-bridge"
import { createChannelsConfig, createPairing, resolveTelegramToken } from "./channels-config"
import { createTelegramApi } from "./channels-telegram"
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
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * The opt-in chat bridge (docs/channels.md). Nothing starts unless `channels.json` enables Telegram and a bot token exists;
 * then the daemon long-polls the bot API outward (no listener) and relays paired chats to ordinary sessions.
 */
export function createChannels(options: ChannelsOptions) {
  const now = options.now ?? Date.now
  const config = createChannelsConfig(options.dir)
  const pairing = createPairing({ now })
  const env = options.env ?? process.env
  let controller: AbortController | undefined
  let finished: Promise<void> | undefined
  let bridge: ReturnType<typeof createChannelBridge> | undefined
  let running = false
  let botName: string | undefined
  let problem: string | undefined

  async function defaultConnect(onEvent: (event: SessionEvent) => void): Promise<ChannelsHost> {
    const { createClient } = await import("@mendcode/client")
    const client = createClient({ socketPath: options.socketPath, name: "telegram-bridge", reconnect: true, onEvent })
    await client.connect()
    return {
      send: (command) => client.send(command),
      async watch(sessionId: SessionId): Promise<CommandReply> {
        const window = await client.loadWindow(sessionId, 1)
        return window.ok ? client.subscribe(sessionId, window.window.lastSeq) : window
      },
      unwatch: (sessionId) => { void client.send({ type: "client.unsubscribe", sessionId }) },
      mask: options.mask,
      close: () => client.close(),
    }
  }

  async function session(signal: AbortSignal, ready: () => void) {
    let delay = 1000
    while (!signal.aborted) {
      let host: ChannelsHost | undefined
      try {
        const resolved = resolveTelegramToken({ dir: options.dir, tokenFile: config.read().telegram.tokenFile, env })
        if (!resolved) throw new Error("no bot token: set MENDCODE_TELEGRAM_TOKEN or create a private telegram-token file in the data directory")
        if ("error" in resolved) throw new Error(resolved.error)
        const api = createTelegramApi({ token: resolved.token, ...(options.fetch ? { fetch: options.fetch } : {}) })
        const me = await api.getMe(signal)
        let current: ReturnType<typeof createChannelBridge> | undefined
        host = await (options.connect ?? defaultConnect)((event) => current?.onEvent(event))
        current = bridge = createChannelBridge({ api, host, config, pairing, dataDir: options.dir, log: options.log, ...(options.transcribe ? { transcribe: options.transcribe } : {}) })
        // Messages sent while the daemon was off are dropped, not replayed as turns.
        const backlog = await api.getUpdates({ offset: -1, timeoutSeconds: 0, signal })
        let offset = backlog.length ? backlog[backlog.length - 1]!.update_id + 1 : undefined
        botName = me.username
        problem = undefined
        running = true
        delay = 1000
        ready()
        while (!signal.aborted) {
          const updates = await api.getUpdates({ ...(offset === undefined ? {} : { offset }), timeoutSeconds: 25, signal })
          for (const update of updates) {
            offset = update.update_id + 1
            await current.update(update)
          }
        }
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
    if (controller || !config.read().telegram.enabled) return
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

  function status(): ChannelsReport {
    const stored = config.read().telegram
    const token = resolveTelegramToken({ dir: options.dir, tokenFile: stored.tokenFile, env })
    const expiresAt = pairing.expiresAt
    const error = problem ?? (token && "error" in token ? token.error : undefined)
    return {
      telegram: {
        enabled: stored.enabled,
        tokenConfigured: token !== undefined && "token" in token,
        running,
        ...(botName ? { botName } : {}),
        chats: stored.chats.map(({ sessionId: _session, ...chat }) => chat),
        ...(expiresAt ? { pairingExpiresAt: expiresAt } : {}),
        ...(error ? { error } : {}),
      },
    }
  }

  async function change(request: ChannelsChange): Promise<{ report: ChannelsReport; pairing?: { code: string; expiresAt: number } }> {
    if (request.action === "enable") {
      config.update((value) => { value.telegram.enabled = true })
      await start()
    } else if (request.action === "disable") {
      config.update((value) => { value.telegram.enabled = false })
      pairing.cancel()
      await stop()
    } else if (request.action === "pair") {
      if (!config.read().telegram.enabled) throw new Error("[CHANNELS]: enable the bridge first (/remote-control on)")
      const directory = path.resolve(request.directory)
      let exists = false
      try { exists = statSync(directory).isDirectory() } catch {}
      if (!exists) throw new Error("[CHANNELS]: the project directory does not exist")
      return { report: status(), pairing: pairing.create(directory) }
    } else if (request.action === "unpair") {
      const known = config.read().telegram.chats
      const removed = request.chatId ? known.filter((chat) => chat.id === request.chatId) : known
      if (request.chatId && !removed.length) throw new Error("[CHANNELS]: no such paired chat")
      config.update((value) => { value.telegram.chats = value.telegram.chats.filter((chat) => !removed.some((gone) => gone.id === chat.id)) })
      for (const chat of removed) bridge?.forget(chat.id)
    }
    return { report: status() }
  }

  return { start, stop, status, change }
}
export type Channels = ReturnType<typeof createChannels>

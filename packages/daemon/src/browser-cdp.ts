import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string }

/** A DevTools Protocol connection to one browser process. Tests supply a fake with the same shape. */
export type CdpConnection = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string, signal?: AbortSignal): Promise<Record<string, unknown>>
  onEvent(listener: (event: CdpEvent) => void): () => void
  /** Resolves when the connection ends (the browser exited or `close` ran). */
  closed: Promise<void>
  close(): void
}

export type BrowserProcess = { connection: CdpConnection; kill(): Promise<void> }

/** Starts a browser and connects to it; the real one launches Chromium, tests inject a fake. */
export type BrowserDriver = { launch(signal: AbortSignal): Promise<BrowserProcess> }

const COMMAND_TIMEOUT_MS = 30_000
const LAUNCH_TIMEOUT_MS = 20_000

/** Wraps a WebSocket speaking the DevTools protocol: ids, replies, events. */
export function connectCdp(socket: WebSocket, commandTimeoutMs = COMMAND_TIMEOUT_MS): CdpConnection {
  let counter = 0
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const listeners = new Set<(event: CdpEvent) => void>()
  let ended = false
  let finish!: () => void
  const closed = new Promise<void>((resolve) => { finish = resolve })
  const end = (reason: string) => {
    if (ended) return
    ended = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
    listeners.clear()
    finish()
  }
  socket.addEventListener("message", (message) => {
    let data: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      data = JSON.parse(String(message.data))
    } catch {
      return
    }
    if (typeof data.id === "number") {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      clearTimeout(entry.timer)
      if (data.error) entry.reject(new Error(data.error.message ?? "browser command failed"))
      else entry.resolve(data.result ?? {})
      return
    }
    if (typeof data.method === "string") for (const listener of [...listeners]) listener({ method: data.method, params: data.params ?? {}, ...(data.sessionId ? { sessionId: data.sessionId } : {}) })
  })
  socket.addEventListener("close", () => end("the browser closed"))
  socket.addEventListener("error", () => end("the browser connection failed"))
  return {
    send(method, params = {}, sessionId, signal) {
      if (ended || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("the browser closed"))
      if (signal?.aborted) return Promise.reject(new Error("cancelled"))
      const id = ++counter
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`browser command ${method} timed out`))
        }, commandTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        signal?.addEventListener("abort", () => {
          if (!pending.delete(id)) return
          clearTimeout(timer)
          reject(new Error("cancelled"))
        }, { once: true })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    closed,
    close() {
      try { socket.close() } catch {}
      end("the browser closed")
    },
  }
}

const MAC_APPS = ["Google Chrome", "Google Chrome Beta", "Chromium", "Microsoft Edge", "Brave Browser"]
const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]

/** The Chromium-family executable to launch: an explicit path first, then the usual install locations. */
export function findBrowserExecutable(options: { explicit?: string | undefined; platform?: string; exists?: (file: string) => boolean; which?: (name: string) => string | null } = {}): string | undefined {
  const exists = options.exists ?? existsSync
  const which = options.which ?? ((name: string) => Bun.which(name))
  if (options.explicit) return exists(options.explicit) ? options.explicit : undefined
  const platform = options.platform ?? process.platform
  if (platform === "darwin") {
    for (const app of MAC_APPS) {
      for (const root of ["/Applications", path.join(homedir(), "Applications")]) {
        const candidate = path.join(root, `${app}.app`, "Contents", "MacOS", app)
        if (exists(candidate)) return candidate
      }
    }
  }
  for (const name of PATH_NAMES) {
    const found = which(name)
    if (found) return found
  }
  return undefined
}

export function browserLaunchArgs(input: { profile: string; root: boolean }): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${input.profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--mute-audio",
    "--hide-scrollbars",
    "--window-size=1280,800",
    // Chromium refuses to start as root with its sandbox; only then is it turned off.
    ...(input.root ? ["--no-sandbox"] : []),
    "about:blank",
  ]
}

/** Launches headless Chromium with a throwaway profile on a loopback debugging port and connects to it. */
export function chromiumDriver(options: { executable: string; tmp?: string }): BrowserDriver {
  return {
    async launch(signal) {
      const profile = await mkdtemp(path.join(options.tmp ?? tmpdir(), "mendcode-browser-"))
      const root = typeof process.getuid === "function" && process.getuid() === 0
      const child = Bun.spawn([options.executable, ...browserLaunchArgs({ profile, root })], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      let exited = false
      void child.exited.then(() => { exited = true })
      const cleanup = async () => {
        try { child.kill() } catch {}
        await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
        await rm(profile, { recursive: true, force: true }).catch(() => {})
      }
      try {
        const deadline = Date.now() + LAUNCH_TIMEOUT_MS
        let endpoint: string | undefined
        while (!endpoint) {
          signal.throwIfAborted()
          if (exited) throw new Error("the browser exited during startup")
          if (Date.now() > deadline) throw new Error("the browser did not start in time")
          const text = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "")
          const [port, socketPath] = text.split("\n")
          if (port && socketPath && /^\d+$/.test(port.trim())) endpoint = `ws://127.0.0.1:${port.trim()}${socketPath.trim()}`
          else await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const socket = new WebSocket(endpoint)
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true })
          socket.addEventListener("error", () => reject(new Error("could not connect to the browser")), { once: true })
        })
        const connection = connectCdp(socket)
        void child.exited.then(() => connection.close())
        return {
          connection,
          async kill() {
            connection.close()
            await cleanup()
          },
        }
      } catch (error) {
        await cleanup()
        throw error
      }
    },
  }
}

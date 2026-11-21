import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { ComputerCaptureInput, ComputerKeyInput, ComputerObserveInput, type ComputerCaptureMetadata, type ComputerObserveReport, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { fail, runCommand, type ComputerPort, type CommandRunner, type ToolResult } from "@mendcode/tools"
import { createMacAccessibility, type ComputerAccessibility } from "./computer-accessibility"
import { createComputerSessions } from "./computer-sessions"
import { createNativeComputer } from "./computer-native"

const KEY_CODES = { tab: 48, escape: 53, enter: 36, space: 49, left: 123, right: 124, down: 125, up: 126 } as const
const FRONTMOST = 'tell application "System Events" to get unix id of first application process whose frontmost is true'
const KEY_SCRIPT = `on run argv
  tell application "System Events"
    set targetID to (item 1 of argv) as integer
    set currentID to unix id of first application process whose frontmost is true
    if currentID is not targetID then error "Foreground application changed; capture again"
    tell first application process whose unix id is targetID
      key code ((item 2 of argv) as integer)
    end tell
  end tell
end run`
const COORDINATES = "Preview pixels; do not assume these match desktop control coordinates." as const
const PNG = [137, 80, 78, 71, 13, 10, 26, 10]
/** In-memory authority maps hold at most this many entries. */
const LIMIT = 64
/** Captures kept on disk per chat; older ones are deleted as new ones arrive. */
export const KEEP = 32
/** Longest edge of a preview, in pixels: well inside the model's image limits and far fewer tokens than a full Retina frame. */
const PREVIEW = 1280
const TTL = 30_000
const MAX_BYTES = 5 * 1024 * 1024

export type ComputerOptions = { /** Read at every call, so `/tier computer on` applies without a restart. */ enabled?: boolean | (() => boolean); platform?: string; run?: CommandRunner; now?: () => number; accessibility?: ComputerAccessibility }

function size(bytes: Uint8Array) {
  if (bytes.length < 24 || PNG.some((value, index) => bytes[index] !== value)) throw new Error("Capture did not produce a bounded PNG")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16), height = view.getUint32(20)
  if (!width || !height) throw new Error("Capture did not produce a bounded PNG")
  return { width, height }
}

/** Native state stays in the daemon, separate from conversation history and never persisted as keyboard authority. */
export function createComputerControl(store: Store, dir: string, options: ComputerOptions = {}) {
  const run = options.run ?? runCommand
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const captures = new Map<string, { sessionId: SessionId; pid: number; at: number }>()
  const lineage = new Map<string, { sessionId: SessionId; sha256: string }>()
  const busy = new Set<SessionId>()
  const stopping = new AbortController()
  function available(sessionId: SessionId, signal: AbortSignal) {
    signal.throwIfAborted()
    stopping.signal.throwIfAborted()
    if ((typeof options.enabled === "function" ? options.enabled() : options.enabled) !== true) throw new Error("Computer capture and keyboard control are off; switch them on with /tier computer on (or MENDCODE_COMPUTER=1 when the daemon starts)")
    if (!store.hasSession(sessionId)) throw new Error("Unknown session")
    if (platform !== "darwin") throw new Error("Native computer capture and keyboard control are available on macOS only")
  }
  function trim<T>(map: Map<string, T>) {
    while (map.size >= LIMIT) map.delete(map.keys().next().value!)
  }
  async function command(args: string[], signal: AbortSignal) {
    signal.throwIfAborted()
    const result = await run(args, signal)
    signal.throwIfAborted()
    if (result.code !== 0) throw new Error(result.stderr.includes("Foreground application changed") ? "Foreground application changed; capture again. No key was pressed." : "Native computer operation failed. Screen Recording belongs to the terminal that started MendCode; Accessibility belongs to \"MendCode Computer Use\".")
    return result.stdout.trim()
  }
  async function processID(signal: AbortSignal) {
    const value = await command(["/usr/bin/osascript", "-e", FRONTMOST], signal).catch(() => "")
    const pid = /^\d+$/.test(value) ? Number(value) : 0
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }
  const accessibility = options.accessibility ?? (options.run ? createMacAccessibility(run) : createNativeComputer(dir))
  const semantic = createComputerSessions(accessibility, now, available, stopping.signal, (id) => captures.delete(id))
  /** Set by the first capture that worked: only then may a poor tree bring a screenshot of its own (no permission is asked unasked). */
  let captureWorked = false
  /**
   * A chat keeps its most recent captures: before a new one is written, the oldest beyond KEEP are deleted with whatever authority
   * they still carried (a key, a session start), so a long task never stops at a cap.
   */
  async function evict(directory: string) {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".png"))
    if (names.length < KEEP) return
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(directory, name)).catch(() => undefined))?.mtimeMs ?? 0 })))
    dated.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    for (const { name } of dated.slice(0, dated.length - (KEEP - 1))) {
      await rm(path.join(directory, name), { force: true })
      const id = name.slice(0, -".png".length)
      captures.delete(id); lineage.delete(id); semantic.consume(id)
    }
  }
  return {
    port(sessionId: SessionId): ComputerPort {
      const base = semantic.port(sessionId)
      const port: ComputerPort = {
        ...base,
        /**
         * The accessibility tree first; a screenshot of just the observed window when asked for, or when the tree is poor (a webview
         * or custom-drawn content) and a capture already worked here, so no permission is ever asked for without a request.
         */
        async observe(raw, abort): Promise<ToolResult> {
          const observed = await base.observe(raw, abort)
          if (observed.isError) return observed
          const input = ComputerObserveInput.parse(raw)
          const window = semantic.observedWindow(input.computerSessionID, sessionId)
          if (!window?.bounds || !(input.screenshot === true || window.poor && captureWorked)) return observed
          const { x, y, width, height } = window.bounds
          const shot = await port.capture({ region: { x: Math.floor(x), y: Math.floor(y), width: Math.min(16384, Math.max(1, Math.ceil(width))), height: Math.min(16384, Math.max(1, Math.ceil(height))) } }, abort)
          const report = JSON.parse(observed.output) as ComputerObserveReport
          if (shot.isError) return input.screenshot ? { ...observed, output: JSON.stringify({ ...report, screenshotFallback: `The window screenshot failed: ${shot.output}` }) } : observed
          const { captureID, width: shotWidth, height: shotHeight, filePath, coordinates } = JSON.parse(shot.output) as ComputerCaptureMetadata
          const { screenshotFallback: _fallback, ...rest } = report
          return { ...observed, output: JSON.stringify({ ...rest, screenshot: { captureID, width: shotWidth, height: shotHeight, filePath, region: "the observed window", coordinates } }), ...(shot.images ? { images: shot.images } : {}) }
        },
        async capture(raw, abort): Promise<ToolResult> {
          const title = "Computer screenshot"
          const signal = AbortSignal.any([abort, stopping.signal])
          let reserved = false
          try {
            available(sessionId, signal)
            semantic.captureSafe()
            const input = ComputerCaptureInput.parse(raw)
            if (busy.has(sessionId)) throw new Error("Another capture is running in this session")
            semantic.beginCapture()
            busy.add(sessionId)
            reserved = true
            const directory = path.join(dir, "computer", sessionId)
            await mkdir(directory, { recursive: true, mode: 0o700 })
            await evict(directory)
            let pid: number | undefined
            let target: import("@mendcode/protocol").ComputerTarget | undefined
            if (!input.region && input.windowID == null) {
              const displays = await command(["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"], signal).catch(() => "{}")
              try {
                const gpus = JSON.parse(displays).SPDisplaysDataType
                const count = Array.isArray(gpus) ? gpus.reduce((sum: number, gpu: { spdisplays_ndrvs?: unknown[] }) => sum + (Array.isArray(gpu.spdisplays_ndrvs) ? gpu.spdisplays_ndrvs.length : 0), 0) : 0
                if (count === 1) pid = await processID(signal)
              } catch { /* Unknown display topology cannot authorize a key. */ }
            }
            if (pid !== undefined) {
              target = await accessibility.foreground(signal).catch(() => undefined)
              if (target?.pid !== pid) target = undefined
            }
            const captureID = randomUUID()
            const filePath = path.join(directory, `${captureID}.png`)
            await writeFile(filePath, new Uint8Array(), { flag: "wx", mode: 0o600 })
            const shot = ["/usr/sbin/screencapture", "-x", "-t", "png", ...(input.region ? ["-R", `${input.region.x},${input.region.y},${input.region.width},${input.region.height}`] : input.windowID != null ? ["-l", String(input.windowID)] : ["-m"]), filePath]
            // An unknown window ID fails the same way as a missing permission; say which input to change before blaming the permission.
            if (input.windowID != null) await command(shot, signal).catch((error) => { throw signal.aborted ? error : new Error(`No on-screen window has the macOS window ID ${input.windowID} (a ComputerSession windowID is not one), or Screen Recording permission is missing for the terminal that started MendCode (not for "MendCode Computer Use"). Capture the main display with no arguments, or a region such as an observed window's bounds.`) })
            else await command(shot, signal)
            await chmod(filePath, 0o600)
            let bytes = await readFile(filePath)
            const original = size(bytes)
            const resized = Math.max(original.width, original.height) > PREVIEW
            if (resized) {
              // sips runs as its own process: encoding never holds the daemon's thread.
              await command(["/usr/bin/sips", "-Z", String(PREVIEW), filePath], signal)
              bytes = await readFile(filePath)
              await chmod(filePath, 0o600)
            }
            const dimensions = size(bytes)
            if (bytes.length > MAX_BYTES || Math.max(dimensions.width, dimensions.height) > PREVIEW) throw new Error("Capture did not produce a bounded PNG; capture a smaller region")
            if (pid !== undefined && pid !== await processID(signal)) pid = undefined
            if (target && pid !== undefined) {
              const after = await accessibility.foreground(signal).catch(() => undefined)
              if (!after || after.pid !== target.pid || after.bundleID !== target.bundleID) target = undefined
            } else target = undefined
            available(sessionId, signal)
            semantic.captureSafe()
            const sha256 = createHash("sha256").update(bytes).digest("hex")
            const unchangedFrom = [...lineage].reverse().find(([, previous]) => previous.sessionId === sessionId && previous.sha256 === sha256)?.[0]
            const capturedAt = now()
            const metadata: ComputerCaptureMetadata = { captureID, filePath, ...dimensions, sha256, capturedAt, resized, keyboardControlAvailable: pid !== undefined, computerSessionBootstrapAvailable: target !== undefined, coordinates: COORDINATES, ...(unchangedFrom ? { unchangedFrom } : {}) }
            if (target) semantic.register(captureID, sessionId, target, capturedAt)
            for (const [id, capture] of captures) if (now() - capture.at > TTL || !store.hasSession(capture.sessionId)) captures.delete(id)
            if (pid !== undefined) {
              trim(captures)
              captures.set(captureID, { sessionId, pid, at: capturedAt })
            }
            trim(lineage)
            lineage.set(captureID, { sessionId, sha256 })
            captureWorked = true
            const { unchangedFrom: previous, computerSessionBootstrapAvailable, ...facts } = metadata
            return { title, output: JSON.stringify(metadata), meta: { ...facts, computerSessionBootstrapAvailable: computerSessionBootstrapAvailable === true, ...(previous ? { unchangedFrom: previous } : {}) }, truncated: false, isError: false, images: [{ mime: "image/png", bytes }] }
          } catch (error) {
            return fail({ title, message: signal.aborted ? "cancelled" : error instanceof Error ? error.message : "Computer capture failed" })
          } finally { if (reserved) { busy.delete(sessionId); semantic.endCapture() } }
        },
        async key(raw, abort): Promise<ToolResult> {
          const title = "Computer key"
          const signal = AbortSignal.any([abort, stopping.signal])
          try {
            available(sessionId, signal)
            const input = ComputerKeyInput.parse(raw)
            const capture = captures.get(input.captureID)
            if (!capture || capture.sessionId !== sessionId || now() < capture.at || now() - capture.at > TTL) throw new Error("Capture is missing or stale. Take a new screenshot before controlling the app.")
            // Consume before awaiting: concurrent approved keys cannot reuse the same observation.
            captures.delete(input.captureID)
            semantic.consume(input.captureID)
            await semantic.inputLease(signal, async () => {
              if (accessibility.navigation) await accessibility.indicator(signal, () => accessibility.navigation!(capture.pid, input.key, signal))
              else await command(["/usr/bin/osascript", "-e", KEY_SCRIPT, String(capture.pid), String(KEY_CODES[input.key])], signal)
            })
            return { title, output: JSON.stringify({ captureID: input.captureID, key: input.key, pressed: true }), meta: { captureID: input.captureID, key: input.key }, truncated: false, isError: false }
          } catch (error) {
            return fail({ title, message: signal.aborted ? "cancelled" : error instanceof Error ? error.message : "Computer key failed" })
          }
        },
      }
      return port
    },
    stop() { stopping.abort(); semantic.stop(); captures.clear(); lineage.clear() },
  }
}

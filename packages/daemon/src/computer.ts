import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ComputerCaptureInput, ComputerKeyInput, type ComputerCaptureMetadata, type SessionId } from "@mendcode/protocol"
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
const LIMIT = 64
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
    if (result.code !== 0) throw new Error(result.stderr.includes("Foreground application changed") ? "Foreground application changed; capture again. No key was pressed." : "Native computer operation failed. Check Screen Recording or Accessibility permission for the terminal running MendCode.")
    return result.stdout.trim()
  }
  async function processID(signal: AbortSignal) {
    const value = await command(["/usr/bin/osascript", "-e", FRONTMOST], signal).catch(() => "")
    const pid = /^\d+$/.test(value) ? Number(value) : 0
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }
  const accessibility = options.accessibility ?? (options.run ? createMacAccessibility(run) : createNativeComputer(dir))
  const semantic = createComputerSessions(accessibility, now, available, stopping.signal, (id) => captures.delete(id))
  return {
    port(sessionId: SessionId): ComputerPort {
      return {
        ...semantic.port(sessionId),
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
            if ((await readdir(directory)).filter((name) => name.endsWith(".png")).length >= LIMIT) throw new Error("This session reached its 64 screenshot artifact limit. Archive its cached captures before continuing.")
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
            if (input.windowID != null) await command(shot, signal).catch((error) => { throw signal.aborted ? error : new Error(`No on-screen window has the macOS window ID ${input.windowID} (a ComputerSession windowID is not one), or Screen Recording permission is missing for the terminal running MendCode. Capture the main display with no arguments, or a region such as an observed window's bounds.`) })
            else await command(shot, signal)
            await chmod(filePath, 0o600)
            let bytes = await readFile(filePath)
            const original = size(bytes)
            const resized = Math.max(original.width, original.height) > 1600
            if (resized) {
              await command(["/usr/bin/sips", "-Z", "1600", filePath], signal)
              bytes = await readFile(filePath)
              await chmod(filePath, 0o600)
            }
            const dimensions = size(bytes)
            if (bytes.length > MAX_BYTES || Math.max(dimensions.width, dimensions.height) > 1600) throw new Error("Capture did not produce a bounded PNG; capture a smaller region")
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
    },
    stop() { stopping.abort(); semantic.stop(); captures.clear(); lineage.clear() },
  }
}

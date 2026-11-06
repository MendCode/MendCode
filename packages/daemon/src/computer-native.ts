import { z } from "zod"
import { ComputerTarget, ComputerNode, type ComputerApp, type ComputerWindow } from "@mendcode/protocol"
import { identified, NotDelivered, type ComputerAccessibility } from "./computer-accessibility"
import { computerOutput } from "@mendcode/tools"
import { APP_NAME, ensureApp, launchApp, type Link } from "./computer-app"

class NativeRejected extends Error {}
/** Nothing was sent to any app: Accessibility is off for the app. */
class PermissionMissing extends NotDelivered {}
const Reply = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: z.unknown() }), z.strictObject({ ok: z.literal(false), error: z.string().max(4096), delivery: z.enum(["not_delivered", "unknown"]).optional(), code: z.string().max(32).optional() })])
const Outcome = z.strictObject({ index: z.number().int().min(0).max(15), outcome: z.enum(["dispatched", "failed", "unknown"]), error: z.string().max(4096).optional() })
const App = z.strictObject({ bundleID: z.string().min(1).max(256), appName: z.string().max(256), pid: z.number().int().positive() })
const Window = z.strictObject({ id: z.string().min(1).max(128), name: z.string().max(256), bounds: ComputerNode.shape.bounds })

export type NativeOptions = {
  /** An existing helper executable (tests): the app is not built. */
  executable?: string
  /** How an executable is started and connected; by default the app is opened through LaunchServices, as its own responsible process. */
  launch?: (executable: string, signal: AbortSignal) => Promise<Link>
  /** How long a tool waits for the Accessibility grant and how often it looks (2 minutes, every second). */
  permissionWait?: { timeoutMs?: number; intervalMs?: number }
}

/** Lazily built, private persistent AX broker. An aborted/unknown call is never replayed. */
export function createNativeComputer(dir: string, options: NativeOptions = {}): ComputerAccessibility {
  let child: Link | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let buffer = "", stopped = false
  let queue: Promise<unknown> = Promise.resolve()
  let executable: string | undefined
  /** The exit of the helper that was last disconnected: it holds the input lease until then. */
  let leaving: Promise<void> = Promise.resolve()
  const shutdown = new AbortController()
  function disconnect() {
    const previous = child
    child = undefined
    void reader?.cancel().catch(() => {})
    reader = undefined
    buffer = ""
    if (previous) {
      // A helper that waits for its next request sits in a blocking read that a signal does not end: only the end of its input
      // makes it hide the cursor and release the input lease at once (measured without it: both stayed for the 2 s below).
      previous.end()
      previous.kill("SIGTERM")
      // Let a bounded drag release its button before forcibly ending a stuck AX call.
      const timer = setTimeout(() => { if (previous.alive()) previous.kill("SIGKILL") }, 2000)
      timer.unref()
      leaving = previous.exited.then(() => {}, () => {}).finally(() => clearTimeout(timer))
    }
  }
  async function start(signal: AbortSignal) {
    signal.throwIfAborted()
    if (stopped) throw new Error("Native computer driver is stopped")
    if (child && child.alive()) return
    disconnect()
    if (!executable) executable = options.executable ?? await ensureApp(dir, signal)
    // A new helper cannot take the input lease while the previous one still holds it (bounded by its forced end).
    await leaving
    signal.throwIfAborted()
    child = await (options.launch ? options.launch(executable, signal) : launchApp(executable, dir, signal))
    signal.throwIfAborted()
    reader = child.reader
  }
  /**
   * A request the app refused only because Accessibility is off (the app has opened System Settings): wait for the grant, then make the
   * same request once more, so the tool that asked does not fail and nobody repeats anything. Cancelling the tool ends the wait.
   */
  async function request(method: string, args: Record<string, unknown>, abort: AbortSignal): Promise<unknown> {
    try { return await exchange(method, args, abort) }
    catch (error) {
      if (!(error instanceof PermissionMissing)) throw error
      await grant(error, abort)
      return exchange(method, args, abort)
    }
  }
  async function grant(missing: PermissionMissing, abort: AbortSignal) {
    const wait = { timeoutMs: 120_000, intervalMs: 1000, ...options.permissionWait }
    computerOutput.getStore()?.("Waiting for Accessibility permission… (System Settings is open)\n")
    const until = Date.now() + wait.timeoutMs
    while (Date.now() < until) {
      abort.throwIfAborted()
      await Bun.sleep(wait.intervalMs)
      abort.throwIfAborted()
      const state = z.object({ trusted: z.boolean() }).safeParse(await exchange("ping", {}, abort).catch(() => undefined))
      if (state.success && state.data.trusted) return
    }
    throw new NotDelivered(`${missing.message} It was not turned on within ${Math.round(wait.timeoutMs / 1000)} seconds: turn on "${APP_NAME}" in System Settings > Privacy & Security > Accessibility, then try again.`)
  }
  async function exchange(method: string, args: Record<string, unknown>, abort: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([abort, shutdown.signal, AbortSignal.timeout(executable ? 30_000 : 90_000)])
    const operation = queue.then(async () => {
      signal.throwIfAborted()
      await start(signal)
      signal.throwIfAborted()
      const process = child!, stream = reader!
      let rejectAbort: (() => void) | undefined
      const interrupted = new Promise<never>((_, reject) => {
        rejectAbort = () => { disconnect(); reject(new Error("Native operation cancelled or timed out; effects may be partial. Observe before retrying.")) }
        signal.addEventListener("abort", rejectAbort, { once: true })
        if (signal.aborted) rejectAbort()
      })
      try {
        await Promise.race([process.write(JSON.stringify({ method, ...args }) + "\n"), interrupted])
        const decoder = new TextDecoder()
        while (!buffer.includes("\n")) {
          const chunk = await Promise.race([stream.read(), interrupted])
          if (chunk.done) throw new Error("Native computer helper exited; effects are unknown. Start from a fresh observation.")
          buffer += decoder.decode(chunk.value, { stream: true })
          if (Buffer.byteLength(buffer) > 131_072) throw new Error("Native computer output exceeded its limit")
        }
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const reply = Reply.parse(JSON.parse(line))
        if (!reply.ok && reply.code === "accessibility" && reply.delivery === "not_delivered") throw new PermissionMissing(reply.error)
        if (!reply.ok) throw reply.delivery === "not_delivered" ? new NotDelivered(reply.error) : new NativeRejected(reply.error)
        return reply.value
      } catch (error) {
        if (!(error instanceof NativeRejected) && !(error instanceof NotDelivered)) disconnect()
        throw error
      } finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort) }
    })
    queue = operation.catch(() => {})
    return operation
  }
  return {
    async foreground(signal) { return ComputerTarget.parse(await request("foreground", {}, signal)) },
    async identify(target, signal) { return identified(target, await request("identify", { target }, signal)) },
    async apps(signal): Promise<ComputerApp[]> { return z.array(App).max(128).parse(await request("apps", {}, signal)) },
    async resolve(bundleID, signal) {
      // PID zero is approval-only metadata for an installed, not-yet-running app.
      return ComputerTarget.extend({ pid: z.number().int().nonnegative() }).parse(await request("resolve", { bundleID }, signal))
    },
    async activate(target, signal) { return ComputerTarget.parse(await request("activate", { target }, signal)) },
    async windows(target, signal): Promise<ComputerWindow[]> { return z.array(Window).max(64).parse(await request("windows", { target }, signal)) },
    async selectWindow(target, windowID, signal) { return ComputerTarget.parse(await request("selectWindow", { target, windowID }, signal)) },
    async observe(target, signal) {
      return z.strictObject({ nodes: z.array(ComputerNode).max(500), truncated: z.boolean() }).parse(await request("observe", { target }, signal))
    },
    async action(target, input, signal) { await request("action", { target, input }, signal) },
    async batch(target, steps, signal) { return z.array(Outcome).max(16).parse(await request("batch", { target, steps }, signal)) },
    async navigation(pid, key, signal) { await request("navigation", { pid, key }, signal) },
    async program(target, signal, execute) {
      await request("program", { target, active: true }, signal)
      try { return await execute() }
      finally {
        if (signal.aborted || stopped) disconnect()
        else await request("program", { active: false }, signal).catch(() => disconnect())
      }
    },
    async indicator(signal, action) {
      const ready = await request("indicator", { visible: true }, signal) as { visible?: boolean }
      if (!ready.visible) {
        await request("indicator", { visible: false }, signal).catch(() => disconnect())
        throw new Error("Native control indicator did not become visible")
      }
      try { signal.throwIfAborted(); await action() }
      finally {
        if (signal.aborted || stopped) disconnect()
        else await request("indicator", { visible: false }, signal).catch(() => disconnect())
      }
    },
    release(target) { if (!child || stopped) return; void request("release", { target }, shutdown.signal).catch(() => {}) },
    stop() { stopped = true; shutdown.abort(); disconnect() },
  }
}

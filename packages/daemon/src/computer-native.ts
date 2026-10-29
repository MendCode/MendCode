import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ComputerTarget, ComputerNode, type ComputerApp, type ComputerWindow } from "@mendcode/protocol"
import { runManaged } from "@mendcode/tools"
import sourceFile from "../assets/computer.swift" with { type: "file" }
import { identified, type ComputerAccessibility } from "./computer-accessibility"

class NativeRejected extends Error {}
const Reply = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: z.unknown() }), z.strictObject({ ok: z.literal(false), error: z.string().max(4096) })])
const App = z.strictObject({ bundleID: z.string().min(1).max(256), appName: z.string().max(256), pid: z.number().int().positive() })
const Window = z.strictObject({ id: z.string().min(1).max(128), name: z.string().max(256), bounds: ComputerNode.shape.bounds })

/** Lazily compiled, private persistent AX broker. An aborted/unknown call is never replayed. */
export function createNativeComputer(dir: string): ComputerAccessibility {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined
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
      try { void Promise.resolve(previous.stdin.end()).catch(() => {}) } catch { /* already closed */ }
      previous.kill("SIGTERM")
      // Let a bounded drag release its button before forcibly ending a stuck AX call.
      const timer = setTimeout(() => { if (previous.exitCode === null) previous.kill("SIGKILL") }, 2000)
      timer.unref()
      leaving = previous.exited.then(() => {}, () => {}).finally(() => clearTimeout(timer))
    }
  }
  async function start(signal: AbortSignal) {
    signal.throwIfAborted()
    if (stopped) throw new Error("Native computer driver is stopped")
    if (child && child.exitCode === null) return
    disconnect()
    if (!executable) {
      const source = await Bun.file(sourceFile).text()
      const hash = createHash("sha256").update(source).update(process.arch).digest("hex").slice(0, 20)
      const folder = path.join(dir, "computer-native", hash)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await chmod(folder, 0o700)
      const binary = path.join(folder, "mendcode-computer")
      if (!await Bun.file(binary).exists()) {
        const temporary = path.join(folder, randomUUID())
        const swift = `${temporary}.swift`
        try {
          await Bun.write(swift, source)
          await chmod(swift, 0o600)
          const compiled = await runManaged({ argv: ["/usr/bin/xcrun", "swiftc", "-O", swift, "-o", temporary], cwd: folder, env: process.env, timeoutMs: 60_000, signal })
          if (compiled.cancelled) throw new Error("Native helper compilation was cancelled; no computer input was sent")
          if (compiled.timedOut) throw new Error("Native helper compilation exceeded 60 seconds; no computer input was sent")
          if (compiled.exitCode !== 0) throw new Error("Swift helper compilation failed. Check Apple's Command Line Tools (xcode-select --install if missing): " + compiled.output.slice(0, 1000))
          signal.throwIfAborted()
          await chmod(temporary, 0o700)
          await rename(temporary, binary)
        } finally { await rm(swift, { force: true }); await rm(temporary, { force: true }) }
      }
      executable = binary
    }
    // A new helper cannot take the input lease while the previous one still holds it (bounded by its forced end).
    await leaving
    signal.throwIfAborted()
    child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    reader = child.stdout.getReader()
  }
  async function request(method: string, args: Record<string, unknown>, abort: AbortSignal): Promise<unknown> {
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
        await Promise.race([(async () => { process.stdin.write(JSON.stringify({ method, ...args }) + "\n"); await process.stdin.flush() })(), interrupted])
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
        if (!reply.ok) throw new NativeRejected(reply.error)
        return reply.value
      } catch (error) {
        if (!(error instanceof NativeRejected)) disconnect()
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

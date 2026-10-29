import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { release as osRelease } from "node:os"
import path from "node:path"
import { runManaged } from "@mendcode/tools"
import sourceFile from "../assets/dictate.swift" with { type: "file" }

/** What the on-device helper reports while it listens. */
export type LocalLive = { level?: number; text?: string }
export type LocalSession = { stop(): Promise<string>; kill(): void }
/** On-device dictation: `available()` says why not when it cannot run here. Tests supply a fake. */
export type LocalDictation = { available(): string | undefined; start(input: { language?: string | undefined; live(update: LocalLive): void }): Promise<LocalSession> }

const COMPILE_MS = 120_000
/** The first use of a language may download its speech model (macOS does it); the helper says so and is waited on longer. */
const READY_MS = 15_000
const INSTALL_MS = 180_000
const FINAL_MS = 10_000
const MAX_LINE = 64 * 1024

/**
 * Apple's on-device speech recognition (macOS 26+): a small Swift helper, compiled once with the Command Line Tools into
 * `<dir>/voice/local/<hash>`, opens the microphone and streams levels and the running transcript as JSON lines. Free, no key,
 * and no audio leaves the machine.
 */
export function createLocalDictation(options: { dir: string; platform?: NodeJS.Platform; release?: string }): LocalDictation {
  const platform = options.platform ?? process.platform
  let executable: string | undefined
  let compiling: Promise<string> | undefined

  function available() {
    if (platform !== "darwin") return "on-device dictation needs macOS"
    const major = Number((options.release ?? osRelease()).split(".")[0])
    // Darwin 25 is macOS 26, the first with SpeechAnalyzer.
    if (!(major >= 25)) return "on-device dictation needs macOS 26 or later"
    if (!executable && !existsSync("/usr/bin/xcrun")) return "on-device dictation needs Apple's Command Line Tools (xcode-select --install)"
    return undefined
  }

  async function compile(): Promise<string> {
    const source = await Bun.file(sourceFile).text()
    const hash = createHash("sha256").update(source).update(process.arch).digest("hex").slice(0, 20)
    const folder = path.join(options.dir, "voice", "local", hash)
    const binary = path.join(folder, "mendcode-dictate")
    if (await Bun.file(binary).exists()) return binary
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o700)
    const temporary = path.join(folder, randomUUID())
    const swift = `${temporary}.swift`
    try {
      await Bun.write(swift, source)
      const compiled = await runManaged({ argv: ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-O", swift, "-o", temporary], cwd: folder, env: process.env, timeoutMs: COMPILE_MS, signal: new AbortController().signal })
      if (compiled.timedOut) throw new Error("building the dictation helper took over 2 minutes")
      if (compiled.exitCode !== 0) throw new Error(`building the dictation helper failed (Command Line Tools: xcode-select --install): ${compiled.output.slice(0, 300)}`)
      await chmod(temporary, 0o700)
      await rename(temporary, binary)
      return binary
    } finally {
      await rm(swift, { force: true })
      await rm(temporary, { force: true })
    }
  }

  async function helper() {
    if (executable) return executable
    compiling ??= compile().finally(() => { compiling = undefined })
    executable = await compiling
    return executable
  }

  async function start({ language, live }: { language?: string | undefined; live(update: LocalLive): void }): Promise<LocalSession> {
    const why = available()
    if (why) throw new Error(why)
    const child = Bun.spawn([await helper(), language ?? "auto"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    let latest = ""
    const ended = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    ended.promise.catch(() => {})
    started.promise.catch(() => {})
    const final = (text: string) => ended.resolve(text)
    const failed = (error: Error) => { started.reject(error); ended.reject(error) }
    let timer = setTimeout(() => failed(new Error("the dictation helper did not start")), READY_MS)
    void (async () => {
      const decoder = new TextDecoder()
      let buffer = ""
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true })
        if (buffer.length > MAX_LINE * 4) buffer = buffer.slice(-MAX_LINE)
        let end: number
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          let message: Record<string, unknown>
          try { message = JSON.parse(line) } catch { continue }
          if (typeof message.level === "number") live({ level: Math.max(0, Math.min(1, message.level)) })
          else if (typeof message.text === "string") { latest = message.text.slice(0, 20_000); live({ text: latest }) }
          else if (typeof message.installing === "string") { clearTimeout(timer); timer = setTimeout(() => failed(new Error("downloading the speech model took too long")), INSTALL_MS) }
          else if (message.ready === true) { clearTimeout(timer); started.resolve() }
          else if (typeof message.final === "string") final(message.final.slice(0, 20_000))
          else if (typeof message.error === "string") failed(new Error(message.error.slice(0, 300)))
        }
      }
      // An exit without `final` keeps what was heard so far.
      clearTimeout(timer)
      final(latest)
      started.reject(new Error("the dictation helper stopped before it was ready; check the microphone and its permission"))
    })().catch(() => final(latest))
    try {
      await started.promise
    } catch (error) {
      clearTimeout(timer)
      child.kill()
      throw error
    }
    return {
      async stop() {
        try { void Promise.resolve(child.stdin.end()).catch(() => {}) } catch { /* already closed */ }
        const limit = setTimeout(() => { child.kill(); final(latest) }, FINAL_MS)
        try { return (await ended.promise).trim() } finally { clearTimeout(limit) }
      },
      kill() {
        clearTimeout(timer)
        child.kill()
      },
    }
  }

  return { available, start }
}

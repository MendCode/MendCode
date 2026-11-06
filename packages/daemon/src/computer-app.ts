import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { runManaged } from "@mendcode/tools"
import sourceFile from "../assets/computer.swift" with { type: "file" }

/** The native helper as an app: one name, one bundle identifier and one path, so System Settings lists a single "MendCode Computer Use". */
export const APP_NAME = "MendCode Computer Use"
export const BUNDLE_ID = "com.mendcode.computer-use"
const EXECUTABLE = "mendcode-computer"
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`
/** Every build satisfies the same requirement, so the grant macOS stores for the app is not tied to one build's hash. Ad-hoc signing has no certificate to anchor it. */
const REQUIREMENT = `designated => identifier "${BUNDLE_ID}"\n`

/** The helper as the daemon sees it: lines in, lines out, and the process behind them. */
export type Link = { write(text: string): Promise<void>; reader: ReadableStreamDefaultReader<Uint8Array>; end(): void; kill(signal: NodeJS.Signals): void; alive(): boolean; exited: Promise<unknown> }

export function appPath(dir: string) { return path.join(dir, `${APP_NAME}.app`) }

/** The app at a path that does not change with the version. It is rebuilt in place only when its source changes. Returns its executable. */
export async function ensureApp(dir: string, signal: AbortSignal): Promise<string> {
  const source = await Bun.file(sourceFile).text()
  const stamp = createHash("sha256").update(source).update(PLIST).update(REQUIREMENT).update(process.arch).digest("hex").slice(0, 20)
  const app = appPath(dir)
  const binary = path.join(app, "Contents", "MacOS", EXECUTABLE)
  const stampFile = path.join(app, "Contents", "Resources", "build-stamp")
  if ((await readFile(stampFile, "utf8").catch(() => "")).trim() === stamp && await Bun.file(binary).exists()) return binary
  const work = path.join(dir, "computer-native", `build-${randomUUID()}`)
  await mkdir(work, { recursive: true, mode: 0o700 })
  try {
    const swift = path.join(work, "computer.swift"), built = path.join(work, EXECUTABLE), requirement = path.join(work, "requirement.txt")
    await writeFile(swift, source, { mode: 0o600 })
    await writeFile(requirement, REQUIREMENT, { mode: 0o600 })
    // LaunchServices refuses a bundle that needs a newer macOS than the running one, which is the SDK's default target.
    const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`
    const compiled = await runManaged({ argv: ["/usr/bin/xcrun", "swiftc", "-O", "-target", target, swift, "-o", built], cwd: work, env: process.env, timeoutMs: 120_000, signal })
    if (compiled.cancelled) throw new Error("Native helper compilation was cancelled; no computer input was sent")
    if (compiled.timedOut) throw new Error("Native helper compilation exceeded 120 seconds; no computer input was sent")
    if (compiled.exitCode !== 0) throw new Error("Swift helper compilation failed. Check Apple's Command Line Tools (xcode-select --install if missing): " + compiled.output.slice(0, 1000))
    signal.throwIfAborted()
    await mkdir(path.dirname(binary), { recursive: true })
    await mkdir(path.dirname(stampFile), { recursive: true })
    await chmod(built, 0o755)
    // Replaced where it stands: the app keeps its path and bundle identifier, which is what System Settings lists.
    await rename(built, binary)
    await writeFile(path.join(app, "Contents", "Info.plist"), PLIST)
    await writeFile(stampFile, stamp + "\n")
    const signed = await runManaged({ argv: ["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", BUNDLE_ID, "-r", requirement, app], cwd: work, env: process.env, timeoutMs: 30_000, signal })
    if (signed.exitCode !== 0) throw new Error("Signing the computer app failed: " + signed.output.slice(0, 500))
  } finally { await rm(work, { recursive: true, force: true }) }
  await removeOldHelpers(dir)
  return binary
}

/** The loose helpers of earlier versions, one folder per source hash. Their Accessibility entries stay until the user removes them (docs/computer.md). */
export async function removeOldHelpers(dir: string): Promise<string[]> {
  const root = path.join(dir, "computer-native")
  const removed: string[] = []
  for (const name of await readdir(root).catch(() => [])) {
    if (!/^[0-9a-f]{20}$/.test(name)) continue
    await rm(path.join(root, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** The helper as a plain child of the caller: macOS then attributes Accessibility to the terminal or daemon that started it. Used for stand-ins in tests. */
export async function launchChild(executable: string): Promise<Link> {
  const child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  return {
    async write(text) { child.stdin.write(text); await child.stdin.flush() },
    reader: child.stdout.getReader(),
    end() { try { void Promise.resolve(child.stdin.end()).catch(() => {}) } catch { /* already closed */ } },
    kill(signal) { child.kill(signal) },
    alive: () => child.exitCode === null,
    exited: child.exited,
  }
}

function socketPath(dir: string) {
  const name = `${randomUUID().slice(0, 8)}.sock`
  const preferred = path.join(dir, "computer-native", name)
  return Buffer.byteLength(preferred) < 100 ? preferred : path.join(tmpdir(), `mendcode-cu-${process.getuid?.() ?? 0}-${name}`)
}
const exists = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" } }
const Hello = z.strictObject({ ok: z.literal(true), value: z.strictObject({ pid: z.number().int().positive(), trusted: z.boolean() }) })

/**
 * Opens the app through LaunchServices (`open -g -n -a`), so macOS treats it as its own responsible process and Accessibility belongs to the
 * app, then connects to the socket it listens on. `open` returns at once: the app's own process id comes from its first answer.
 */
export async function launchApp(executable: string, dir: string, signal: AbortSignal): Promise<Link> {
  const app = path.resolve(executable, "..", "..", "..")
  const socket = socketPath(dir)
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
  const opened = await runManaged({ argv: ["/usr/bin/open", "-g", "-n", "-a", app, "--args", "--socket", socket], cwd: dir, env: process.env, timeoutMs: 15_000, signal })
  if (opened.exitCode !== 0) throw new Error(`macOS would not open ${APP_NAME}: ` + opened.output.slice(0, 500))
  const began = Date.now()
  while (!await stat(socket).then(() => true, () => false)) {
    signal.throwIfAborted()
    if (Date.now() - began > 15_000) throw new Error(`${APP_NAME} did not start listening`)
    await Bun.sleep(25)
  }
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  let ended = false, pid = 0
  let finish!: () => void
  const closing = new Promise<void>((resolve) => { finish = resolve })
  const close = () => { ended = true; try { controller.close() } catch { /* already closed */ } finish() }
  const connection = await Bun.connect({ unix: socket, socket: { data(_socket, data) { controller.enqueue(new Uint8Array(data)) }, close, error: close } })
  const link: Link = {
    async write(text) { connection.write(text); connection.flush() },
    reader: stream.getReader(),
    end() { connection.end() },
    kill(code) { if (pid) try { process.kill(pid, code) } catch { /* gone */ } },
    alive: () => !ended,
    // The connection ends first; the process may still hold the input lease for a moment.
    exited: closing.then(async () => { const stop = Date.now() + 3000; while (pid && exists(pid) && Date.now() < stop) await Bun.sleep(20) }),
  }
  await link.write(JSON.stringify({ method: "ping" }) + "\n")
  // The helper writes a reply and its newline separately: read to the newline so none of it is left for the first request.
  const decoder = new TextDecoder()
  let line = ""
  const deadline = Date.now() + 5000
  while (!line.includes("\n") && Date.now() < deadline) {
    const chunk = await Promise.race([link.reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => undefined)])
    if (!chunk || chunk.done) break
    line += decoder.decode(chunk.value, { stream: true })
  }
  line = line.split("\n")[0]!
  const hello = Hello.safeParse(line ? JSON.parse(line) : undefined)
  if (!hello.success) { connection.end(); throw new Error(`${APP_NAME} did not answer`) }
  pid = hello.data.value.pid
  return link
}

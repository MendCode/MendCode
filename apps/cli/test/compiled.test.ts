import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { SessionEvent, SessionId } from "@mendcode/protocol"

const root = path.join(import.meta.dir, "../../..")
const enabled = process.env.MENDCODE_TEST_COMPILE === "1"
const supplied = process.env.MENDCODE_TEST_BINARY

/** Probe the compiler separately: app compilation errors must fail, unavailable host compilation skips. */
function canCompile() {
  if (!enabled) return false
  const dir = mkdtempSync(path.join(tmpdir(), "mend-compile-probe-"))
  try {
    const main = path.join(dir, "probe.ts")
    const binary = path.join(dir, `probe${process.platform === "win32" ? ".exe" : ""}`)
    writeFileSync(main, 'process.stdout.write("compiled")\n')
    const built = Bun.spawnSync([process.execPath, "build", "--compile", main, "--outfile", binary], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    return built.exitCode === 0 && existsSync(binary)
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const available = enabled && (supplied ? existsSync(supplied) : canCompile())
if (enabled && !available && process.env.MENDCODE_REQUIRE_COMPILE === "1") throw new Error("required compiled smoke unavailable")
if (enabled && !available) process.stderr.write("compiled smoke skipped: host compilation unavailable\n")

// Windows has no local daemon transport yet; exercise the packaged CLI without pretending to test sockets.
test.skipIf(!available || process.platform !== "win32")("Windows standalone CLI loads help and upgrade without Bun or the checkout", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-compiled-win-")))
  try {
    const binary = supplied ? path.resolve(supplied) : path.join(dir, "mendcode.exe")
    if (!supplied) {
      const built = Bun.spawnSync([process.execPath, "run", "build", "--outfile", binary], { cwd: root, stdout: "pipe", stderr: "pipe" })
      expect({ code: built.exitCode, stderr: built.exitCode ? built.stderr.toString() : "" }).toEqual({ code: 0, stderr: "" })
    }
    for (const args of [["--help"], ["upgrade", "--help"]]) {
      const proc = Bun.spawn([binary, ...args, "--dir", path.join(dir, "data")], { cwd: dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, PATH: "" }, stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => proc.kill(), 15_000)
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        expect(stdout).toContain("mendcode")
      } finally { clearTimeout(timer) }
    }
    expect(existsSync(path.join(dir, "data"))).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120_000)

test.skipIf(!available || process.platform === "win32")("one standalone binary starts its daemon, serves automation and shuts down without Bun or the checkout", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-compiled-")))
  const binary = supplied ? path.resolve(supplied) : path.join(dir, "mendcode")
  const env = { ...process.env, HOME: dir, CODEX_HOME: dir, PATH: "", MENDCODE_CLAUDE: "0", MENDCODE_V2_ENGINE: "faux", MENDCODE_BUILD_ID: "must-not-replace-embedded-id" }
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  let client: ReturnType<typeof createClient> | undefined
  const socket = (data: string) => path.join(data, "mendd.sock")
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 15_000
    while (!ready() && Date.now() < deadline) await Bun.sleep(20)
    expect(ready()).toBe(true)
  }
  const command = async (data: string, ...args: string[]) => {
    // `--dir DATA` goes first: after a `session` command it means the project (a directory filter), not the daemon's storage.
    const proc = Bun.spawn([binary, "--dir", data, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc.kill(), 15_000)
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" })
      return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    } finally { clearTimeout(timer) }
  }
  const stop = async (data: string, engine = "faux") => {
    client = createClient({ socketPath: socket(data), name: "compiled-smoke", reconnect: false })
    await client.connect()
    const info = await client.send({ type: "daemon.info" })
    expect(info).toMatchObject({ ok: true, result: { engine } })
    expect(client.daemonBuildId).toMatch(/^dev-[a-f0-9]{12}$/)
    const recipes = await client.send({ type: "recipes.list", directory: dir })
    expect(recipes).toMatchObject({ ok: true, result: { recipes: [{ name: "balanced" }, { name: "deep" }, { name: "quick" }] } })
    const builtin = path.join(data, "builtin", client.daemonBuildId!)
    expect(await Bun.file(path.join(builtin, "recipes", "quick.json")).exists()).toBe(true)
    expect(existsSync(path.join(builtin, "skills"))).toBe(false)
    expect(await client.send({ type: "daemon.shutdown" })).toMatchObject({ ok: true })
    client.close()
    client = undefined
    const deadline = Date.now() + 5_000
    while (existsSync(socket(data)) && Date.now() < deadline) await Bun.sleep(20)
    expect(existsSync(socket(data))).toBe(false)
  }
  try {
    if (!supplied) {
      const build = Bun.spawn([process.execPath, "run", "build", "--outfile", binary], { cwd: root, stdout: "pipe", stderr: "pipe" })
      const stderr = await new Response(build.stderr).text()
      expect({ code: await build.exited, stderr: existsSync(binary) ? "" : stderr }).toEqual({ code: 0, stderr: "" })
    }
    const data = path.join(dir, "explicit")
    daemon = Bun.spawn([binary, "__daemon", "--dir", data, "--engine", "faux", "--cwd", dir], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => daemon?.kill(), 15_000)
    try {
      const reader = (daemon.stdout as ReadableStream<Uint8Array>).getReader()
      const { value } = await reader.read()
      reader.releaseLock()
      expect(JSON.parse(new TextDecoder().decode(value).trim())).toMatchObject({ ready: true, engine: "faux", socketPath: socket(data) })
    } finally { clearTimeout(timer) }
    expect(await command(data, "session", "create", "--compat", "mendcode.cli.v1")).toMatchObject([{ protocol: "mendcode.cli.v1", kind: "result", data: { sessionID: expect.any(String) } }])
    const events = await command(data, "run", "--format=json", "--compat=mendcode.cli.v1", "hello")
    expect(events[0]).toMatchObject({ protocol: "mendcode.cli.v1", event: "session.started" })
    expect(events.at(-1)).toMatchObject({ protocol: "mendcode.cli.v1", kind: "result", event: "session.completed", data: { status: "completed" } })
    const goalEvents: SessionEvent[] = []
    client = createClient({ socketPath: socket(data), name: "compiled-goals", reconnect: false, onEvent: (event) => goalEvents.push(event) })
    await client.connect()
    const created = await client.send({ type: "session.create", directory: dir, title: "embedded goals" })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result?.sessionId as SessionId
    expect(await client.subscribe(sessionId, 0)).toMatchObject({ ok: true })
    const saw = (kind: string) => goalEvents.some((event) => event.type === "item.started" && event.meta?.goal === kind)
    expect(await client.send({ type: "goal.set", sessionId, objective: "exercise packaged steering", tokenBudget: 1 })).toMatchObject({ ok: true })
    await until(() => saw("continuation"))
    expect(await client.send({ type: "goal.update", sessionId, objective: "exercise edited steering" })).toMatchObject({ ok: true })
    await until(() => saw("objective_updated"))
    expect(await client.send({ type: "user.submit", sessionId, text: "/usage", attachments: [] })).toMatchObject({ ok: true })
    await until(() => saw("budget_limit"))
    expect(await client.send({ type: "goal.clear", sessionId })).toMatchObject({ ok: true })
    await command(data, "session", "wait", sessionId, "--timeout", "10", "--json")
    client.close()
    client = undefined
    await stop(data)
    expect(await daemon.exited).toBe(0)
    daemon = undefined
    // Empty PATH and a cwd with no sources prove the launcher uses its own executable.
    const auto = path.join(dir, "automatic")
    expect(await command(auto, "session", "list", "--json")).toMatchObject([{ schema: "mendcode-next.cli.v1", kind: "result", data: { sessions: [] } }])
    await stop(auto)
    // Native startup reads all three embedded prompts; no turn or real provider is invoked.
    const native = path.join(dir, "native")
    expect(await command(native, "session", "list", "--engine", "native", "--json")).toMatchObject([{ kind: "result", data: { sessions: [] } }])
    await stop(native, "native")
  } finally {
    client?.close()
    if (daemon && daemon.exitCode === null) { daemon.kill(); await daemon.exited }
    // Also clean up a detached daemon if a later assertion failed.
    for (const data of ["explicit", "automatic", "native"]) {
      const lock = path.join(dir, data, "mendd.lock")
      if (!existsSync(lock)) continue
      const pid = Number(await Bun.file(lock).text())
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch {} }
      const deadline = Date.now() + 5_000
      while (existsSync(lock) && Date.now() < deadline) await Bun.sleep(20)
    }
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)

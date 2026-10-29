import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { openStore } from "@mendcode/store"
import { createPtyScreen } from "../../../scripts/pty-screen"
import { liveDaemon, terminateDaemon } from "../src/launcher"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

const entry = path.join(import.meta.dir, "../src/entry.ts")
const temps: string[] = []
const running: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(async () => {
  for (const child of running.splice(0)) child.kill("SIGKILL")
  for (const dir of temps.splice(0)) {
    await terminateDaemon(path.join(dir, "data"))
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The real CLI entry in a native PTY, on a throwaway data directory and the offline faux engine. */
function launch(options: { args?: string[]; env?: Record<string, string>; profile?: { processMode: "auto" | "solo" | "daemon" } } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-solo-pty-")))
  temps.push(root)
  const dir = path.join(root, "data")
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  for (const folder of [dir, home, project]) mkdirSync(folder, { recursive: true })
  const store = openStore({ dir })
  store.settings.set({ onboarded: true })
  store.close()
  if (options.profile) writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, ...options.profile })
  const screen = createPtyScreen(100, 30)
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, name: "xterm-256color", data: (_terminal, bytes) => screen.feed(decoder.decode(bytes, { stream: true })) })
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: root, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8", MENDCODE_TERMINAL_MODE: "0", MENDCODE_IMAGES: "off", MENDCODE_BUILD_ID: "solo-pty", ...options.env }
  const cli = Bun.spawn([process.execPath, entry, "--dir", dir, "--engine", "faux", ...(options.args ?? [])], { cwd: project, env, terminal })
  running.push(cli)
  const until = async (check: () => boolean, label: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}\n${screen.text()}`)
      await Bun.sleep(20)
    }
  }
  return {
    cli, dir, screen, until,
    lockOwner: () => Number(readFileSync(path.join(dir, "mendd.lock"), "utf8")),
    async prompt(text: string) {
      terminal.write(`\x1b[200~${text}\x1b[201~`)
      await Bun.sleep(80)
      terminal.write("\r")
    },
    async quit() {
      terminal.write("\x18")
      await Bun.sleep(80)
      terminal.write("q")
    },
    close() { terminal.close() },
    /** Keys without Enter: what a person types into the prompt. */
    type(text: string) { terminal.write(text) },
  }
}

test("a terminal started with no daemon hosts it, answers a prompt, and on quitting leaves nothing running", async () => {
  const terminal = launch({ args: ["--process", "solo"] })
  await terminal.until(() => existsSync(path.join(terminal.dir, "mendd.lock")) && /\S/.test(terminal.screen.text()), "the first frame")
  expect(terminal.lockOwner()).toBe(terminal.cli.pid)
  await terminal.prompt("hello solo")
  await terminal.until(() => terminal.screen.text().includes("echo: hello solo"), "the answer")
  await terminal.quit()
  expect(await terminal.cli.exited).toBe(0)
  expect(existsSync(path.join(terminal.dir, "mendd.lock"))).toBe(false)
  expect(await liveDaemon(terminal.dir)).toBeUndefined()
  terminal.close()
}, 90_000)

test("one process is the default, and the saved profile's daemon, MENDCODE_PROCESS and --process override it in that order", async () => {
  const byDefault = launch()
  await byDefault.until(() => existsSync(path.join(byDefault.dir, "mendd.lock")) && /\S/.test(byDefault.screen.text()), "the default's first frame")
  expect(byDefault.lockOwner()).toBe(byDefault.cli.pid)
  await byDefault.quit()
  expect(await byDefault.cli.exited).toBe(0)
  // Nothing was standing, so no daemon is left behind.
  expect(await liveDaemon(byDefault.dir)).toBeUndefined()
  byDefault.close()

  const saved = launch({ profile: { processMode: "daemon" } })
  await saved.until(() => existsSync(path.join(saved.dir, "mendd.lock")) && /\S/.test(saved.screen.text()), "the profile's first frame")
  expect(saved.lockOwner()).not.toBe(saved.cli.pid)
  await saved.quit()
  expect(await saved.cli.exited).toBe(0)
  // The separate daemon is the shape this setting asks for: it outlives the terminal.
  expect(await liveDaemon(saved.dir)).toBeDefined()
  saved.close()

  const env = launch({ profile: { processMode: "daemon" }, env: { MENDCODE_PROCESS: "solo" } })
  await env.until(() => existsSync(path.join(env.dir, "mendd.lock")) && /\S/.test(env.screen.text()), "the environment's first frame")
  expect(env.lockOwner()).toBe(env.cli.pid)
  await env.quit()
  expect(await env.cli.exited).toBe(0)
  env.close()

  const flag = launch({ profile: { processMode: "solo" }, env: { MENDCODE_PROCESS: "solo" }, args: ["--process", "daemon"] })
  await flag.until(() => existsSync(path.join(flag.dir, "mendd.lock")) && /\S/.test(flag.screen.text()), "the flag's first frame")
  expect(flag.lockOwner()).not.toBe(flag.cli.pid)
  await flag.quit()
  expect(await flag.cli.exited).toBe(0)
  flag.close()
}, 180_000)

test("a closed terminal window (SIGHUP) during a turn does not stop the turn: the process carries on headless, then ends", async () => {
  const terminal = launch({ args: ["--process", "solo"] })
  await terminal.until(() => existsSync(path.join(terminal.dir, "mendd.lock")) && /\S/.test(terminal.screen.text()), "the first frame")
  await terminal.prompt("/tool 2500")
  const watcher = createClient({ socketPath: path.join(terminal.dir, "mendd.sock"), name: "watcher", reconnect: false })
  await watcher.connect()
  const deadline = Date.now() + 20_000
  for (;;) {
    const reply = await watcher.send({ type: "daemon.status" })
    if (reply.ok && (reply.result as { activeTurns: number }).activeTurns === 1) break
    if (Date.now() > deadline) throw new Error(`the turn never started\n${terminal.screen.text()}`)
    await Bun.sleep(25)
  }
  watcher.close()
  terminal.cli.kill("SIGHUP")
  await Bun.sleep(700)
  expect(terminal.cli.exitCode).toBeNull()
  expect(await terminal.cli.exited).toBe(129)
  const store = openStore({ dir: terminal.dir })
  try {
    const session = store.listSessions({ directory: terminal.dir.replace(/data$/, "project"), limit: 5 })[0]!
    const types = store.readBefore(session.sessionId, undefined, 200).map((event) => event.type)
    expect(types).toContain("turn.completed")
    expect(types).not.toContain("turn.interrupted")
  } finally { store.close() }
  terminal.close()
}, 90_000)

test("auto hands the daemon to a separate process once another client attaches, so killing the first terminal stops no one's work", async () => {
  const terminal = launch()
  await terminal.until(() => existsSync(path.join(terminal.dir, "mendd.lock")) && /\S/.test(terminal.screen.text()), "the first frame")
  expect(terminal.lockOwner()).toBe(terminal.cli.pid)
  const other = createClient({ socketPath: path.join(terminal.dir, "mendd.sock"), name: "other terminal", reconnect: true })
  await other.connect()
  await terminal.until(() => existsSync(path.join(terminal.dir, "mendd.lock")) && terminal.lockOwner() !== terminal.cli.pid, "the daemon to move to its own process", 30_000)
  // What is typed while the daemon moves stays in the prompt (the new daemon does not have the blank chat it was typed in), and is sent to the new one.
  terminal.type("typed during the move")
  await Bun.sleep(2_000)
  expect(terminal.screen.text()).toContain("typed during the move")
  terminal.type("\r")
  await terminal.until(() => terminal.screen.text().includes("echo: typed during the move"), "the answer after the move")
  expect(readFileSync(path.join(terminal.dir, "logs", "daemon.stderr.log"), "utf8")).toContain("another client attached")
  terminal.cli.kill("SIGKILL")
  await terminal.cli.exited
  const reply = await other.send({ type: "daemon.status" })
  expect(reply.ok).toBe(true)
  expect(await liveDaemon(terminal.dir)).toBeDefined()
  other.close()
  terminal.close()
}, 90_000)

test("solo keeps hosting the daemon when another client attaches", async () => {
  const terminal = launch({ args: ["--process", "solo"] })
  await terminal.until(() => existsSync(path.join(terminal.dir, "mendd.lock")) && /\S/.test(terminal.screen.text()), "the first frame")
  const other = createClient({ socketPath: path.join(terminal.dir, "mendd.sock"), name: "other terminal", reconnect: false })
  await other.connect()
  await Bun.sleep(7_000)
  expect(terminal.lockOwner()).toBe(terminal.cli.pid)
  other.close()
  await terminal.quit()
  expect(await terminal.cli.exited).toBe(0)
  terminal.close()
}, 60_000)

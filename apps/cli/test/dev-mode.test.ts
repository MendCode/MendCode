import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { AGENT_SHELL_ENV } from "@mendcode/protocol/wire"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { renderTopbar } from "../src/view/topbar"
import { copyProviderKeys, devArguments, devDataDir, devDirRefusal, devEnvironment, findCheckout, parseDev } from "../src/dev-mode"

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcdev-"))); roots.push(dir); return dir }
const plain = (line: Line) => line.map((span) => span.text).join("")
const main = path.join(import.meta.dir, "../src/main.ts")
const checkout = path.resolve(import.meta.dir, "../../..")

describe("dev command line", () => {
  test("flags come before the command; tui and run pass the rest on and never take another data directory", () => {
    expect(parseDev(["dev", "--dir", "/x", "restart"])).toEqual({ action: "restart", dir: "/x", rest: [], help: false })
    expect(parseDev(["dev", "run", "--command", "check"])).toMatchObject({ action: "run", rest: ["--command", "check"] })
    expect(parseDev(["dev", "tui", "--dir", "/main"])).toBe("dev tui always uses the development data directory; set it with mendcode dev --dir DIR tui")
    expect(parseDev(["dev"])).toBe("dev needs a command")
    expect(parseDev(["dev", "explode"])).toBe("unknown dev command explode")
    expect(parseDev(["dev", "restart", "now"])).toBe("dev restart takes no arguments")
  })

  test("restart and stop interrupt running turns; the daemon is the checkout's own", () => {
    expect(devArguments("restart", [])).toEqual(["daemon", "restart", "--force"])
    expect(devArguments("stop", [])).toEqual(["daemon", "stop", "--force"])
    expect(devArguments("run", ["hi"])).toEqual(["run", "hi"])
  })

  test("the data directory defaults beside the main one and the child environment names it", () => {
    expect(devDataDir({ env: {}, home: "/home/u" })).toBe("/home/u/.mendcode-dev")
    expect(devDataDir({ env: { MENDCODE_DEV_DIR: "/d" }, home: "/home/u" })).toBe("/d")
    const env = devEnvironment({ env: { MENDCODE_DIR: "/main", [AGENT_SHELL_ENV]: "/main", PATH: "/bin" }, dir: "/dev" })
    expect(env).toMatchObject({ MENDCODE_DIR: "/dev", MENDCODE_DEV: "/dev", MENDCODE_PROCESS: "daemon", PATH: "/bin" })
    expect(AGENT_SHELL_ENV in env).toBe(false)
  })

  test("the main data directory and the one a session runs under are refused", () => {
    const home = "/home/u"
    expect(devDirRefusal({ dir: "/home/u/.mendcode", env: {}, home })).toContain("in use by the main installation")
    expect(devDirRefusal({ dir: "/home/u/.mendcode-v2", env: {}, home })).toContain("in use")
    expect(devDirRefusal({ dir: "/custom", env: { MENDCODE_DIR: "/custom" }, home })).toContain("in use")
    expect(devDirRefusal({ dir: "/dev", env: { [AGENT_SHELL_ENV]: "/dev" }, home })).toContain("in use")
    expect(devDirRefusal({ dir: "/home/u/.mendcode-dev", env: { [AGENT_SHELL_ENV]: "/home/u/.mendcode" }, home })).toBeUndefined()
  })

  test("the checkout is found from the current folder", () => {
    expect(findCheckout({ env: {}, cwd: path.join(checkout, "apps", "cli", "src") })).toBe(checkout)
    expect(findCheckout({ env: {}, cwd: temp() })).toBeUndefined()
    expect(findCheckout({ explicit: temp(), env: {}, cwd: checkout })).toBeUndefined()
  })
})

describe("what the development directory shares", () => {
  test("API-key providers are copied once with owner-only permissions; nothing else is", () => {
    const from = temp()
    const to = path.join(temp(), "dev")
    writeFileSync(path.join(from, "providers.json"), JSON.stringify({ providers: { openrouter: { apiKey: "sk-secret", enabled: true } }, other: "x" }))
    writeFileSync(path.join(from, "chatgpt-auth.json"), "{}")
    expect(copyProviderKeys({ from, to, replace: false })).toBe(1)
    const file = path.join(to, "providers.json")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(to).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ providers: { openrouter: { apiKey: "sk-secret", enabled: true } } })
    expect(existsSync(path.join(to, "chatgpt-auth.json"))).toBe(false)
    writeFileSync(file, JSON.stringify({ providers: {} }))
    chmodSync(file, 0o600)
    expect(copyProviderKeys({ from, to, replace: false })).toBeUndefined()
    expect(copyProviderKeys({ from, to, replace: true })).toBe(1)
  })
})

describe("DEV is visible", () => {
  test("the top bar leads its right side with DEV, and keeps it when the rest does not fit", () => {
    const wide = plain(renderTopbar({ width: 80, path: "/work/app", title: "t", dev: true, context: { tokens: 10, limit: 100 } }))
    expect(wide).toContain("DEV")
    expect(wide.indexOf("DEV")).toBeGreaterThan(wide.indexOf("/work/app"))
    expect(plain(renderTopbar({ width: 24, path: "/work/app/with/a/long/path", title: "t", dev: true, context: { tokens: 10, limit: 100 } }))).toContain("DEV")
    expect(plain(renderTopbar({ width: 80, path: "/work/app", title: "t", context: { tokens: 10, limit: 100 } }))).not.toContain("DEV")
  })

  test("the terminal draws it in the session's top bar and on the home screen", async () => {
    const ids = createIdFactory()
    const frames: Line[][] = []
    const sessionId = ids("session")
    const turnId = ids("turn")
    const app = createApp({
      sessionId, dev: true, version: "1.2.3", directory: "/work/app", exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => 1_800_000_000_000, random: () => 0, mode: "balanced",
      screen: { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as never,
      subscribe: async () => ({ ok: true }),
      send: (async (command: { type: string }) => (command.type === "session.list" ? { ok: true, result: { sessions: [] } } : { ok: true })) as never,
    })
    app.applySettings({})
    app.render()
    expect(frames.at(-1)!.map(plain).join("\n")).toContain("v1.2.3 DEV")
    const itemId = ids("item")
    app.onEvent({ sessionId, seq: 1, at: 1, type: "item.started", turnId, itemId, kind: "agent_message" } as SessionEvent)
    app.onEvent({ sessionId, seq: 2, at: 1, type: "item.completed", itemId, status: "ok", text: "hello" } as SessionEvent)
    app.render()
    expect(plain(frames.at(-1)![0]!)).toContain("DEV")
  })
})

const { env: baseEnv } = process
const clean = (home: string, extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined && !/^(CLAUDE|ANTHROPIC_|TUIOS_|AI_AGENT|MENDCODE)/.test(key)) env[key] = value
  return { ...env, HOME: home, MENDCODE_DIR: path.join(home, ".mendcode"), ...extra }
}
const cli = async (home: string, args: string[], extra: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, main, ...args], { cwd: checkout, env: clean(home, extra), stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code: await child.exited, out, err }
}
const pid = (text: string) => Number(/PID: (\d+)/.exec(text)?.[1])

describe("two real daemons", () => {
  test("the development daemon has its own directory, restarts alone, and a session's shell may drive it but not the main one", async () => {
    const home = temp()
    const mainDir = path.join(home, ".mendcode")
    const devDir = path.join(home, ".mendcode-dev")
    try {
      const mainStart = await cli(home, ["daemon", "start"])
      expect(mainStart.code).toBe(0)
      const mainPid = pid(mainStart.out)
      const devStart = await cli(home, ["dev", "start"])
      expect(devStart.code).toBe(0)
      const devPid = pid(devStart.out)
      expect(devStart.out).toContain(`Data: ${devDir}`)
      expect(devPid).not.toBe(mainPid)
      expect(existsSync(path.join(devDir, "mendd.db"))).toBe(true)
      expect(readFileSync(path.join(devDir, "mendd.lock"), "utf8").trim()).toBe(String(devPid))
      expect(readFileSync(path.join(mainDir, "mendd.lock"), "utf8").trim()).toBe(String(mainPid))

      const restarted = await cli(home, ["dev", "restart"])
      expect(restarted.err).toBe("")
      expect(restarted.code).toBe(0)
      expect(pid(restarted.out)).not.toBe(devPid)
      expect(pid((await cli(home, ["daemon", "status"])).out)).toBe(mainPid)

      // From the main daemon's own session shell: the development daemon is another data directory; the main one is not.
      const session = { [AGENT_SHELL_ENV]: mainDir }
      const again = await cli(home, ["dev", "restart"], session)
      expect(again.code).toBe(0)
      expect(pid(again.out)).not.toBe(pid(restarted.out))
      const refused = await cli(home, ["daemon", "restart"], session)
      expect(refused.code).not.toBe(0)
      expect(refused.err).toContain("refused:")
      const forced = await cli(home, ["dev", "--dir", mainDir, "restart"], session)
      expect(forced.code).not.toBe(0)
      expect(forced.err).toContain("in use by the main installation")
      expect(pid((await cli(home, ["daemon", "status"])).out)).toBe(mainPid)

      // The development daemon runs no background work: PR watch, Dream and loop triggers.
      const status = await cli(home, ["dev", "status"])
      expect(status.out).toContain("Dream: off")
    } finally {
      await cli(home, ["dev", "stop"])
      await cli(home, ["daemon", "stop", "--force"])
    }
  }, 90_000)
})

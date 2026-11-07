import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { readTuiProfile } from "../src/view/tui-profile"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function harness(answers: Record<string, unknown>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-today-app-"))
  dirs.push(dataDir)
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 120, height: 34 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const app = createApp({
    sessionId,
    screen,
    directory: "/work/app",
    dataDir,
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      const answer = answers[String(command.type)]
      return answer ? { ok: true, result: answer } : { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  const key = async (value: string) => {
    await app.onKey(value)
    await Bun.sleep(2)
  }
  const run = async (line: string) => {
    await app.onInput(line)
    await key("\r")
    await Bun.sleep(20)
  }
  return { app, sent, text, key, dataDir, run }
}

const SESSIONS = { sessions: [{ sessionId: "ses_waiting", title: "Add the coupon route", directory: "/work/shop-api", createdAt: NOW - 9e6, updatedAt: NOW - 6e5, lastSeq: 4, state: "waiting_approval", queued: 0, status: "waiting_for_approval", pending: "Run bun test", since: NOW - 9e5 }] }

describe("/today in the app", () => {
  test("opens, reads the daemon once per source, draws the rows and remembers the visit", async () => {
    const h = harness({ "session.list": SESSIONS })
    await h.run("/today")
    const text = h.text()
    expect(text).toContain("Today")
    expect(text).toContain("Add the coupon route")
    expect(text).toContain("approval · shop-api · waiting for your")
    expect(h.sent.map((command) => command.type).filter((type) => type !== "git.status")).toEqual(expect.arrayContaining(["session.list", "workflow.list", "memory.list", "memory.graph", "dream.list"]))
    expect(h.sent.every((command) => !/\.(add|delete|set|approve|reject|run|control)$/.test(String(command.type)))).toBe(true)
    expect(readTuiProfile(h.dataDir).todayLastVisit).toBe(NOW)
  })

  test("tabs, ? and esc work, and esc goes back to the chat", async () => {
    const h = harness({ "session.list": SESSIONS })
    await h.run("/today")
    await h.key("2")
    expect(h.text()).toContain("nothing to pick up")
    await h.key("3")
    expect(h.text()).toContain("no proposals")
    await h.key("?")
    expect(h.text()).toContain("open where it is managed")
    await h.key("\x1b")
    expect(h.text()).not.toContain("nothing to pick up")
  })

  test("enter on a row with a session switches to it", async () => {
    const h = harness({ "session.list": SESSIONS, "session.get": { session: SESSIONS.sessions[0] } })
    await h.run("/today")
    await h.key("\r")
    await Bun.sleep(10)
    expect(h.sent.some((command) => command.sessionId === "ses_waiting")).toBe(true)
  })

  test("takes no argument", async () => {
    const h = harness({})
    await h.run("/today now")
    expect(h.text()).toContain("usage: /today")
  })
})

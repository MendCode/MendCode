import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { readTuiProfile } from "../src/view/tui-profile"
import { localDay } from "../src/ui/app/today"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An answer that is a `Failure` comes back as the daemon's error. */
class Failure { constructor(readonly message: string) {} }

function harness(answers: Record<string, unknown>, profile?: Record<string, unknown>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-today-app-"))
  dirs.push(dataDir)
  if (profile) {
    fs.mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    fs.writeFileSync(path.join(dataDir, "tui", "profile.json"), JSON.stringify(profile))
  }
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
      if (answer instanceof Failure) return { ok: false, error: { code: "internal", message: answer.message } }
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

  test("m pins a row for today in the profile, for today only, and runs nothing", async () => {
    const h = harness({ "session.list": SESSIONS })
    await h.run("/today")
    await h.key("m")
    expect(h.text()).toContain("Today · 1 pinned")
    expect(readTuiProfile(h.dataDir).todayMarks).toEqual({ day: localDay(NOW), ids: ["attention:ses_waiting"] })
    expect(h.sent.every((command) => !/\.(add|delete|set|approve|reject|run|control|triage)$/.test(String(command.type)))).toBe(true)
    await h.key("m")
    expect(readTuiProfile(h.dataDir).todayMarks.ids).toEqual([])
  })

  test("yesterday's pins read as none", async () => {
    const h = harness({ "session.list": SESSIONS }, { todayMarks: { day: "2001-01-01", ids: ["attention:ses_waiting"] } })
    expect(readTuiProfile(h.dataDir).todayMarks.ids).toEqual(["attention:ses_waiting"])
    await h.run("/today")
    expect(h.text()).not.toContain("pinned")
  })

  test("t sends the rows once to today.triage, shows the model and the groups, and a accept pins only on the user's key", async () => {
    const h = harness({ "session.list": SESSIONS, "today.triage": { model: "gpt-6-luna", groups: [{ title: "1 approval to run tests", reason: "it only runs bun test", example: "attention:ses_waiting", action: "mark", ids: ["attention:ses_waiting"] }] } })
    await h.run("/today")
    expect(h.sent.some((command) => command.type === "today.triage")).toBe(false)
    await h.key("t")
    await Bun.sleep(10)
    const asked = h.sent.filter((command) => command.type === "today.triage")
    expect(asked).toHaveLength(1)
    expect(asked[0]!.items).toEqual([expect.objectContaining({ id: "attention:ses_waiting", tab: "attention", kind: "approval" })])
    expect(h.text()).toContain("gpt-6-luna grouped 1 of 1 row")
    expect(h.text()).toContain("pin for today")
    expect(readTuiProfile(h.dataDir).todayMarks.ids).toEqual([])
    await h.key("a")
    expect(readTuiProfile(h.dataDir).todayMarks.ids).toEqual(["attention:ses_waiting"])
    await h.key("\x1b")
    await h.key("t")
    expect(h.sent.filter((command) => command.type === "today.triage")).toHaveLength(1)
  })

  test("a failed triage says why and leaves the rows as they were", async () => {
    const h = harness({ "session.list": SESSIONS, "today.triage": new Failure("[DAEMON]: provider offline") })
    await h.run("/today")
    await h.key("t")
    await Bun.sleep(10)
    expect(h.text()).toContain("triage failed")
    expect(h.text()).toContain("provider offline")
    await h.key("\x1b")
    expect(h.text()).toContain("Add the coupon route")
  })

  test("takes no argument", async () => {
    const h = harness({})
    await h.run("/today now")
    expect(h.text()).toContain("usage: /today")
  })
})

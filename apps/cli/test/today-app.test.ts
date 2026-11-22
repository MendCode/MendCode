import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { SLASH_COMMANDS } from "../src/view/commands"

const ids = createIdFactory()
const plain = (line: Line) => line.map((span) => span.text).join("")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** An answer that is a `Failure` comes back as the daemon's error. */
class Failure { constructor(readonly message: string) {} }

function harness(answers: Record<string, unknown>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-today-app-"))
  dirs.push(dataDir)
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 120, height: 34 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: "/work/app",
    dataDir,
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      const answer = answers[String(command.type)]
      if (answer instanceof Failure) return { ok: false, error: { code: "forbidden", message: answer.message } }
      return answer ? { ok: true, result: answer } : { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  const run = async (line: string) => {
    await app.onInput(line)
    await app.onKey("\r")
    await Bun.sleep(30)
  }
  return { app, sent, text, run }
}

describe("/today in the app", () => {
  test("opens the day's Today chat and sends its first message, so the brief is written in the chat", async () => {
    const today = ids("session")
    const h = harness({ "today.open": { sessionId: today, fresh: true, kickoff: "Brief me for today." } })
    await h.run("/today")
    expect(h.sent.find((command) => command.type === "today.open")).toMatchObject({ directory: "/work/app" })
    expect(h.sent.filter((command) => command.type === "user.submit")).toMatchObject([{ sessionId: today, text: "Brief me for today.", attachments: [] }])
    // The chat is the page: the old tabs are gone and the prompt is there to talk to it.
    const order = h.sent.map((command) => command.type)
    expect(order.indexOf("today.open")).toBeLessThan(order.indexOf("user.submit"))
    expect(h.text()).not.toContain("Attention")
    expect(h.text()).not.toContain("Pick up")
    expect(h.sent.some((command) => command.type === "memory.list" || command.type === "dream.list")).toBe(false)
  })

  test("the same day's chat is reopened without a second brief", async () => {
    const today = ids("session")
    const h = harness({ "today.open": { sessionId: today, fresh: false } })
    await h.run("/today")
    expect(h.sent.filter((command) => command.type === "today.open")).toHaveLength(1)
    expect(h.sent.some((command) => command.type === "user.submit")).toBe(false)
  })

  test("a refusal is said in the terminal and nothing is sent to a session", async () => {
    const h = harness({ "today.open": new Failure("[TODAY]: Today is local only: it reads and decides memories") })
    await h.run("/today")
    expect(h.text()).toContain("Today is local only: it reads and decides memories")
    expect(h.text()).not.toContain("[TODAY]")
    expect(h.sent.some((command) => command.type === "user.submit")).toBe(false)
  })

  test("takes no argument and is listed with what it does now", async () => {
    const h = harness({})
    await h.run("/today now")
    expect(h.text()).toContain("usage: /today")
    expect(h.sent.some((command) => command.type === "today.open")).toBe(false)
    expect(SLASH_COMMANDS.find((command) => command.name === "today")?.summary).toBe("Open today's brief and talk to it")
  })
})

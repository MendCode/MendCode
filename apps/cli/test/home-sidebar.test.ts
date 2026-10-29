import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply

function homeApp(width: number) {
  const current = ids("session")
  const other = ids("session")
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Fresh chat", directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 },
    { sessionId: other, title: "Earlier work", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 60_000, lastSeq: 0, state: "idle", queued: 0 },
  ]
  const h = appHarness({ width, height: 50, mode: "balanced", sessionId: current, dataDir: tempDir(), directory: "/work/app", reply: (command) => command.type === "session.list" ? reply({ sessions }) : undefined })
  h.app.applySettings({})
  return { ...h, other }
}

describe("the new-chat screen shows the session sidebar", () => {
  test("wide terminals get the left sessions beside the home screen; narrow ones keep it full width", async () => {
    const wide = homeApp(180)
    await Bun.sleep(5)
    wide.app.render()
    const side = wide.text().map((row) => row.slice(0, SIDEBAR_WIDTH)).join("\n")
    expect(side).toContain("Sessions")
    expect(side).toContain("Earlier work")
    expect(wide.app.transcript.visibleCount).toBe(0)
    const narrow = homeApp(100)
    await Bun.sleep(5)
    narrow.app.render()
    // No sidebar: the other session is only the home's Completed row, and the current one is not listed.
    expect(narrow.text().join("\n")).toMatch(/Completed\s+✦ Earlier work/)
    expect(narrow.text().join("\n")).not.toContain("Fresh chat")
  })

  test("from the home screen a click switches to another session", async () => {
    const h = homeApp(180)
    await Bun.sleep(5)
    h.app.render()
    const row = h.text().findIndex((line) => line.slice(0, SIDEBAR_WIDTH).includes("Earlier work"))
    expect(row).toBeGreaterThan(0)
    await h.type(`\x1b[<0;5;${row + 1}M\x1b[<0;5;${row + 1}m`)
    expect(h.app.sessionId).toBe(h.other)
    expect(h.subscriptions.at(-1)?.sessionId).toBe(h.other)
  })
})

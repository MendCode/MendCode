import { afterAll, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import type { CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

/** The home's Agent View as v1 scopes it: the project's tree, every project from the user's home, and what already ran before this terminal opened. */
function homeApp(directory: string, sessions: SessionSummary[]) {
  const current = ids("session")
  // Only the list of every project carries them: a list for one directory (the title's) is empty.
  const h = appHarness({ width: 120, height: 50, mode: "balanced", sessionId: current, dataDir: tempDir(), directory, reply: (command) => command.type === "session.list" ? ({ ok: true, result: { sessions: command.directory ? [] : sessions } }) as CommandReply : undefined })
  h.app.applySettings({ onboarded: true })
  return h
}

const summary = (title: string, directory: string, state: SessionSummary["state"], updatedAt = NOW - 60_000): SessionSummary => ({ sessionId: ids("session"), title, directory, createdAt: updatedAt, updatedAt, lastSeq: 1, state, queued: 0 })

describe("home Agent View scope", () => {
  test("sessions already running or waiting in other terminals show from the start, from the project's folders only", async () => {
    const h = homeApp("/work/app", [
      summary("Asks for approval", "/work/app/packages/api", "waiting_approval"),
      summary("Builds the docs", "/work/app", "generating"),
      summary("Other project run", "/work/other", "generating"),
    ])
    await h.app.start()
    await Bun.sleep(5)
    h.app.render()
    const screen = h.text().join("\n")
    expect(screen).toContain("Asks for approval")
    expect(screen).toContain("Builds the docs")
    expect(screen).toMatch(/1 wait · 0 loop · 1 work/)
    expect(screen).not.toContain("Other project run")
  })

  test("from the user's home every project's finished sessions are under Completed", async () => {
    const h = homeApp(homedir(), [summary("Wakefold browser", `${homedir()}/Code/Wakefold`, "idle"), summary("Scratch notes", "/private/tmp/notes", "idle")])
    await h.app.start()
    await Bun.sleep(5)
    h.app.render()
    const rows = h.text()
    const completed = rows.findIndex((row) => row.includes("Completed"))
    expect(completed).toBeGreaterThanOrEqual(0)
    expect(rows.slice(completed).join("\n")).toContain("Wakefold browser")
    expect(rows.slice(completed).join("\n")).toContain("Scratch notes")
  })
})

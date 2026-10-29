import { afterAll, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

/**
 * Starting the terminal never waits on what may be slow or broken: the daemon's answer for the sidebar's cards, the model list
 * (an ACP agent's or a provider's catalog), quotas, providers, the code graph. The first frame is drawn, and typing works, while
 * every one of them is still unanswered; they fill in when they come.
 */
const SLOW = ["sidebar.get", "models.list", "providers.list", "usage.query", "quota.get", "changes.query", "mcp.status", "codegraph.status", "agents.list", "extensions.report", "session.list", "status.watch", "git.branch", "packages.list"]

function startingApp() {
  const unanswered: CommandInput[] = []
  const never = new Promise<CommandReply>(() => {})
  const h = appHarness({
    width: 140, height: 40, mode: "full", dataDir: tempDir("mend-first-frame-data-"), directory: tempDir("mend-first-frame-project-"),
    events: { loadWindow: async () => ({ ok: true, window: { events: [], firstSeq: 0, lastSeq: 0, more: false } }) as never, loadBefore: async () => ({ ok: true, window: { events: [], firstSeq: 0, lastSeq: 0, more: false } }) as never },
    reply: (command) => {
      if (SLOW.includes(command.type)) { unanswered.push(command); return never }
      return { ok: true } as CommandReply
    },
  })
  h.app.applySettings({ onboarded: true })
  return { ...h, unanswered }
}

test("with the sidebar's cards and the model list unanswered, the start screen and its prompt are drawn and take typing", async () => {
  const h = startingApp()
  const started = h.app.start()
  let settled = false
  void started.then(() => { settled = true })
  await Bun.sleep(20)
  // Still waiting on the daemon: the start has not settled, and the screen did not wait for it.
  expect(h.unanswered.map((command) => command.type)).toContain("sidebar.get")
  expect(settled).toBe(false)
  // The chat opened (its window read, its events subscribed): it did not queue behind the sidebar's cards.
  expect(h.subscriptions.map((entry) => entry.sessionId)).toEqual([h.sessionId])
  expect(h.frames.length).toBeGreaterThan(0)
  expect(h.text().join("\n")).toContain("Ask anything")
  await h.type("hello while the daemon thinks")
  expect(h.text().join("\n")).toContain("hello while the daemon thinks")
})

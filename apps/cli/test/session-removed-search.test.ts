import { afterAll, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply

test("a chat deleted elsewhere leaves the /sessions search results too, not only the loaded page", async () => {
  const summary = (title: string): SessionSummary => ({ sessionId: ids("session"), title, directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 })
  const page = Array.from({ length: 200 }, (_, index) => summary(`chat ${index}`))
  const found = [summary("zebra stripes")]
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, reply: (command) => {
    if (command.type !== "session.list") return undefined
    return reply({ sessions: (command as { find?: string }).find ? found : page })
  } })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  await h.type("/sessions\r")
  await Bun.sleep(10)
  await h.type("zebra")
  for (let turn = 0; turn < 40 && !h.text().join("\n").includes("zebra stripes"); turn++) { h.app.render(); await Bun.sleep(10) }
  expect(h.text().join("\n")).toContain("zebra stripes")
  h.app.onGlobal({ type: "session.removed", gseq: 1, at: NOW, sessionId: found[0]!.sessionId } as never)
  h.app.render()
  expect(h.text().join("\n")).not.toContain("zebra stripes")
})

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "../apps/cli/test/session-ui-harness"

const out = process.argv[2]
if (!out) throw new Error("Specify frame output directory")
mkdirSync(out, { recursive: true })
try {
  for (const [width, height] of [[100, 30], [180, 50]] as const) {
    const directory = tempDir(), sessionId = ids("session")
    const sessions = ["Pinned", "Active", "Settled"].map((section, index) => ({ sessionId: index ? ids("session") : sessionId, directory, title: `${section} fix`, createdAt: NOW, updatedAt: NOW, state: "idle", queued: 0, ...(index === 2 ? { archivedAt: NOW } : {}), lifecycle: { ...(index === 0 ? { pinnedAt: NOW } : {}), pr: { number: 7, url: "https://github.com/acme/app/pull/7", title: "Fix", state: "OPEN", branch: "fix", checkedAt: NOW } } }))
    const branches = ["fake-a", "fake-b"].map((model) => ({ sessionId: ids("session"), model, branch: `fanout-${model}`, directory, state: "idle", summary: `${model}: inspected changes and tests` }))
    const h = appHarness({ width, height, directory, sessionId, dataDir: tempDir(), reply: (command) => command.type === "session.list" ? { ok: true, result: { sessions } } : command.type === "session.fanout" ? { ok: true, result: { branches } } : undefined })
    const save = (name: string) => writeFileSync(path.join(out, `${name}-${width}x${height}.txt`), h.text().join("\n") + "\n")
    const c = conversation(sessionId, (event) => h.app.onEvent(event))
    c.exchange("Compare the fix", "Both branches are ready for review.")
    c.emit({ type: "session.orchestration", groupId: "comparison", text: "Fan-out\n1. fake-a · idle\n2. fake-b · idle\n/fanout compare · /fanout changes N" })
    h.app.render()
    save("transcript")
    await h.type('/fanout "compare the fix" fake-a fake-b\r')
    save("fanout")
    await h.type("\x1b")
    await h.type("/sessions\r")
    await h.type("\x0f")
    save("sessions")
  }
} finally { cleanTemps() }

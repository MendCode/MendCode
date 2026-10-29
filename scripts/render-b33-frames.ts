import { writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, conversation, ids, NOW, tempDir } from "../apps/cli/test/session-ui-harness"
import { permissionHistoryFixture } from "../apps/cli/test/permission-history-fixture"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB33Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    let revoked = false
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project", reply(command) {
      const history = permissionHistoryFixture(h.sessionId, NOW)
      if (revoked) history.grants[0] = { ...history.grants[0]!, active: false, revokedAt: NOW }
      if (command.type === "permissions.list") return { ok: true, result: { grants: revoked ? [] : [history.grants[0]!.grant] } }
      if (command.type === "permissions.history") return { ok: true, result: history }
      if (command.type === "permissions.revoke") { revoked = true; return { ok: true, result: { revoked: 1 } } }
      if (command.type === "settings.get") return { ok: true, result: { settings: { defaultPermission: "smart" } } }
      if (command.type === "models.list") return { ok: true, result: { engine: "native", selectable: true, models: [], defaults: { model: "local-fake" }, roles: { permissionReviewer: { model: "local-reviewer" } } } }
      return { ok: true }
    } })
    h.app.applySettings({ onboarded: true, reducedMotion: true })
    conversation(h.sessionId, h.app.onEvent).emit({ type: "session.permission", mode: "smart" })
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.type("/permissions\r")
    save("permissions-grants")
    await h.type("h")
    save("permissions-history")
    await h.type("j")
    await h.type("j")
    save("permissions-history-denied")
    await h.type("h")
    await h.type("R")
    save("permissions-revoke-confirm")
    await h.type("y")
    await h.type("h")
    save("permissions-history-revoked")
    await h.app.onKey("\x1b")
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("Run the local check", "I’ll run the local check.")
    const turnId = ids("turn"), itemId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue"), at: NOW - 2_000 })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "shell" }, at: NOW - 1_000 })
    chat.emit({ type: "server.request", requestId: ids("request"), turnId, itemId, kind: "approval", title: "Run command", tool: "shell", permission: "execute", detail: "node check.js\n\nWhy it asks: causal user authority missing or incomplete (unlisted-command)\nReviewer: allow — runs the requested check (this kind of call always asks)" })
    await Bun.sleep(5)
    save("approval-causal-authority")
    await h.app.onKey("\x03")
  }
}

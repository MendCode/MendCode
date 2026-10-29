import { writeFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import { appHarness, conversation, ids, NOW, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB32Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const settings: Settings = { defaultPermission: "smart", permissionReviewerRole: "small", permission: { read: { "*": "allow", "*/private/*": "deny" }, bash: { "git *": "allow", "git push *": "ask" }, external_directory: "ask", doom_loop: "ask" }, tools: { webfetch: false }, experimental: { primary_tools: ["loop", "question"], continue_loop_on_deny: false } }
    let grants = [{ grantId: "external:fixture", tool: "read", permission: "read" as const, pattern: "/work/shared/*", rulePermission: "external_directory", grantedAt: NOW - 60_000 }]
    function create() {
      const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project", reply(command) {
        if (command.type === "settings.get") return { ok: true, result: { settings } }
        if (command.type === "permissions.list") return { ok: true, result: { grants } }
        if (command.type === "permissions.revoke") { const revoked = grants.length; grants = []; return { ok: true, result: { revoked } } }
        if (command.type === "models.list") return { ok: true, result: { engine: "native", selectable: true, models: [], defaults: { model: "local-main" }, roles: { small: { model: "local-reviewer" } } } }
        return { ok: true }
      } })
      h.app.applySettings({ ...settings, onboarded: true, reducedMotion: true })
      return h
    }
    function save(name: string, h: Harness) {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const page = create()
    await page.type("/permissions\r")
    save("permissions-policy", page)
    await page.app.onKey("R")
    save("permissions-confirm", page)
    await page.app.onKey("y")
    save("permissions-empty", page)
    await page.app.onKey("\x1b")
    for (const [name, title, detail, tool] of [
      ["external-directory", "external directory access", "external_directory: /work/shared/*\n\n/work/shared/types.ts", "read"],
      ["doom-loop", "repeated tool action", "doom_loop: read\n\n/work/project/src/types.ts", "read"],
      ["path-rule", "bash", "bash: git push origin main\n\ngit push origin main", "shell"],
    ]) {
      const h = create()
      const chat = conversation(h.sessionId, h.app.onEvent)
      chat.exchange("Inspect the project types", "I’ll read the type definitions.")
      const turnId = ids("turn"), itemId = ids("item")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool } })
      chat.emit({ type: "server.request", requestId: ids("request"), turnId, itemId, kind: "approval", title, detail, tool, permission: tool === "read" ? "read" : "execute" })
      save(`approval-${name}`, h)
      await h.app.onKey("\x03")
    }
    await page.app.onKey("\x03")
  }
}

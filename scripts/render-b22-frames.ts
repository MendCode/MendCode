import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionEvent, SessionId, TaskRecord } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, tempDir } from "../apps/cli/test/session-ui-harness"
import { boot, openSession, put, stop, until } from "../packages/daemon/test/native-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB22Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const native = await boot({ steps: [stop("AGENTS.md guidance: run bun test; keep protocol changes additive; preserve existing instructions."), stop("No actionable defects in the inspected branch diff."), stop("notes.txt: the project uses an additive daemon protocol."), stop("The MCP prompt requested inspection of the client.")], mcp: {
    status: async () => ({ servers: [], issues: [] }), restart: async () => { throw new Error("unused") },
    cachedPrompts: () => [{ server: "fixture", prompt: { name: "audit", description: "Inspect client code", arguments: [{ name: "scope", required: true }] } }],
    listPrompts: async () => ({ prompts: [{ server: "fixture", prompt: { name: "audit", description: "Inspect client code", arguments: [{ name: "scope", required: true }] } }], issues: [] }),
    getPrompt: async ({ args }) => `Inspect ${args.scope}`,
  } })
  try {
    put(path.join(native.project, "notes.txt"), "The project uses an additive daemon protocol.")
    put(path.join(native.project, "mendcode.json"), JSON.stringify({ command: { audit: { description: "Inspect project notes", "argument-hint": "<scope>", template: "Inspect @notes.txt for $ARGUMENTS", agent: "explore", subtask: false }, "repo-status": { description: "Inspect repository status", template: "!`git status --short`" } } }))
    const parent = await openSession(native)
    const scenes: Array<{ name: string; sessionId: SessionId; command: string; events: SessionEvent[]; models: CommandReply }> = []
    for (const [name, command, args] of [["init", "init", ""], ["review", "review", "feature"], ["custom-command", "audit", '"protocol errors"'], ["mcp-prompt", "fixture:audit", "client"]] as const) {
      const reply = await native.client.executeCommand({ sessionId: parent, name: command, args })
      if (!reply.ok) throw new Error(reply.error.message)
      const task = reply.result?.task as TaskRecord | undefined
      const sessionId = task?.taskId ?? parent
      await until(() => native.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length >= (task ? 1 : scenes.filter((scene) => scene.sessionId === parent).length + 1))
      scenes.push({ name, sessionId, command: `/${command}${args ? ` ${args}` : ""}`, events: native.store.readAfter(sessionId, 0), models: await native.client.send({ type: "models.list", sessionId }) })
    }
    const denied = await native.client.executeCommand({ sessionId: parent, name: "repo-status", args: "" })
    if (denied.ok) throw new Error("untrusted project shell should be refused")
    const listed = await native.client.commands(native.project)
    if (!listed.ok) throw new Error(listed.error.message)
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const frame = (name: string, harness: ReturnType<typeof appHarness>) => {
        harness.app.render()
        const raw = harness.frames.at(-1) ?? []
        if (raw.length !== height || raw.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
        const rows = raw.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b") || textWidth(row) !== width)) throw new Error(`invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      for (const scene of scenes) {
        const harness = appHarness({ width, height, sessionId: scene.sessionId, directory: native.project, dataDir: tempDir(), reply: (command) => command.type === "commands.list" ? { ok: true, result: { commands: listed.commands } } : command.type === "models.list" ? scene.models : undefined })
        harness.app.applySettings({ onboarded: true })
        const history = scene.events
        const completed = history.filter((event) => event.type === "turn.completed").at(-1)
        const started = completed?.type === "turn.completed" ? history.find((event) => event.type === "turn.started" && event.turnId === completed.turnId) : undefined
        for (const event of history.filter((event) => event.seq >= (started?.seq ?? 0))) harness.app.onEvent(event)
        await Bun.sleep(5)
        if (!harness.app.editor.isEmpty()) throw new Error(`unexpected draft ${scene.name} ${size}`)
        frame(scene.name, harness)
        const partial = scene.command.split(" ")[0]!.slice(0, -1)
        await harness.type(partial)
        if (harness.app.editor.text !== partial) throw new Error(`unexpected completion ${scene.name} ${size}`)
        frame(`${scene.name}-completion`, harness)
        harness.app.applySettings({ onboarded: true, reducedMotion: true })
        await harness.app.onKey("\x15")
        await harness.app.onKey("\x03")
      }
      const refused = appHarness({ width, height, sessionId: parent, directory: native.project, dataDir: tempDir(), reply: (command) => command.type === "commands.list" ? { ok: true, result: { commands: listed.commands } } : command.type === "commands.execute" ? denied : undefined })
      refused.app.applySettings({ onboarded: true })
      await refused.type("/repo-status\r")
      if (refused.app.page !== "chat" || refused.app.editor.text !== "/repo-status") throw new Error(`missing shell refusal ${size}`)
      frame("inline-shell-refused", refused)
      await refused.app.onKey("\x15")
      await refused.app.onKey("\x03")
    }
  } finally { cleanTemps(); await native.cleanup() }
}

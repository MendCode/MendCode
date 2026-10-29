import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { GlobalEvent, SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../packages/daemon/src"
import { createFauxEngine } from "../packages/engine-faux/src"
import { parseAutomation, runAutomation } from "../apps/cli/src/automation"
import { appHarness, cleanTemps, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB64Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b64-frames-"))
  let onEvent: ((event: SessionEvent) => void) | undefined
  let onGlobal: ((event: GlobalEvent) => void) | undefined
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "b64-frames", onEvent: (event) => onEvent?.(event), onGlobal: (event) => onGlobal?.(event) })
  try {
    await client.connect()
    const scenes = new Map<string, string>()
    const run = async (name: string, ...argv: string[]) => {
      const parsed = parseAutomation(["--dir", dir, "session", ...argv])
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const code = await runAutomation(parsed.command, { client, listen: (handler) => { onEvent = handler }, out: { write: (text) => { output += text } }, err: { write: (text) => { throw new Error(text) } }, cwd: "/work/mendcode", now: Date.now, onInterrupt() {} })
      if (code !== 0) throw new Error(`${name}: exit ${code}`)
      scenes.set(name, output)
      return output.trim()
    }
    await run("cli-created-other", "create", "--title", "Review protocol")
    const sessionId = await run("cli-created-target", "create", "--title", "Preserved conversation") as SessionId
    await run("cli-completed-turn", "send", sessionId, "Preserve session history", "--timeout-ms", "1000")
    await run("cli-archive", "archive", sessionId)
    await run("cli-session-list", "list")
    await run("cli-session-list-archived", "list", "--archived")
    await run("cli-session-get-archived", "get", sessionId)
    await run("cli-restore", "archive", sessionId, "--restore")
    scenes.delete("cli-created-other")
    scenes.delete("cli-created-target")
    scenes.delete("cli-completed-turn")
    const events: SessionEvent[] = []
    onEvent = (event) => events.push(event)
    await client.subscribe(sessionId, 0)
    onEvent = undefined

    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size ${size}`)
      const width = Number(match[1])
      const height = Number(match[2])
      for (const [name, text] of scenes) {
        const lines = wrap(text.trimEnd(), width)
        for (let page = 0; page * height < lines.length; page++) {
          const rows = Array.from({ length: height }, (_, row) => (lines[page * height + row] ?? "").padEnd(width))
          if (rows.some((row) => row.includes("\x1b") || textWidth(row) !== width)) throw new Error(`invalid frame ${name} ${size}`)
          writeFileSync(path.join(directory, `${name}${lines.length > height ? `-p${page + 1}` : ""}-${size}.txt`), rows.join("\n") + "\n")
        }
      }
      const h = appHarness({ width, height, sessionId, dataDir: tempDir(), directory: "/work/mendcode", reply: (command) => client.send(command) })
      onGlobal = h.app.onGlobal
      const save = (name: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
        const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI in ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      h.app.applySettings({ onboarded: true })
      events.forEach(h.app.onEvent)
      await Bun.sleep(5)
      await h.type("/sessions\r")
      save("sessions-unarchived")
      await h.app.onKey("\x01")
      save("sessions-after-archive")
      await h.app.onKey("\x0f")
      save("sessions-include-archived")
      await h.type("Preserved")
      save("sessions-filter-archived")
      await h.app.onKey("\x01")
      save("sessions-after-restore")
      await h.app.onKey("\x12")
      save("sessions-rename")
      await h.app.onKey("\x1b")
      for (let i = 0; i < "Preserved".length; i++) await h.app.onKey("\x7f")
      await h.app.onKey("\x1b[B")
      await h.app.onKey("\x04")
      save("sessions-delete-confirm")
      await h.app.onKey("\x1b")
      await h.type("no-match")
      save("sessions-empty-filter")
      await h.app.onKey("\x1b")
      save("session-transcript-preserved")
      // Leaving chat stops the shared title-scrolling timer before the harness exits.
      await h.type("/sessions\r")
      onGlobal = undefined
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
  } finally {
    client.close()
    await daemon.stop()
    cleanTemps()
    rmSync(dir, { recursive: true, force: true })
  }
}

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "../apps/cli/test/session-ui-harness"
import { parseRemoteFlags } from "../apps/cli/src/remote"
import { parseStartup, prepareStartup } from "../apps/cli/src/startup"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import type { CommandInput } from "@mendcode/client"

export async function renderB34Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const memory = { rss: 42 * 1048576, heapTotal: 20 * 1048576, heapUsed: 10 * 1048576, external: 1048576, arrayBuffers: 0 }
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid frame size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const original = ids("session"), fork = ids("session")
      const remote = parseRemoteFlags(["attach", "http://127.0.0.1:4096", "--dir", "/work/mendcode", "--continue", "--fork", "--diagnostics"])
      const startup = parseStartup(remote.args)
      if (!remote.remote || !("directory" in remote.remote)) throw new Error("HTTP project route missing")
      const client = { send: async (command: CommandInput) => ({ ok: true as const, result: command.type === "session.list" ? { sessions: [{ sessionId: original }] } : command.type === "session.get" ? { session: { directory: "/work/mendcode" } } : command.type === "session.fork" ? { sessionId: fork } : {} }) }
      const selected = await prepareStartup(client, startup, remote.remote.directory!, "", { readOnly: false })
      const h = appHarness({ width, height, dataDir: tempDir(), sessionId: selected.sessionId, directory: selected.directory, version: "0.0.1", remote: { host: "127.0.0.1", readOnly: false }, diagnostics: { memory: () => memory, snapshot: async () => { throw new Error("not requested") } }, reply: (command) => command.type === "diagnostics.resources" ? { ok: true, result: { memory, connections: 1, actors: 1, jobs: 0, scopes: 1, timers: 0, disposers: 0, pid: 42, uptime: 60 } } : command.type === "models.list" ? { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: { model: "faux" }, effective: { model: "faux" }, roles: {} } } : command.type === "session.list" ? { ok: true, result: { sessions: [{ sessionId: selected.sessionId, directory: selected.directory, title: "HTTP attach fork", createdAt: 1, updatedAt: 2, state: "idle" }] } } : undefined })
      const save = (name: string) => {
        h.app.render()
        const rows = h.frames.at(-1)!
        if (rows.length !== height || rows.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
        const lines = rows.map((row) => fit(row, width).map((span) => span.text).join(""))
        if (lines.some((row) => row.includes("\x1b"))) throw new Error("ANSI in frame")
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${lines.join("\n")}\n`)
      }
      h.app.applySettings({ onboarded: true })
      await h.app.start()
      save("http-attach-home")
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Inspect workspace routing", "Each HTTP connection selects a registered project. Commands, replay and cancellation use the daemon's existing protocol.")
      save("http-attach-chat")
      await h.type("/diagnostics\r")
      save("http-attach-diagnostics")
      await h.app.onKey("\x1b")
      await h.app.onKey("\x03")
    }
  } finally { cleanTemps() }
}

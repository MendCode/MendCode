import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { startDaemon } from "../packages/daemon/src"
import { createFauxEngine } from "../packages/engine-faux/src"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { parseAutomation, runAutomation, helpText } from "../apps/cli/src/automation"
import { appHarness, tempDir, cleanTemps } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB15Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b15-frames-"))
  let listen: ((event: SessionEvent) => void) | undefined
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "b15-frames", onEvent: (event) => listen?.(event) })
  try {
    await client.connect()
    const scenes = new Map<string, string>([["cli-session-help", helpText("session")]])
    const run = async (scene: string, ...argv: string[]) => {
      const parsed = parseAutomation(["--dir", dir, "session", ...argv])
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let text = ""
      const code = await runAutomation(parsed.command, { client, listen: (handler) => { listen = handler }, out: { write: (value) => { text += value } }, err: { write: (error) => { throw new Error(error) } }, cwd: "/work/mendcode", now: Date.now, onInterrupt: () => {} })
      if (code !== 0) throw new Error(`${scene}: exit ${code}`)
      scenes.set(scene, text)
      return text
    }
    const sessionId = (await run("cli-session-create", "create", "--title", "Review client protocol")).trim() as SessionId
    await run("cli-session-send", "send", sessionId, "Review the protocol and preserve wire compatibility", "--timeout-ms", "1000")
    await run("cli-session-list", "list", "--search", "protocol")
    await run("cli-session-get", "get", sessionId)
    await run("cli-session-inspect", "inspect", sessionId)
    await run("cli-session-status", "status", sessionId)
    await run("cli-session-wait", "wait", sessionId, "--timeout-ms", "1000")
    await run("cli-session-export", "export", sessionId)
    await run("cli-session-rename", "rename", sessionId, "Protocol parity verified")
    const fork = await run("cli-session-fork", "fork", sessionId)
    const forkId = /Forked session (ses_\S+)/.exec(fork)![1]!
    await run("cli-session-delete", "delete", forkId)
    await run("cli-session-events", "events", sessionId, "--limit", "8")
    const listed = await client.send({ type: "session.list", directory: "/work/mendcode" })
    const events: SessionEvent[] = []
    listen = (event) => events.push(event)
    await client.subscribe(sessionId, 0)
    listen = undefined

    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size ${size}`)
      const width = Number(match[1])
      const height = Number(match[2])
      if (width < 20 || height < 10) throw new Error(`invalid size ${size}`)
      for (const [name, text] of scenes) {
        const rows = wrap(text.trimEnd(), width)
        for (let page = 0; page * height < rows.length; page++) {
          const slice = rows.slice(page * height, (page + 1) * height)
          const frame = Array.from({ length: height }, (_, row) => (slice[row] ?? "").padEnd(width))
          if (frame.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid frame: ${name} ${size}`)
          writeFileSync(path.join(directory, `${name}${rows.length > height ? `-p${page + 1}` : ""}-${size}.txt`), frame.join("\n") + "\n")
        }
      }
      const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode", sessionId, reply: (command) => command.type === "session.list" ? listed : undefined })
      const save = (name: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n") + "\n")
      }
      h.app.applySettings({ onboarded: true })
      events.forEach((event) => h.app.onEvent(event))
      await Bun.sleep(5)
      save("app-session")
      await h.type("/sessions\r")
      await Bun.sleep(5)
      save("app-session-list")
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
    mkdirSync(directory, { recursive: true })
  } finally {
    client.close()
    await daemon.stop()
    cleanTemps()
    rmSync(dir, { recursive: true, force: true })
  }
}

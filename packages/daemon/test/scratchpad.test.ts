import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { scratchpadFile } from "../src/scratchpad"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work() })

test("project scratchpad persists across daemon restarts and sessions without entering model history", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-scratch-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    let stopped = false
    const stop = async () => { if (!stopped) { stopped = true; await daemon.stop() } }
    cleanup.push(stop)
    const client = createClient({ socketPath: daemon.socketPath, name: "scratch-test", reconnect: false })
    cleanup.push(() => client.close())
    await client.connect()
    return { client, stop }
  }
  const first = await boot()
  expect(await first.client.send({ type: "scratchpad.get", directory: project })).toMatchObject({ ok: true, result: { text: "" } })
  expect(await first.client.send({ type: "scratchpad.set", directory: project, text: "private note\r\nnext line" })).toEqual({ ok: true })
  expect(readFileSync(scratchpadFile(dir, project), "utf8")).toBe("private note\nnext line")
  const session = await first.client.send({ type: "session.create", directory: project })
  expect(session.ok).toBe(true)
  expect(await first.client.send({ type: "scratchpad.get", directory: path.join(project, ".") })).toMatchObject({ result: { text: "private note\nnext line" } })
  expect(await first.client.send({ type: "scratchpad.get", directory: path.join(dir, "elsewhere") })).toMatchObject({ result: { text: "" } })
  first.client.close()
  await first.stop()
  const second = await boot()
  expect(await second.client.send({ type: "scratchpad.get", directory: project })).toMatchObject({ result: { text: "private note\nnext line" } })
  const another = await second.client.send({ type: "session.create", directory: project })
  expect(another.ok).toBe(true)
  if (another.ok) {
    const events = await second.client.send({ type: "session.events", sessionId: another.result!.sessionId as never })
    expect(JSON.stringify(events)).not.toContain("private note")
  }
  expect(await second.client.send({ type: "scratchpad.set", directory: project, text: "" })).toEqual({ ok: true })
  expect(await second.client.send({ type: "scratchpad.get", directory: project })).toMatchObject({ result: { text: "" } })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionId } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

/**
 * The terminal and a daemon that was replaced (an update, a crash): the new daemon removes the blank chats when it starts, so a
 * terminal can hold a session id it does not have. Whatever the daemon forgot, the terminal ends connected, on a valid session,
 * with no error line.
 */

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

const plain = (line: Line) => line.map((span) => span.text).join("")
const until = async (condition: () => boolean | Promise<boolean>, label: string, ms = 8_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(15)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function rig() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-restart-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  mkdirSync(project)
  const socketPath = path.join(dir, "mendd.sock")
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  let build = 0
  /** Starts the daemon of the data dir (a new build id each time) unless one runs: what the terminal's `ensureDaemon` does. */
  const ensure = async () => {
    if (daemon) return
    build++
    daemon = await startDaemon({ dir, socketPath, buildId: `build-${build}`, extensionsEnabled: false, log() {}, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 0 }), defaultDirectory: project })
  }
  const stopDaemon = async () => {
    const stopping = daemon
    daemon = undefined
    await stopping?.stop()
  }
  cleanup.push(() => stopDaemon())
  await ensure()
  let app: ReturnType<typeof createApp> | undefined
  const client = createClient({
    socketPath, name: "restart-test", timeoutMs: 3_000,
    onEvent: (event) => app?.onEvent(event),
    onGlobal: (event) => app?.onGlobal(event),
    onConnection: (state) => app?.onConnection(state),
    beforeReconnect: ensure,
  })
  await client.connect()
  cleanup.push(() => client.close())
  const frames: Line[][] = []
  const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows), write() {}, setTitle() {} } as never
  writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden" })
  const open = async (sessionId: SessionId) => {
    app = createApp({
      sessionId, screen, directory: project, dataDir: dir, glyphs: glyphs({}), now: Date.now, random: () => 0, exit() {}, schedule: (fn) => fn(),
      send: (command) => client.send(command), subscribe: (id, afterSeq) => client.subscribe(id, afterSeq),
      events: { loadWindow: (id) => client.loadWindow(id), loadBefore: (id, firstSeq) => client.loadBefore(id, firstSeq) },
    })
    app.applySettings({ onboarded: true, reducedMotion: true })
    await app.start()
    return app
  }
  const screenText = () => {
    app?.render()
    return (frames.at(-1) ?? []).map(plain).join("\n")
  }
  const blank = async () => {
    const created = await client.send({ type: "session.create", directory: project, title: "", reuseEmpty: true })
    if (!created.ok) throw new Error(created.error.message)
    return created.result!.sessionId as SessionId
  }
  const exists = async (sessionId: SessionId) => (await client.send({ type: "session.get", sessionId })).ok
  const buildId = async () => {
    const status = await client.send({ type: "daemon.status" })
    return status.ok ? status.result?.buildId : undefined
  }
  return { client, ensure, stopDaemon, open, screenText, blank, exists, buildId, app: () => app! }
}

describe("the terminal and a daemon that was replaced", () => {
  test("it starts on a blank chat the new daemon removed: it moves to a valid session, no error line", async () => {
    const r = await rig()
    const held = await r.blank()
    await r.stopDaemon()
    await r.ensure()
    expect(await r.exists(held)).toBe(false)
    const app = await r.open(held)
    await until(() => app.sessionId !== held, "the terminal to leave the lost chat")
    expect(await r.exists(app.sessionId)).toBe(true)
    const screen = r.screenText()
    expect(screen).not.toContain("unknown session")
    expect(screen).not.toContain("reconnecting")
  })

  test("it is open on a blank chat when the daemon is replaced by another build: it reconnects and moves to a valid session", async () => {
    const r = await rig()
    const held = await r.blank()
    const app = await r.open(held)
    expect(await r.buildId()).toBe("build-1")
    await r.stopDaemon()
    await until(async () => (await r.buildId()) === "build-2", "the replacement daemon")
    await until(() => app.sessionId !== held, "the terminal to leave the lost chat")
    await until(() => !r.screenText().includes("reconnecting"), "the connection to come back")
    expect(await r.exists(app.sessionId)).toBe(true)
    expect(r.screenText()).not.toContain("unknown session")
    expect(r.screenText()).not.toContain("reconnecting")
    // Typing works on the new session.
    await app.onInput("hello")
    await app.onInput("\r")
    await until(() => r.screenText().includes("echo: hello"), "an answer on the new session")
  })

  test("a chat with a conversation survives the replacement: the terminal stays on it", async () => {
    const r = await rig()
    const held = await r.blank()
    const app = await r.open(held)
    await app.onInput("first")
    await app.onInput("\r")
    await until(() => r.screenText().includes("echo: first"), "the first answer")
    await r.stopDaemon()
    await until(async () => (await r.buildId()) === "build-2", "the replacement daemon")
    await until(() => !r.screenText().includes("reconnecting"), "the connection to come back")
    expect(app.sessionId).toBe(held)
    expect(await r.exists(held)).toBe(true)
    expect(r.screenText()).not.toContain("unknown session")
  })
})

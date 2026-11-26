import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { botPeerRefusal, insideRoot } from "../src/bot-peer"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("bot test timed out")
    await Bun.sleep(5)
  }
}

test("insideRoot matches the folder and what is below it, never a sibling that shares the prefix", () => {
  expect(insideRoot("/bots/a", "/bots/a")).toBe(true)
  expect(insideRoot("/bots/a", "/bots/a/work")).toBe(true)
  expect(insideRoot("/bots/a", "/bots/ab")).toBe(false)
  expect(insideRoot("/bots/a", "/bots")).toBe(false)
})

test("a bot token is created with an absolute folder and listed with it; it survives authenticate and a changed store is refused", () => {
  const dir = temp("mendd-bot-token-")
  const tokens = remoteTokens(dir)
  expect(() => tokens.create({ name: "rel", botRoot: "relative/dir" })).toThrow("absolute")
  expect(() => tokens.create({ name: "slash", botRoot: "/" })).toThrow("not the filesystem root")
  expect(() => tokens.create({ name: "both", botRoot: "/bots/a", readOnly: true })).toThrow("cannot also")
  const made = tokens.create({ name: "vorlen", botRoot: "/bots/a/../a" })
  expect(made).toMatchObject({ name: "vorlen", scope: "bot", root: "/bots/a", readOnly: false })
  expect(tokens.list()).toEqual([expect.objectContaining({ name: "vorlen", scope: "bot", root: "/bots/a" })])
  const peer = tokens.authenticate(made.token)!
  expect(peer).toMatchObject({ scope: "bot", root: "/bots/a" })
  expect(tokens.active(peer)).toBe(true)
  expect(tokens.active({ ...peer, root: "/bots" })).toBe(false)
})

test("botPeerRefusal names every command a bot may send and refuses the rest", () => {
  const root = "/bots/a"
  const sessions: Record<string, string> = { ses_in: "/bots/a/work", ses_out: "/bots/b" }
  const refuse = (command: object) => botPeerRefusal({ command: command as never, root, sessionDirectory: (id) => sessions[id], canonical: (directory) => directory })
  expect(refuse({ type: "session.create", directory: "/bots/a/work" })).toBeUndefined()
  expect(refuse({ type: "session.create", directory: "/bots/b" })).toContain("outside")
  expect(refuse({ type: "session.create", directory: "/bots/a", parentId: "ses_in" })).toContain("no parent")
  expect(refuse({ type: "user.submit", sessionId: "ses_in", text: "hi", attachments: [] })).toBeUndefined()
  expect(refuse({ type: "user.submit", sessionId: "ses_in", text: "hi", attachments: [{ sha256: "a" }] })).toContain("text only")
  expect(refuse({ type: "user.submit", sessionId: "ses_out", text: "hi", attachments: [] })).toContain("outside")
  expect(refuse({ type: "turn.cancel", sessionId: "ses_gone", turnId: "trn_x" })).toContain("outside")
  expect(refuse({ type: "queue.remove", sessionId: "ses_in", queueId: "que_x" })).toBeUndefined()
  expect(refuse({ type: "queue.edit", sessionId: "ses_in", queueId: "que_x", text: "x" })).toContain("only runs turns")
  expect(refuse({ type: "models.list" })).toBeUndefined()
  for (const type of ["settings.get", "secrets.reveal", "user.shell", "session.list", "daemon.shutdown", "memory.list"]) expect(refuse({ type })).toContain("only runs turns")
})

test("a bot token runs turns in its folder and is refused everywhere else, with no broadcasts", async () => {
  const dir = temp("mendd-bot-daemon-")
  const root = temp("mendd-bot-root-")
  const work = path.join(root, "work")
  mkdirSync(work)
  const other = temp("mendd-bot-other-")
  symlinkSync(other, path.join(root, "escape"))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", defaultDirectory: root, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const local = createClient({ socketPath: daemon.socketPath, name: "local" })
  await local.connect()
  cleanups.push(() => local.close())
  const foreign = await local.send({ type: "session.create", directory: other, title: "Not the bot's" })
  if (!foreign.ok) throw new Error(foreign.error.message)
  const token = remoteTokens(dir).create({ name: "vorlen", botRoot: root }).token
  const events: SessionEvent[] = []
  let globals = 0
  const bot: Client = createClient({ name: "bot", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token }, onEvent: (event) => events.push(event), onGlobal: () => { globals += 1 }, timeoutMs: 1000 })
  cleanups.push(() => bot.close())
  await bot.connect()

  const created = await bot.send({ type: "session.create", directory: work, title: "Bot chat" })
  expect(created.ok).toBe(true)
  const sessionId = (created as { result?: { sessionId?: string } }).result!.sessionId as SessionId
  expect(await bot.send({ type: "session.create", directory: other, title: "outside" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await bot.send({ type: "session.create", directory: path.join(root, "escape"), title: "through a link" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await bot.send({ type: "client.subscribe", sessionId: (foreign.result as { sessionId: SessionId }).sessionId, afterSeq: 0 })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await bot.send({ type: "session.list", directory: other })).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await bot.send({ type: "settings.get" })).toMatchObject({ ok: false, error: { code: "forbidden" } })

  expect(await bot.subscribe(sessionId)).toMatchObject({ ok: true })
  expect(await bot.send({ type: "user.submit", sessionId, text: "hello bot", attachments: [] })).toMatchObject({ ok: true })
  await until(() => events.some((event) => event.type === "turn.completed"))
  expect(events.some((event) => event.type === "item.completed" && event.sessionId === sessionId)).toBe(true)
  expect(events.every((event) => event.sessionId === sessionId)).toBe(true)
  // The daemon's quota, usage and activity broadcasts are not the bot's to hear.
  await local.send({ type: "session.create", directory: other, title: "A broadcast" })
  await Bun.sleep(50)
  expect(globals).toBe(0)
})

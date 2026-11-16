import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"
import { launchAndWait, openApp } from "../src/open-url"

test("an app launcher that exits with a failure is a failed open, not a success", async () => {
  await expect(launchAndWait("true", [])).resolves.toBeUndefined()
  await expect(launchAndWait("false", [])).rejects.toThrow("exited with 1")
  if (process.platform === "darwin") await expect(openApp("Desk Agent", (program, args) => launchAndWait("false", [program, ...args]))).rejects.toThrow("Desk Agent did not open")
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test("url.open hands an http/https address to the system opener and refuses any other scheme", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-url-open-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const opened: string[] = []
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), openUrl: async (url) => { opened.push(url) } })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "url-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  expect(await client.send({ type: "url.open", url: "http://127.0.0.1:5173" })).toMatchObject({ ok: true })
  expect(opened).toEqual(["http://127.0.0.1:5173"])

  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client") }
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://x.y/a b", `https://x.y/${"a".repeat(2100)}`]) expect(Command.safeParse({ ...base, type: "url.open", url }).success).toBe(false)
  expect(isReadOnlyCommand("url.open")).toBe(false)
})

test("app.open hands one plain app name to the launcher and refuses a path or an option", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-app-open-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const opened: string[] = []
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), openApp: async (app) => { opened.push(app) } })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "app-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  expect(await client.send({ type: "app.open", app: "Hermes Agent" })).toMatchObject({ ok: true })
  expect(opened).toEqual(["Hermes Agent"])

  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client") }
  for (const app of ["", "-n", "/Applications/Hermes.app", "a/b", "a\nb", "x".repeat(201)]) expect(Command.safeParse({ ...base, type: "app.open", app }).success).toBe(false)
  expect(isReadOnlyCommand("app.open")).toBe(false)
})

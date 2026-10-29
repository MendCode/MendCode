import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"

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

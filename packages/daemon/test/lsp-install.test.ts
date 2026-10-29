import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteExecutionCommand } from "../src/remote-policy"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test("lsp.install runs the daemon's installer for the asked server and reports a failure with its reason", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-lsp-install-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const asked: string[] = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    engine: ({ clock }) => createFauxEngine({ clock }),
    lsp: { query: async () => ({ result: [] }) },
    lspInstall: async ({ server }) => {
      asked.push(server)
      return server === "go" ? { id: server, reason: "go is not on PATH" } : { id: server, command: ["/cache/typescript-language-server", "--stdio"] }
    },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "lsp-install" })
  await client.connect()
  cleanups.push(() => client.close())
  expect(await client.send({ type: "lsp.install", directory: dir, server: "typescript" })).toMatchObject({ ok: true, result: { command: ["/cache/typescript-language-server", "--stdio"] } })
  expect(JSON.stringify(await client.send({ type: "lsp.install", directory: dir, server: "go" }))).toContain("go was not installed: go is not on PATH")
  expect(asked).toEqual(["typescript", "go"])
  expect(remoteExecutionCommand("lsp.install")).toBe(true)
})

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createFormatterManager } from "@mendcode/lsp"
import { formatterFixture } from "../../lsp/test/formatter-fixtures"
import { stackFormatterConfig } from "../../lsp/test/stack-formatter-fixtures"
import { put } from "../../lsp/test/helpers"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function boot(enabled = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mendd-formatter-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  formatterFixture(dir)
  const formatter = createFormatterManager({ which: () => null })
  cleanups.push(() => formatter.stop())
  const daemon = await startDaemon({ dir, socketPath: join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...(enabled ? { formatter } : {}) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "formatter-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, client }
}

test("typed client → daemon → installed local formatter, opt-in status and disk mutations", async () => {
  const { dir, client } = await boot()
  expect(await client.formatterStatus(dir)).toEqual({ ok: true, report: { formatters: [], issues: [] } })
  put({ root: dir, path: ".mendcode/formatter.json", content: JSON.stringify(stackFormatterConfig("prettier")) })
  const file = put({ root: dir, path: "app.ts", content: "BAD" })
  expect(await client.formatterStatus(dir)).toMatchObject({ ok: true, report: { formatters: [{ name: "prettier", enabled: true }] } })
  expect(await client.formatFile(dir, "app.ts")).toMatchObject({ ok: true, report: { file, formatted: true, results: [{ name: "prettier", ok: true }] } })
  expect(readFileSync(file, "utf8")).toBe("GOOD")
})

test("formatter unavailable/config errors do not break the daemon or expose custom env", async () => {
  const { dir, client } = await boot()
  put({ root: dir, path: ".mendcode/formatter.json", content: JSON.stringify({ prettier: { command: ["not-installed", "$FILE"], environment: { SECRET: "not-for-clients" } }, biome: { disabled: true }, oxfmt: { disabled: true } }) })
  put({ root: dir, path: "app.ts", content: "BAD" })
  const reply = await client.formatFile(dir, "app.ts")
  expect(reply).toMatchObject({ ok: true, report: { formatted: false, results: [{ name: "prettier", ok: false, message: expect.stringContaining("not installed") }] } })
  expect(JSON.stringify(reply)).not.toContain("not-for-clients")
  put({ root: dir, path: ".mendcode/formatter.json", content: "{" })
  expect(await client.formatterStatus(dir)).toMatchObject({ ok: true, report: { issues: [{ message: expect.stringContaining("valid JSON") }] } })
  expect(await client.send({ type: "daemon.info" })).toMatchObject({ ok: true })
})

test("daemon without a formatter explicitly refuses both commands", async () => {
  const { dir, client } = await boot(false)
  for (const reply of [await client.formatterStatus(dir), await client.formatFile(dir, "app.ts")]) expect(reply).toMatchObject({ ok: false, error: { code: "invalid_command", message: "[DAEMON]: Formatter is not available" } })
})

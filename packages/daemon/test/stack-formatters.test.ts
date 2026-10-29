import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createFormatterManager } from "@mendcode/lsp"
import { STACK_FORMATTERS } from "../../lsp/src/stack-formatters"
import { stackFormatterFixture } from "../../lsp/test/stack-formatter-fixtures"
import { put } from "../../lsp/test/helpers"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test.each(STACK_FORMATTERS.map((spec) => spec.name))("B14 %s: typed client/daemon status, formatting and safe failure", async (name) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mendd-b14-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const { spec, config } = stackFormatterFixture(dir, name)
  const formatter = createFormatterManager({ which: () => null })
  cleanups.push(() => formatter.stop())
  const daemon = await startDaemon({ dir, socketPath: join(dir, "daemon.sock"), formatter, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b14-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  const status = await client.formatterStatus(dir)
  expect(status.ok).toBe(true)
  if (!status.ok) throw new Error(status.error.message)
  expect(status.report.formatters.find((item) => item.name === name)).toMatchObject({ enabled: true, extensions: spec.extensions })
  const file = put({ root: dir, path: `app${spec.extensions[0]}`, content: "BAD" })
  expect(await client.formatFile(dir, file)).toMatchObject({ ok: true, report: { formatted: true, results: [{ name, ok: true }] } })
  expect(readFileSync(file, "utf8")).toBe("GOOD")
  config[name] = { environment: { FAKE_FORMATTER_MODE: "format-fail", SECRET: "not-for-clients" } }
  put({ root: dir, path: ".mendcode/formatter.json", content: JSON.stringify(config) })
  const failed = await client.formatFile(dir, file)
  expect(failed).toMatchObject({ ok: true, report: { formatted: false, results: [{ name, ok: false, message: "exit 7" }] } })
  expect(JSON.stringify(failed)).not.toContain("secret")
  expect(JSON.stringify(failed)).not.toContain("not-for-clients")
  expect(readFileSync(file, "utf8")).toBe("GOOD")
})

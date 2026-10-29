import { expect, test } from "bun:test"
import { createSchemaCatalog, SCHEMA_PAGE_BYTES } from "@mendcode/protocol/wire"
import { parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"

function parsed(...args: string[]): Automation {
  const result = parseAutomation(args)
  if (result.ok !== true) throw new Error(JSON.stringify(result))
  return result.command
}

/** A daemon stand-in that answers `system.query generate` from the real catalog, one bounded page per request. */
function fake() {
  const note = "x".repeat(2000)
  const command = (type: string) => ({ type: "object", properties: { type: { const: type }, text: { $ref: "#/$defs/text" } }, description: note })
  const source: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      { type: "object", properties: { kind: { const: "auth" }, token: { type: "string" } } },
      { type: "object", properties: { kind: { const: "command" }, body: { oneOf: Array.from({ length: 200 }, (_, index) => command(index === 0 ? "tui.query" : `session.send${index}`)) } } },
    ],
    $defs: { text: { type: "string", maxLength: 10 } },
  }
  expect(JSON.stringify(source).length).toBeGreaterThan(SCHEMA_PAGE_BYTES * 2)
  const catalog = createSchemaCatalog(source)
  const sent: Record<string, unknown>[] = [], out: string[] = [], err: string[] = []
  const send = async (command: Record<string, unknown>) => {
    sent.push(command)
    const contract: Record<string, unknown> = { transport: "newline-json", protocol: 1 }
    const failures: string[] = []
    if (typeof command.entry === "string") {
      const schema = catalog.entry(command.entry)
      if (schema) Object.assign(contract, { entry: command.entry, schema })
      else failures.push(`unknown entry ${command.entry}`)
    } else if (typeof command.page === "number") contract.page = catalog.page(command.page)
    else contract.index = catalog.index(typeof command.index === "number" ? command.index : 0)
    return { ok: true, result: { operation: "generate", ok: failures.length === 0, checks: [], failures, facts: { contract } } }
  }
  const deps = { client: { send }, cwd: "/work/project", out: { write: (text: string) => out.push(text) }, err: { write: (text: string) => err.push(text) }, now: () => 1000, listen: () => {}, onInterrupt: () => {} } as unknown as AutomationDeps
  return { source, sent, out, err, deps }
}

test("generate reassembles the whole protocol schema from bounded pages, same output shape as before", async () => {
  const h = fake()
  expect(await runAutomation(parsed("generate"), h.deps)).toBe(0)
  const contract = JSON.parse(h.out.join(""))
  expect(contract).toMatchObject({ transport: "newline-json", protocol: 1 })
  expect(contract.schema).toEqual(h.source)
  expect(h.sent.every((command) => command.type === "system.query" && command.operation === "generate")).toBe(true)
  expect(h.sent.length).toBeGreaterThan(1)
})

test("generate --index lists entries and --entry fetches one command schema without the rest", async () => {
  const listing = fake()
  expect(await runAutomation(parsed("generate", "--index"), listing.deps)).toBe(0)
  expect(listing.out.join("")).toContain("command:tui.query\t")
  const one = fake()
  expect(await runAutomation(parsed("generate", "--entry", "command:tui.query"), one.deps)).toBe(0)
  expect(one.sent).toHaveLength(1)
  expect(one.out.join("")).toContain("tui.query")
  expect(one.out.join("")).not.toContain("session.send")
  const missing = fake()
  expect(await runAutomation(parsed("generate", "--entry", "command:nope"), missing.deps)).toBe(1)
  expect(missing.err.join("")).toContain("unknown entry")
})

test("generate rejects --index/--entry combined with each other or another backend", () => {
  for (const args of [["generate", "--index", "--entry", "x"], ["generate", "--httpapi", "--index"], ["generate", "--entry"]]) expect(parseAutomation(args).ok).toBe(false)
})

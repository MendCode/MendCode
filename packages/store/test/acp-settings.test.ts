import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAcpSettings } from "../src/acp-settings"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function withAgents() {
  const dir = mkdtempSync(join(tmpdir(), "acp-settings-"))
  dirs.push(dir)
  writeFileSync(join(dir, "acp-agents.json"), JSON.stringify({ opencode: { command: "opencode", args: ["acp"] }, gemini: { command: "gemini", args: ["--acp"], env: { GEMINI_API_KEY: "secret" } } }))
  return { dir, acp: createAcpSettings(dir) }
}

test("an agent set to null is removed and the other agents keep their command and env", () => {
  const { dir, acp } = withAgents()
  acp.prepare({ opencode: null })()
  expect(Object.keys(acp.get())).toEqual(["gemini"])
  expect(JSON.parse(readFileSync(join(dir, "acp-agents.json"), "utf8")).gemini.env).toEqual({ GEMINI_API_KEY: "secret" })
})

test("acpAgents null resets the key like any other setting: no agents are left", () => {
  const { acp } = withAgents()
  acp.prepare(null)()
  expect(acp.get()).toEqual({})
})

test("a patch that is not an object says how to add or remove an agent", () => {
  const { acp } = withAgents()
  expect(() => acp.prepare("opencode")).toThrow('{ "<name>": null } removes one')
  expect(() => acp.prepare(["opencode"])).toThrow("acpAgents must be an agent patch")
  expect(Object.keys(acp.get())).toEqual(["opencode", "gemini"])
})

import { expect, test } from "bun:test"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import { COMMAND_SCHEMAS, effectiveSettings, READ_ONLY_COMMANDS } from "@mendcode/protocol"
import type { PackagePort } from "@mendcode/tools"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"
import { packagesTool } from "../src/packages-tool"
import { remoteTurnOptions } from "../src/remote-policy"

function scenario(action: string, approved: boolean, tier: "balanced" | "full" | "minimalist" = "balanced") {
  const calls: string[] = []
  const port: PackagePort = { preview: async () => '{"source":"configured","version":"1.0.0","capabilities":[],"changes":{"overlayKeys":["density"]}}', run: async (request) => { calls.push(request.action); return { ok: true } } }
  const { provider, requests } = scriptedProvider([callTool("tool_search", { query: "packages" }), callTool("packages", { action }), stop("done")])
  const engine = createNativeEngine({ provider, tools: [packagesTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({ tier, experimental: { tool_discovery: false } }), packages: () => port })
  const run = turn({ text: "manage packages", mode: () => "full", answers: approved ? [{ kind: "approve", scope: "once" }] : [{ kind: "deny" }] })
  return { engine, run, requests, calls }
}

test("package schema is absent from initial context even with discovery off, then discoverable", async () => {
  const fixture = scenario("list", true)
  const before = await fixture.engine.contextReport!(fixture.run.input.sessionId)
  expect(JSON.stringify(before)).not.toContain('"name":"packages"')
  await fixture.engine.runTurn(fixture.run.input)
  expect(fixture.requests[0]!.tools.map((tool) => tool.name)).toContain("tool_search")
  expect(fixture.requests[0]!.tools.map((tool) => tool.name)).not.toContain("packages")
  expect(fixture.requests[1]!.tools.map((tool) => tool.name)).toContain("packages")
  expect(fixture.calls).toEqual(["list"])
})

test("every mutation requires the normal approval card even in full mode; denial executes nothing", async () => {
  for (const action of ["install", "enable", "disable", "switch-look", "remove", "new"]) {
    for (const approved of [false, true]) {
      const fixture = scenario(action, approved, "full")
      await fixture.engine.runTurn(fixture.run.input)
      expect(fixture.run.asked).toHaveLength(1)
      expect(JSON.stringify(fixture.run.asked)).toContain("overlayKeys")
      expect(fixture.calls).toEqual(approved ? [action] : [])
    }
  }
})

test("reads need no approval; minimalist and remote turn limits exclude the tool", async () => {
  for (const action of ["list", "info", "search", "check"]) {
    const fixture = scenario(action, false)
    await fixture.engine.runTurn(fixture.run.input)
    expect(fixture.run.asked).toHaveLength(0)
    expect(fixture.calls).toEqual([action])
  }
  const fixture = scenario("list", true, "minimalist")
  await fixture.engine.runTurn(fixture.run.input)
  expect(fixture.requests[0]!.tools.map((tool) => tool.name)).not.toContain("packages")
  expect(fixture.requests[0]!.tools.map((tool) => tool.name)).not.toContain("tool_search")
  expect(fixture.calls).toEqual([])
  expect(remoteTurnOptions()?.excludeTools).toContain("packages")
})

test("safe mode keeps the tool and its discovery out and nothing runs, whatever the tier", async () => {
  for (const safeMode of [false, true]) {
    const calls: string[] = []
    const port: PackagePort = { preview: async () => "{}", run: async (request) => { calls.push(request.action); return { ok: true } } }
    const { provider, requests } = scriptedProvider([callTool("tool_search", { query: "packages" }), callTool("packages", { action: "list" }), stop("done")])
    const engine = createNativeEngine({ provider, tools: [packagesTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => effectiveSettings({ tier: "full" }, { safeMode }), packages: () => port })
    await engine.runTurn(turn({ text: "manage packages", mode: () => "full" }).input)
    const offered = requests.flatMap((request) => request.tools.map((tool) => tool.name))
    expect(offered.includes("packages")).toBe(!safeMode)
    // `tool_search` stays for the auxiliary tools every tier defers; in safe mode it never finds `packages`.
    const search = requests.at(-1)!.messages.find((message) => message.role === "tool" && message.name === "tool_search")
    expect(search?.role === "tool" && search.output.includes('"name":"packages"')).toBe(!safeMode)
    expect(calls).toEqual(safeMode ? [] : ["list"])
  }
})

test("no packages command is a read for a read-only peer", () => {
  const packageCommands = Object.keys(COMMAND_SCHEMAS).filter((type) => type.startsWith("packages."))
  expect(packageCommands.length).toBeGreaterThan(10)
  for (const type of packageCommands) expect(READ_ONLY_COMMANDS as readonly string[]).not.toContain(type)
})

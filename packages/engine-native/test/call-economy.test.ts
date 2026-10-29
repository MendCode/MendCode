import { describe, expect, test } from "bun:test"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createNativeEngine, memoryHistory } from "../src"
import { compactToolSchema } from "../src/tool-schema"
import { CONVERSATION, recordLineage } from "./prefix-harness"
import { callTool, ids, scriptedProvider, stop, turn } from "./harness"

describe("round trips: a step may carry several tool calls", () => {
  test("the Responses request allows parallel tool calls and the Messages request no longer forbids them", async () => {
    const responses = await recordLineage({ adapter: "responses", turns: CONVERSATION })
    expect(responses[0]!.body.parallel_tool_calls).toBe(true)
    const anthropic = await recordLineage({ adapter: "anthropic", turns: CONVERSATION })
    expect(anthropic[0]!.body.tool_choice).toEqual({ type: "auto" })
    expect(JSON.stringify(anthropic[0]!.body)).not.toContain("disable_parallel_tool_use")
  })

  test("a step with two calls runs both, in order, and the next request carries both results", async () => {
    for (const adapter of ["responses", "anthropic", "chat"] as const) {
      const calls = await recordLineage({ adapter, turns: CONVERSATION })
      // The first scripted step asks for a `read` and a `grep` at once: the second request answers both.
      const text = JSON.stringify(calls[1]!.body)
      expect(text, adapter).toContain("read src/paginate.ts")
      expect(text, adapter).toContain("grep test")
    }
  })
})

describe("the schema a model is shown", () => {
  const schema = z.object({
    id: z.string().regex(/^[a-z]+$/).min(1).max(40),
    pattern: z.string().describe("a property that happens to be called like a keyword"),
    minimum: z.number().int().min(1).max(10).optional(),
    items: z.array(z.string().min(1)).min(1).max(8).default([]),
    mode: z.enum(["read", "work"]),
    nested: z.object({ limit: z.number().max(100) }).strict().optional(),
  }).strict()

  test("keeps types, enums, required, defaults and descriptions, and drops what only validates", () => {
    const shown = compactToolSchema(z.toJSONSchema(schema)) as Record<string, any>
    expect(JSON.stringify(shown)).not.toMatch(/maxLength|minLength|maxItems|minItems|"maximum"|additionalProperties|\$schema/)
    // `pattern` and `minimum` are property names here, not keywords: they stay, and their own bounds go.
    expect(shown.properties.id).toEqual({ type: "string" })
    expect(shown.properties.minimum).toEqual({ type: "integer" })
    expect(Object.keys(shown.properties)).toEqual(["id", "pattern", "minimum", "items", "mode", "nested"])
    expect(shown.properties.pattern.description).toContain("keyword")
    expect(shown.properties.mode.enum).toEqual(["read", "work"])
    expect(shown.properties.items).toMatchObject({ type: "array", default: [], items: { type: "string" } })
    expect(shown.properties.nested.properties.limit.type).toBe("number")
    expect(shown.required).toEqual(expect.arrayContaining(["id", "pattern", "mode"]))
  })

  test("a call that breaks a dropped bound is still refused by the tool's own schema", async () => {
    const tool = defineTool({ name: "pick", description: "d", permission: "read", args: schema, execute: async () => ({ output: "ran", truncated: false, title: "pick", isError: false }) })
    const { provider, requests } = scriptedProvider([callTool("pick", { id: "x".repeat(41), pattern: "p", mode: "read" }), stop("done")])
    const engine = createNativeEngine({ provider, tools: [tool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s" })
    await engine.runTurn(turn({ text: "go", mode: () => "full" }).input)
    expect(JSON.stringify(requests[0]!.tools.find((spec) => spec.name === "pick"))).not.toContain("maxLength")
    const result = requests[1]!.messages.find((message) => message.role === "tool")
    expect(result).toMatchObject({ role: "tool", isError: true })
  })
})

describe("the compaction trigger counts reasoning once", () => {
  test("output already includes reasoning, so 3 500 tokens of context do not read as 3 900", async () => {
    const sessionId = ids("session")
    const usage = { type: "usage" as const, usage: { input: 1_000, output: 500, reasoning: 400, cacheRead: 2_000, cacheWrite: 0 } }
    const { provider } = scriptedProvider([[{ type: "text", delta: "ok" }, usage, { type: "finish", reason: "stop" }]])
    const engine = createNativeEngine({ provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", compactAtTokens: 3_600 })
    await engine.runTurn(turn({ text: "hi", sessionId }).input)
    expect(engine.needsCompaction?.(sessionId)).toBe(false)
    const second = scriptedProvider([[{ type: "text", delta: "ok" }, { type: "usage", usage: { ...usage.usage, input: 1_200 } }, { type: "finish", reason: "stop" }]])
    const bigger = createNativeEngine({ provider: second.provider, tools: [], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", compactAtTokens: 3_600 })
    await bigger.runTurn(turn({ text: "hi", sessionId }).input)
    expect(bigger.needsCompaction?.(sessionId)).toBe(true)
  })
})

describe("read with several paths keeps every path under the permission rules", () => {
  test("each entry of `paths` is a target of the call, so a rule or the external-directory check on any one applies", async () => {
    const { permissionPatterns, externalPatterns, matchingRule, policyRules } = await import("../src/permission-rules")
    const args = { paths: [{ path: "src/a.ts" }, { path: "config/.env" }, { path: "../outside/x.txt" }] }
    const patterns = permissionPatterns("read", args, "/repo")
    expect(patterns).toEqual(expect.arrayContaining(["/repo/src/a.ts", "/repo/config/.env", "/outside/x.txt"]))
    expect(externalPatterns("read", args, "/repo").some((pattern) => pattern.includes("/outside/"))).toBe(true)
    // The default rule that asks before reading a .env file matches the second entry.
    const rules = policyRules({}, undefined, undefined, undefined)
    expect(patterns.some((pattern) => matchingRule("read", pattern, rules)?.action === "ask")).toBe(true)
  })

  test("each entry of glob's `patterns` is matched against the rules, as the single `pattern` is", async () => {
    const { permissionPatterns, matchingRule } = await import("../src/permission-rules")
    expect(permissionPatterns("glob", { pattern: "src/**/*.ts" }, "/repo")).toEqual(["src/**/*.ts"])
    const patterns = permissionPatterns("glob", { pattern: "src/**/*.ts", patterns: ["test/**/*.ts", "secrets/**"] }, "/repo")
    expect(patterns).toEqual(["src/**/*.ts", "test/**/*.ts", "secrets/**"])
    expect(permissionPatterns("glob", { patterns: ["secrets/**"] }, "/repo")).toEqual(["secrets/**"])
    const rules = [{ permission: "glob", pattern: "*", action: "allow" as const }, { permission: "glob", pattern: "secrets/*", action: "deny" as const }]
    expect(patterns.map((pattern) => matchingRule("glob", pattern, rules)?.action)).toEqual(["allow", "allow", "deny"])
    // With a directory the call is still judged by that directory, exactly as before.
    expect(permissionPatterns("glob", { patterns: ["**/*.ts"], path: "src" }, "/repo")).toEqual(expect.arrayContaining(["/repo/src"]))
  })
})

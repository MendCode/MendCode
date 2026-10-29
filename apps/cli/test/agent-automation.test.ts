import { describe, expect, test } from "bun:test"
import { AGENT_CREATE_PERMISSIONS } from "@mendcode/protocol/wire"
import { parseAutomation, runAutomation, helpText } from "../src/automation"
import { completionScript } from "../src/support-output"
import { CATALOG_MODELS, catalogHarness, catalogPromptHarness } from "./catalog-harness"
import { textWidth } from "../src/view/wrap"

describe("B66 agent CLI parsing", () => {
  test("all creation flags, aliases, data directory and JSON are independent", () => {
    expect(parseAutomation(["--data-dir", "/tmp/data", "agent", "create", "--path", "./config", "--description", "Review diffs", "--mode", "primary", "--tools", "read,grep", "-m", "chatgpt/gpt-6-luna", "--name", "reviewer", "--json"])).toMatchObject({ ok: true, command: { kind: "agent.create", dir: "/tmp/data", path: "./config", description: "Review diffs", mode: "primary", permissions: ["read", "grep"], model: "chatgpt/gpt-6-luna", name: "reviewer", json: true } })
    expect(parseAutomation(["agent", "create", "--permissions="])).toMatchObject({ command: { permissions: [...AGENT_CREATE_PERMISSIONS] } })
    expect(parseAutomation(["agent", "list", "--format=json"])).toMatchObject({ command: { kind: "agent.list", json: true } })
    expect(parseAutomation(["debug", "agent", "reviewer", "--tool", "read", "--params", '{"path":"docs/agents.md"}'])).toMatchObject({ command: { kind: "agent.debug", tool: "read", params: { path: "docs/agents.md" } } })
    expect(parseAutomation(["agent", "--help"])).toMatchObject({ command: { kind: "help", topic: "agent" } })
    expect(helpText("agent")).toContain("agent create")
    expect(completionScript("bash")).toContain("agent) words='create list'")
    expect(parseAutomation(["debug", "rg", "tree"]).ok).toBe(true)
  })
  test("invalid creation/debug arguments fail before any daemon mutation", () => {
    for (const args of [
      ["agent"], ["agent", "list", "extra"], ["agent", "list", "--model", "a/b"],
      ["agent", "create", "--mode", "unknown"], ["agent", "create", "--permissions", "secret"],
      ["agent", "create", "--permissions", "read", "--tools", "read"], ["agent", "create", "--name", "../escape"],
      ["agent", "create", "--name", "build"], ["agent", "create", "--description", ""], ["agent", "create", "--path", ""],
      ["agent", "create", "--model", "bad"], ["agent", "create", "--unknown"], ["agent", "create", "--json=maybe"],
      ["debug", "agent"], ["debug", "agent", "reviewer", "--params", "{}"],
      ["debug", "agent", "reviewer", "--tool", "read", "--params", "null"],
      ["debug", "agent", "reviewer", "--tool", "read", "--params", "[]"],
      ["debug", "agent", "reviewer", "--tool", "read", "--params", "{"],
    ]) expect(parseAutomation(args).ok).toBe(false)
  })
})

describe("B66 agent automation factories", () => {
  test("wizard asks only missing fields, then sends one write with the chosen permissions", async () => {
    const h = catalogHarness({ prompts: ["project", "Review diffs", "read,grep", "all"], send: () => ({ ok: true, result: { file: "/work/catalog/.mendcode/agents/review-diffs.md", generation: "deterministic", callsProviders: false } }) })
    expect(await h.run(["agent", "create"])).toBe(0)
    expect(h.prompts.map((prompt) => prompt.label)).toEqual(["Location", "Description", "Permissions", "Agent mode"])
    expect(h.prompts[2]).toMatchObject({ multiple: true, initial: AGENT_CREATE_PERMISSIONS.join(",") })
    expect(h.sent).toEqual([{ type: "agent.create", directory: "/work/catalog", scope: "project", name: "review-diffs", description: "Review diffs", permissions: ["read", "grep"], mode: "all" }])
    expect(h.out.join("")).toBe("/work/catalog/.mendcode/agents/review-diffs.md\n")
  })
  test("fully explicit creation resolves path and catalog model without invoking the wizard", async () => {
    const h = catalogHarness({ prompts: [] })
    expect(await h.run(["agent", "create", "--path", "./config", "--description", "Review", "--mode", "subagent", "--permissions", "read", "--model", "openrouter/google/gemini-3-pro", "--json"])).toBe(0)
    expect(h.prompts).toEqual([])
    expect(h.sent.at(-1)).toMatchObject({ type: "agent.create", path: "/work/catalog/config", model: "openrouter:google/gemini-3-pro", mode: "subagent", permissions: ["read"] })
    expect(JSON.parse(h.out[0]!)).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", command: "agent.create" })
  })
  test("--generate leaves the identifier to the model, keeps an explicit --name, and warns on fallback", async () => {
    expect(parseAutomation(["agent", "create", "--generate"])).toMatchObject({ ok: true, command: { kind: "agent.create", generate: true } })
    expect(parseAutomation(["agent", "create"])).not.toHaveProperty("command.generate")
    expect(parseAutomation(["agent", "list", "--generate"]).ok).toBe(false)
    const h = catalogHarness({ prompts: [], send: (command) => ({ ok: true, result: command.type === "models.list" ? CATALOG_MODELS : { file: "/work/catalog/config/agents/x.md", generation: "deterministic", callsProviders: true, fallback: "Generation failed: boom" } }) })
    expect(await h.run(["agent", "create", "--path", "./config", "--description", "Review diffs", "--mode", "all", "--permissions", "read", "--generate", "--model", "openrouter/google/gemini-3-pro"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "agent.create", generate: true, model: "openrouter:google/gemini-3-pro", description: "Review diffs" })
    expect(h.sent.at(-1)).not.toHaveProperty("name")
    expect(h.err.join("")).toContain("warning: Generation failed: boom; wrote the plain template")
    expect(await h.run(["agent", "create", "--path", "./config", "--description", "Review diffs", "--mode", "all", "--permissions", "read", "--generate", "--name", "mine"])).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ generate: true, name: "mine" })
  })
  test("cancellation at any step, noninteractive gaps and remote writes leave files untouched", async () => {
    for (let step = 0; step < 4; step++) {
      const h = catalogHarness({ prompts: [...["project", "Review", "read", "all"].slice(0, step), undefined] })
      expect(await h.run(["agent", "create"])).toBe(2)
      expect(h.sent).toEqual([])
      expect(h.err.join("")).toContain("Cancelled")
    }
    const h = catalogHarness()
    expect(await h.run(["agent", "create"])).toBe(64)
    expect(h.sent).toEqual([])
    const parsed = parseAutomation(["debug", "agent", "build"])
    if (parsed.ok !== true) throw new Error("parse failed")
    expect(await runAutomation(parsed.command, { ...h.deps, allowFiles: false })).toBe(64)
    expect(h.sent).toEqual([])
  })
  test("list prints builtins first, permission rules and trust; debug tool failure exits nonzero", async () => {
    const h = catalogHarness({ send: (command) => ({ ok: true, result: command.type === "agents.list" ? { directory: "/work/catalog", problems: [{ file: "bad.md", message: "description required" }], agents: [
      { name: "reviewer", mode: "all", source: "project", trusted: false, permissionRules: [{ permission: "edit", pattern: "*", action: "deny" }] },
      { name: "plan", mode: "primary", source: "builtin", trusted: true }, { name: "build", mode: "primary", source: "builtin", trusted: true },
    ] } : { agent: { name: "build" }, tools: { read: true }, tool: "read", input: {}, result: { output: "Missing file", isError: true } } }) })
    expect(await h.run(["agent", "list"])).toBe(0)
    expect(h.out[0]).toStartWith("build (primary)\n")
    expect(h.out[0]).toContain("reviewer (all) [untrusted]")
    expect(h.out[0]).toContain('"action":"deny"')
    expect(await h.run(["debug", "agent", "build", "--tool", "read"])).toBe(1)
    expect(h.sent.at(-1)).toEqual({ type: "agent.debug", directory: "/work/catalog", name: "build", tool: "read" })
  })
})

describe("B66 wizard app harness", () => {
  test("space toggles permissions; navigation never submits; empty selection is valid", () => {
    const h = catalogPromptHarness({ title: "Create agent", label: "Permissions", multiple: true, initial: "read,edit", options: [{ value: "read", label: "read" }, { value: "edit", label: "edit" }] })
    h.app.key(" ")
    expect(h.finished()).toBe(false)
    expect(h.text().join("\n")).toContain("[ ] read")
    h.app.key("\x1b[B")
    h.app.key(" ")
    h.app.key("\r")
    expect(h.value()).toBe("")
  })
  test("initial mode is selected and Escape cancels", () => {
    const h = catalogPromptHarness({ title: "Create agent", label: "Mode", initial: "all", options: [{ value: "primary", label: "Primary" }, { value: "all", label: "All" }] })
    expect(h.text().join("\n")).toContain("› All")
    h.app.key("\x1b")
    expect(h.finished()).toBe(true)
    expect(h.value()).toBeUndefined()
  })
  test("wizard rows fit every required terminal size, with header hints and input cursor", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const h = catalogPromptHarness({ title: "Create agent", label: "Permissions", multiple: true, initial: "read", options: AGENT_CREATE_PERMISSIONS.map((value) => ({ value, label: value })) }, width, height)
      for (let i = 0; i < 20; i++) h.app.key("\x1b[B")
      expect(h.text()).toHaveLength(height!)
      expect(h.text().every((row) => textWidth(row) === width)).toBe(true)
      expect(h.text()[0]).toContain("space toggle")
      expect(h.text().join("\n")).toContain("skill")
      const input = catalogPromptHarness({ title: "Create agent", label: "Description", initial: "Review diffs" }, width, height)
      expect(input.cursor()?.row).toBe(4)
      expect(input.cursor()!.col).toBeLessThan(width!)
    }
  })
})

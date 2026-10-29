import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, MODEL_ROLES, type ModelInfo, type ModelsReport } from "@mendcode/protocol"
import { startDaemon, type DaemonOptions } from "../src"
import { CLAUDE_COMPACT_WINDOW, claudeCompactEnv, claudeSubagentEnv } from "../src/claude-models"
import { invalidChoice, resolveModel, type ModelCatalog } from "../src/models"

const MODELS: ModelInfo[] = [
  { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 },
  { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  { id: "plain", name: "Plain", efforts: [] },
]
const catalog: ModelCatalog = { selectable: true, list: () => MODELS, defaults: { model: "gpt-6-luna", effort: "low" } }

describe("resolveModel", () => {
  test("ACP prefix models run main only and never leak into native auxiliary roles", () => {
    const external: ModelCatalog = { ...catalog, list: () => [...MODELS, { id: "acp:local", name: "Local ACP", efforts: [] }] }
    const choice = { model: "acp:local" }
    expect(invalidChoice(choice, external, "main")).toBeUndefined()
    expect(resolveModel({ role: "main", session: choice, roles: {}, catalog: external })).toEqual(choice)
    for (const role of MODEL_ROLES.filter((item) => item !== "main")) {
      expect(invalidChoice(choice, external, role)).toContain("through ACP")
      expect(resolveModel({ role, session: choice, roles: { main: choice, [role]: choice, small: choice }, catalog: external })).toEqual(external.defaults)
    }
  })
  test("cheap_subagents: a session on a large model delegates to its provider's mid tier; a set subagent role, a small session or the switch off keep today's choice", () => {
    const keyed: ModelCatalog = { ...catalog, list: () => [
      ...MODELS,
      { id: "anthropic:claude-opus-5-5", name: "Opus", efforts: [], provider: "anthropic" },
      { id: "anthropic:claude-haiku-5-5", name: "Haiku", efforts: [], provider: "anthropic" },
      { id: "anthropic:claude-sonnet-5-5", name: "Sonnet", efforts: [], provider: "anthropic" },
      { id: "google:gemini-3-pro", name: "Gemini Pro", efforts: [], provider: "google" },
      { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: [], engine: "claude" },
    ] }
    const sub = (session: string, roles = {}, cheapSubagent = true) => resolveModel({ role: "subagent", session: { model: session }, roles, catalog: keyed, cheapSubagent }).model
    expect(sub("gpt-6-sol")).toBe("gpt-6-luna")
    expect(sub("anthropic:claude-opus-5-5")).toBe("anthropic:claude-sonnet-5-5")
    // No cheaper model of the same provider: the session's own.
    expect(sub("google:gemini-3-pro")).toBe("google:gemini-3-pro")
    expect(sub("gpt-6-luna")).toBe("gpt-6-luna")
    expect(sub("anthropic:claude-haiku-5-5")).toBe("anthropic:claude-haiku-5-5")
    expect(sub("gpt-6-sol", { subagent: { model: "plain" } })).toBe("plain")
    expect(sub("gpt-6-sol", {}, false)).toBe("gpt-6-sol")
    // Other roles never take it.
    expect(resolveModel({ role: "compaction", session: { model: "gpt-6-sol" }, roles: {}, catalog: keyed, cheapSubagent: true }).model).toBe("gpt-6-sol")
  })

  test("Claude Code's sub-agents: the subagent role when it is a Claude model, else Sonnet under Opus or Fable; never over the daemon's own variable", () => {
    expect(claudeSubagentEnv({ model: "opus", subagent: undefined, cheap: true })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" })
    expect(claudeSubagentEnv({ model: "claude-fable-5-1", subagent: undefined, cheap: true })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" })
    expect(claudeSubagentEnv({ model: "sonnet", subagent: undefined, cheap: true })).toBeUndefined()
    expect(claudeSubagentEnv({ model: "opus", subagent: undefined, cheap: false })).toBeUndefined()
    expect(claudeSubagentEnv({ model: "opus", subagent: { model: "claude-haiku" }, cheap: false })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku" })
    expect(claudeSubagentEnv({ model: "opus", subagent: { model: "gpt-6-luna" }, cheap: true })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" })
    expect(claudeSubagentEnv({ model: "opus", subagent: { model: "claude-haiku" }, cheap: true, inherited: "opus" })).toBeUndefined()
  })

  test("claude_compact: Claude Code compacts at MendCode's absolute point, else 200k; off, or a window the daemon already has, passes nothing", () => {
    const window = (input: Partial<Parameters<typeof claudeCompactEnv>[0]>) => claudeCompactEnv({ model: "opus", settings: {}, on: true, environment: {}, ...input })?.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    expect(window({})).toBe(String(CLAUDE_COMPACT_WINDOW))
    expect(window({ settings: { compactAtTokens: 450_000 } })).toBe("450000")
    expect(window({ settings: { compaction: { token_limit: 300_000 } } })).toBe("300000")
    expect(window({ settings: { compactAtTokens: 450_000 }, environment: { MENDCODE_COMPACT_AT_TOKENS: "120000" } })).toBe("120000")
    expect(window({ on: false })).toBeUndefined()
    expect(window({ environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" } })).toBeUndefined()
  })

  test("main: the session's choice, then the main setting, then the default", () => {
    expect(resolveModel({ role: "main", roles: {}, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "main", roles: { main: { model: "gpt-6-sol", effort: "high" } }, catalog })).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(resolveModel({ role: "main", session: { model: "gpt-6-luna", effort: "medium" }, roles: { main: { model: "gpt-6-sol" } }, catalog })).toEqual({ model: "gpt-6-luna", effort: "medium" })
  })
  test("other roles use their own setting, else follow what main resolves to for the session", () => {
    const roles = { compaction: { model: "gpt-6-luna", effort: "low" as const } }
    expect(resolveModel({ role: "compaction", session: { model: "gpt-6-sol", effort: "xhigh" }, roles, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "subagent", session: { model: "gpt-6-sol", effort: "xhigh" }, roles, catalog })).toEqual({ model: "gpt-6-sol", effort: "xhigh" })
    expect(resolveModel({ role: "dream", roles: { main: { model: "gpt-6-sol" } }, catalog })).toEqual({ model: "gpt-6-sol", effort: "medium" })
  })
  test("a missing or unsupported effort becomes the model's default; a model without efforts gets none", () => {
    expect(resolveModel({ role: "main", session: { model: "gpt-6-luna", effort: "xhigh" }, roles: {}, catalog })).toEqual({ model: "gpt-6-luna", effort: "medium" })
    expect(resolveModel({ role: "main", session: { model: "plain", effort: "high" }, roles: {}, catalog })).toEqual({ model: "plain", effort: "high" })
    expect(resolveModel({ role: "main", session: { model: "plain" }, roles: {}, catalog })).toEqual({ model: "plain" })
  })
  test("a model gone from the catalog is passed through unchanged (the backend decides)", () => {
    expect(resolveModel({ role: "main", session: { model: "retired", effort: "low" }, roles: {}, catalog })).toEqual({ model: "retired", effort: "low" })
  })
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-models-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "models" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir })
  const sessionId = (created.ok ? created.result : undefined) as { sessionId: string }
  return { client, sessionId: sessionId.sessionId as never }
}

const report = (reply: { ok: boolean; result?: unknown }) => (reply.ok ? reply.result : undefined) as ModelsReport

describe("models.list and session.model.set", () => {
  test("lists the catalog with the effective model; a session choice is kept, applied and cleared", async () => {
    const { client, sessionId } = await boot({ models: catalog })
    const before = report(await client.send({ type: "models.list", sessionId }))
    expect(before.models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6-sol", "plain"])
    expect(before.selectable).toBe(true)
    expect(before.session).toBeUndefined()
    expect(before.effective).toEqual({ model: "gpt-6-luna", effort: "low" })
    const set = report(await client.send({ type: "session.model.set", sessionId, choice: { model: "gpt-6-sol", effort: "high" } }))
    expect(set.session).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(set.effective).toEqual({ model: "gpt-6-sol", effort: "high" })
    expect(report(await client.send({ type: "models.list", sessionId })).session).toEqual({ model: "gpt-6-sol", effort: "high" })
    const cleared = report(await client.send({ type: "session.model.set", sessionId, choice: null }))
    expect(cleared.session).toBeUndefined()
    expect(cleared.effective).toEqual({ model: "gpt-6-luna", effort: "low" })
  })
  test("role settings show up in the report and in the effective model", async () => {
    const { client, sessionId } = await boot({ models: catalog })
    await client.send({ type: "settings.set", patch: { models: { main: { model: "gpt-6-sol" }, compaction: { model: "gpt-6-luna", effort: "low" } } } })
    const listed = report(await client.send({ type: "models.list", sessionId }))
    expect(listed.roles).toEqual({ main: { model: "gpt-6-sol" }, compaction: { model: "gpt-6-luna", effort: "low" } })
    expect(listed.effective).toEqual({ model: "gpt-6-sol", effort: "medium" })
  })
  test("unknown models, unsupported efforts and engines without a choice are refused; nothing is stored", async () => {
    const { client, sessionId } = await boot({ models: catalog })
    const unknown = await client.send({ type: "session.model.set", sessionId, choice: { model: "nope" } })
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    const effort = await client.send({ type: "session.model.set", sessionId, choice: { model: "gpt-6-luna", effort: "xhigh" } })
    expect(effort.ok ? "" : effort.error.message).toContain("gpt-6-luna supports low, medium, high")
    expect(report(await client.send({ type: "models.list", sessionId })).session).toBeUndefined()
    const fixed = await boot()
    const refused = await fixed.client.send({ type: "session.model.set", sessionId: fixed.sessionId, choice: { model: "gpt-6-luna" } })
    expect(refused.ok ? "" : refused.error.message).toContain("this engine chooses its own model")
    expect(report(await fixed.client.send({ type: "models.list" }))).toMatchObject({ selectable: false, models: [] })
  })
  test("an unknown session is an error", async () => {
    const { client } = await boot({ models: catalog })
    expect(await client.send({ type: "models.list", sessionId: createIdFactory()("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})

describe("catalog ids a model writes", () => {
  test("a model named without its provider is the one id it can mean; two providers stay ambiguous", async () => {
    const { catalogId, nearModels } = await import("../src/models")
    const row = (id: string) => ({ id, name: id, efforts: [] }) as unknown as ModelInfo
    const catalog = { selectable: true, defaults: { model: "chatgpt/gpt-6-astra" }, list: () => [row("chatgpt/gpt-6-astra"), row("chatgpt/gpt-6.1-terra"), row("openai/gpt-6-luna"), row("azure/gpt-6-luna")] }
    expect(catalogId(catalog, "gpt-6.1-terra")).toBe("chatgpt/gpt-6.1-terra")
    expect(catalogId(catalog, "GPT-6.1-Terra")).toBe("chatgpt/gpt-6.1-terra")
    expect(catalogId(catalog, "chatgpt/gpt-6-astra")).toBe("chatgpt/gpt-6-astra")
    expect(catalogId(catalog, "gpt-6-luna")).toBeUndefined()
    expect(catalogId(catalog, "terra")).toBeUndefined()
    expect(nearModels(catalog, "terra-6.1")).toEqual(["chatgpt/gpt-6.1-terra"])
    expect(nearModels(catalog, "zzz")).toEqual([])
  })
})

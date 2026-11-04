import { expect, test } from "bun:test"
import type { ModelInfo, SessionId, Settings } from "@mendcode/protocol"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { advisorDiff, advisorReport, advisorStatus, claudeAdvisorAlias, createAdvisorHost } from "../src/advisor-host"

const models: ModelInfo[] = [
  { id: "gpt-6-luna", name: "Luna", efforts: ["low", "medium", "high"] },
  { id: "gpt-6.1-sol", name: "Sol", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "openai:gpt-6.1-sol", name: "Sol API", provider: "openai", efforts: ["high"] },
  { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", engine: "claude", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-6-codex", name: "Codex", engine: "codex", efforts: [] },
]
const catalog = { selectable: true, list: () => models, defaults: { model: "gpt-6-luna" } }
const status = (settings: Settings, main: { model: string; effort?: "high" }) => advisorStatus({ settings, roles: settings.models ?? {}, main, catalog })
const session = "ses_advisor_host" as SessionId

test("no advisor role is off; a different native model applies to a native session", () => {
  expect(status({}, { model: "gpt-6-luna" })).toBeUndefined()
  expect(advisorReport(undefined, {})).toBe("off")
  const applied = status({ models: { advisor: { model: "gpt-6.1-sol", effort: "high" } }, advisor: { checkpoints: ["completion"] } }, { model: "gpt-6-luna" })
  expect(applied).toEqual({ choice: { model: "gpt-6.1-sol", effort: "high" }, applied: true, engine: "native" })
  expect(advisorReport(applied, { advisor: { checkpoints: ["completion"] } })).toEqual({ model: "gpt-6.1-sol", effort: "high", checkpoints: ["completion"], applied: true })
})

test("the advisor does not apply, with the reason, when it cannot help or cannot run", () => {
  const reason = (settings: Settings, main: { model: string; effort?: "high" }) => { const result = status(settings, main); return result && !result.applied ? result.reason : undefined }
  expect(reason({ models: { advisor: { model: "gpt-6-luna" } } }, { model: "gpt-6-luna" })).toContain("same model")
  expect(reason({ models: { advisor: { model: "gpt-6.1-sol" } }, tier: "minimalist" }, { model: "gpt-6-luna" })).toContain("feature is off")
  expect(reason({ models: { advisor: { model: "nope" } } }, { model: "gpt-6-luna" })).toContain("unknown model")
  expect(reason({ models: { advisor: { model: "gpt-6-codex" } } }, { model: "gpt-6-luna" })).toContain("needs an API, ChatGPT or Claude Code model")
  expect(reason({ models: { advisor: { model: "gpt-6.1-sol" } } }, { model: "claude-sonnet" })).toContain("only take a Claude Code model")
  expect(reason({ models: { advisor: { model: "gpt-6.1-sol" } } }, { model: "gpt-6-codex" })).toContain("codex engine has no advisor")
})

test("a Claude Code session with a Claude Code advisor gets the --advisor alias", () => {
  const applied = status({ models: { advisor: { model: "claude-opus" } } }, { model: "claude-sonnet" })
  expect(applied).toMatchObject({ applied: true, engine: "claude" })
  expect(claudeAdvisorAlias(applied)).toBe("opus")
  expect(claudeAdvisorAlias(status({ models: { advisor: { model: "gpt-6.1-sol" } } }, { model: "gpt-6-luna" }))).toBeUndefined()
})

test("the host consults only natively applied advisors, and a refused budget is a budget verdict", async () => {
  let settings: Settings = { models: { advisor: { model: "gpt-6.1-sol" } } }
  const prompts: string[] = []
  const host = createAdvisorHost({
    status: () => status(settings, { model: "gpt-6-luna" }),
    settings: () => settings,
    guard: async ({ model }) => { if (model === "blocked") throw new Error("Spending stop reached") },
    complete: async ({ prompt }) => (prompts.push(prompt), { text: '{"verdict":"proceed","summary":"ok"}', usage: { provider: "chatgpt", model: "gpt-6.1-sol", input: 10, output: 2 } }),
  })
  expect(host.enabled(session)).toBe(true)
  expect(host.limits(session).maxCallsPerTurn).toBe(3)
  expect(await host.consult({ sessionId: session, trigger: "tool", brief: "brief", signal: new AbortController().signal })).toMatchObject({ verdict: { verdict: "proceed" }, usage: { input: 10 } })
  expect(prompts).toEqual(["brief"])
  settings = { models: { advisor: { model: "gpt-6-codex" } } }
  expect(host.enabled(session)).toBe(false)

  const blocked = createAdvisorHost({ status: () => ({ choice: { model: "blocked" }, applied: true, engine: "native" }), settings: () => ({}), guard: async () => { throw new Error("Spending stop reached") }, complete: async () => ({ text: "" }) })
  expect((await blocked.consult({ sessionId: session, trigger: "tool", brief: "b", signal: new AbortController().signal })).verdict).toMatchObject({ fallback: "budget" })
})

test("a Claude Code advisor applies to a native session and its consultations go through the claude path, not the API completion", async () => {
  const applied = status({ models: { advisor: { model: "claude-opus", effort: "high" } } }, { model: "gpt-6-luna" })
  expect(applied).toEqual({ choice: { model: "claude-opus", effort: "high" }, applied: true, engine: "native" })
  expect(claudeAdvisorAlias(applied)).toBeUndefined()
  const routed: string[] = []
  const host = createAdvisorHost({
    status: () => applied,
    settings: () => ({}),
    guard: async () => {},
    complete: async () => { routed.push("api"); return { text: "{}" } },
    claude: {
      isClaude: (model) => model.model.startsWith("claude-"),
      complete: async ({ model }) => (routed.push(`claude:${model.model}`), { text: '{"verdict":"revise","summary":"fix it"}', account: "Claude subscription", usage: { provider: "claude", model: "claude-opus-5-5", input: 40, output: 9 } }),
    },
  })
  const consulted = await host.consult({ sessionId: session, trigger: "tool", brief: "brief", signal: new AbortController().signal })
  expect(routed).toEqual(["claude:claude-opus"])
  expect(consulted).toMatchObject({ verdict: { verdict: "revise" }, account: "Claude subscription", usage: { provider: "claude", input: 40, output: 9 } })
})

test("the working-tree diff names untracked files, which git diff never shows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "advisor-diff-"))
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
    git("init", "-q")
    writeFileSync(join(dir, "tracked.txt"), "one\n")
    git("add", ".")
    git("commit", "-qm", "init")
    writeFileSync(join(dir, "tracked.txt"), "two\n")
    writeFileSync(join(dir, "new-page.html"), "<p>hi</p>\n")
    const diff = await advisorDiff(dir, new AbortController().signal)
    expect(diff).toContain("+two")
    expect(diff).toContain("Untracked files, not part of the diff above (1): new-page.html")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("an advisor model takes images only when the catalog says so and it is not a Claude Code model", () => {
  const host = (accepts: boolean, claude: boolean) => createAdvisorHost({
    status: () => ({ choice: { model: "gpt-6.1-sol" }, applied: true, engine: "native" }), settings: () => ({}) as Settings, guard: async () => {},
    acceptsImages: () => accepts, complete: async () => ({ text: "{}" }),
    ...(claude ? { claude: { isClaude: () => true, complete: async () => ({ text: "{}" }) } } : {}),
  })
  expect(host(true, false).acceptsImages?.(session)).toBe(true)
  expect(host(false, false).acceptsImages?.(session)).toBe(false)
  expect(host(true, true).acceptsImages?.(session)).toBe(false)
})

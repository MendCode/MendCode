import { describe, expect, test } from "bun:test"
import { createIdFactory, type ModelInfo, type SessionId } from "@mendcode/protocol"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CLAUDE_MODELS, claudeAlias, createClaudeModelCatalog } from "../src/claude-models"
import { createEngineRouter } from "../src/engine-router"
import { catalogModel, invalidChoice, modelEngine, resolveModel, usableEffort, type ModelCatalog } from "../src/models"
import { withAcpEngine } from "../../engine-acp/src/router"

const ids = createIdFactory()
const NATIVE: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" }]
const catalog: ModelCatalog = { selectable: true, list: () => [...NATIVE, ...CLAUDE_MODELS], defaults: { model: "gpt-6-luna", effort: "low" } }

describe("Claude Code models in the catalog", () => {
  test("a Claude model drives main; every other role skips it and falls back to a native model", () => {
    const roles = { main: { model: "claude-opus", effort: "high" as const } }
    expect(resolveModel({ role: "main", roles, catalog })).toEqual({ model: "claude-opus", effort: "high" })
    expect(modelEngine(resolveModel({ role: "main", roles, catalog }), catalog)).toBe("claude")
    expect(resolveModel({ role: "dream", roles, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "compaction", session: { model: "claude-sonnet" }, roles: {}, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(resolveModel({ role: "subagent", session: { model: "claude-sonnet" }, roles: { subagent: { model: "gpt-6-luna", effort: "high" } }, catalog })).toEqual({ model: "gpt-6-luna", effort: "high" })
    expect(modelEngine({ model: "gpt-6-luna" }, catalog)).toBeUndefined()
  })

  test("Claude models are refused for roles other than main", () => {
    expect(invalidChoice({ model: "claude-opus" }, catalog)).toBeUndefined()
    expect(invalidChoice({ model: "claude-opus" }, catalog, "dream")).toBe("claude-opus runs whole sessions through Claude Code; use it for main")
    expect(invalidChoice({ model: "claude-haiku", effort: "high" }, catalog)).toBeUndefined()
  })

  test("a variant of a Claude model names one of its efforts and becomes that effort; anything else is refused", () => {
    expect(invalidChoice({ model: "claude-opus", variant: "high" }, catalog)).toBeUndefined()
    expect(invalidChoice({ model: "claude-opus", variant: "turbo" }, catalog)).toBe("unknown variant turbo for claude-opus; use low, medium, high, xhigh")
    expect(invalidChoice({ model: "claude-haiku", variant: "high" }, catalog)).toBe("claude-haiku does not support provider variants")
    expect(invalidChoice({ model: "claude-opus", parameters: { temperature: 1 } as never }, catalog)).toBe("claude-opus does not support provider variants")
    expect(usableEffort({ model: "claude-opus", variant: "xhigh" }, catalog)).toEqual({ model: "claude-opus", effort: "xhigh" })
    expect(claudeAlias(usableEffort({ model: "claude-opus", variant: "low" }, catalog))).toEqual({ model: "opus", effort: "low" })
  })

  test("ids map to the CLI's aliases", () => {
    expect(claudeAlias({ model: "claude-opus", effort: "xhigh" })).toEqual({ model: "opus", effort: "xhigh" })
    expect(claudeAlias({ model: "claude-haiku" })).toEqual({ model: "haiku" })
  })

  test("the user's Claude Code effortLevel is the default of the models that support it, pinned ids included; without a usable level they carry none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-settings-"))
    const file = path.join(dir, "settings.json")
    const defaults = (list: ModelInfo[]) => list.map((model) => model.defaultEffort)
    try {
      expect(defaults(createClaudeModelCatalog(file)())).toEqual([undefined, undefined, undefined, undefined])
      writeFileSync(file, JSON.stringify({ effortLevel: "high" }))
      const list = createClaudeModelCatalog(file)()
      expect(list.find((model) => model.id === "claude-sonnet")?.defaultEffort).toBe("high")
      expect(list.find((model) => model.id === "claude-haiku")?.defaultEffort).toBeUndefined()
      const withSettings: ModelCatalog = { selectable: true, list: () => list, defaults: { model: "claude-sonnet" } }
      expect(claudeAlias(usableEffort({ model: "claude-sonnet" }, withSettings))).toEqual({ model: "sonnet", effort: "high" })
      expect(claudeAlias(usableEffort({ model: "claude-sonnet-5-5" }, withSettings))).toEqual({ model: "claude-sonnet-5-5", effort: "high" })
      expect(claudeAlias(usableEffort({ model: "claude-sonnet", effort: "low" }, withSettings))).toEqual({ model: "sonnet", effort: "low" })
      // `max` is not a level MendCode has; the setting is then ignored rather than guessed.
      writeFileSync(file, JSON.stringify({ effortLevel: "max" }))
      expect(defaults(createClaudeModelCatalog(file)())).toEqual([undefined, undefined, undefined, undefined])
      writeFileSync(file, "{ not json")
      expect(defaults(createClaudeModelCatalog(file)())).toEqual([undefined, undefined, undefined, undefined])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a full id of a listed family is that family pinned: valid for main, run on Claude Code with the exact id", () => {
    for (const id of ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]) {
      expect(invalidChoice({ model: id }, catalog)).toBeUndefined()
      expect(modelEngine({ model: id }, catalog)).toBe("claude")
      expect(resolveModel({ role: "main", session: { model: id }, roles: {}, catalog })).toEqual({ model: id })
      expect(claudeAlias({ model: id })).toEqual({ model: id })
      expect(invalidChoice({ model: id }, catalog, "dream")).toBe(`${id} runs whole sessions through Claude Code; use it for main`)
      expect(resolveModel({ role: "compaction", session: { model: id }, roles: {}, catalog })).toEqual({ model: "gpt-6-luna", effort: "low" })
    }
    expect(catalogModel(catalog, "claude-haiku-5-5")).toEqual({ id: "claude-haiku-5-5", name: "Claude Haiku 5.5 · Claude Code", efforts: [], contextWindow: 200_000, engine: "claude" })
    expect(catalogModel(catalog, "claude-haiku-4-5-20251001")?.name).toBe("Claude Haiku 4.5 (20251001) · Claude Code")
    // The family's efforts apply to the pinned model.
    expect(usableEffort({ model: "claude-opus-5-5", variant: "xhigh" }, catalog)).toEqual({ model: "claude-opus-5-5", effort: "xhigh" })
    expect(invalidChoice({ model: "claude-haiku-5-5", variant: "high" }, catalog)).toBe("claude-haiku-5-5 does not support provider variants")
  })

  test("an id that is not a version of a listed family stays unknown", () => {
    for (const id of ["claude-nonsense", "claude-haiku-nonsense", "claude-haiku-", "claude-haiku-5-5-extra", "claude-3-5-haiku-20241022", "anthropic:claude-haiku-5-5", "claude-haiku-5-5 --dangerously-skip-permissions"]) {
      expect(invalidChoice({ model: id }, catalog)).toBe(`unknown model ${id}`)
      expect(modelEngine({ model: id }, catalog)).toBeUndefined()
    }
    // Without Claude Code installed its families are not listed, so their full ids are unknown too.
    expect(invalidChoice({ model: "claude-haiku-5-5" }, { ...catalog, list: () => NATIVE })).toBe("unknown model claude-haiku-5-5")
  })
})

function recordingEngine(name: string, calls: string[], extra: Partial<EnginePort> = {}): EnginePort {
  return {
    runTurn: async () => (calls.push(`${name}.turn`), { status: "ok" }),
    runShell: async () => (calls.push(`${name}.shell`), { status: "ok" }),
    needsCompaction: () => true,
    compact: async () => (calls.push(`${name}.compact`), { status: "ok" }),
    contextReport: async () => (calls.push(`${name}.context`), {}) as never,
    ...extra,
  }
}

const turn = (sessionId: SessionId) => ({ sessionId }) as TurnInput

describe("engine router", () => {
  test("agent debug stays on native through Claude and ACP routers without loading either provider", async () => {
    const calls: string[] = []
    const primary = recordingEngine("native", calls, { debugAgent: async () => (calls.push("native.debug"), { tools: { read: true } }) })
    const external = async () => { throw new Error("external engine must stay lazy") }
    const router = withAcpEngine({ base: createEngineRouter({ primary, claude: external, usesClaude: () => true }), acp: external, usesAcp: () => true })
    expect(await router.debugAgent!({ directory: "/tmp", sessionId: ids("session"), agent: { name: "build", description: "Build", mode: "primary", source: "builtin", trusted: true, prompt: "Build" } })).toEqual({ tools: { read: true } })
    expect(calls).toEqual(["native.debug"])
  })

  test("each turn goes to the engine of the session's model, read at every turn; Claude Code is created once", async () => {
    const calls: string[] = []
    const claudeSessions = new Set<SessionId>()
    let created = 0
    const router = createEngineRouter({ primary: recordingEngine("native", calls), claude: async () => (created++, recordingEngine("claude", calls)), usesClaude: (sessionId) => claudeSessions.has(sessionId) })
    const a = ids("session")
    await router.runTurn(turn(a))
    claudeSessions.add(a)
    await router.runTurn(turn(a))
    await router.runTurn(turn(a))
    claudeSessions.delete(a)
    await router.runTurn(turn(a))
    expect(calls).toEqual(["native.turn", "claude.turn", "claude.turn", "native.turn"])
    expect(created).toBe(1)
  })

  test("a per-turn model selection routes that turn alone, to Claude Code or back to the native engine", async () => {
    const calls: string[] = []
    const claudeSession = ids("session")
    const router = createEngineRouter({
      primary: recordingEngine("native", calls),
      claude: async () => recordingEngine("claude", calls),
      usesClaude: (sessionId, override) => modelEngine(override ?? (sessionId === claudeSession ? { model: "claude-opus" } : { model: "gpt-6-luna" }), catalog) === "claude",
    })
    const other = ids("session")
    await router.runTurn({ ...turn(other), selection: { model: { model: "claude-sonnet", effort: "low" } } } as TurnInput)
    await router.runTurn(turn(other))
    await router.runTurn({ ...turn(claudeSession), selection: { model: { model: "gpt-6-luna" } } } as TurnInput)
    await router.runTurn(turn(claudeSession))
    expect(calls).toEqual(["claude.turn", "native.turn", "native.turn", "claude.turn"])
  })

  test("Claude sessions never compact on their own on MendCode's side, send /compact to Claude Code, keep shell on the primary, and have no context report", async () => {
    const calls: string[] = []
    const b = ids("session")
    const router = createEngineRouter({ primary: recordingEngine("native", calls), claude: async () => recordingEngine("claude", calls), usesClaude: (sessionId) => sessionId === b })
    expect(router.needsCompaction(b)).toBe(false)
    expect(router.needsCompaction(ids("session"))).toBe(true)
    await router.compact({ sessionId: b } as never)
    await router.runShell!(turn(b))
    await expect(router.contextReport!(b)).rejects.toThrow("Claude Code manages")
    expect(calls).toEqual(["claude.compact", "native.shell"])
  })

  test("a Claude engine that fails to load fails the turn and is retried on the next one", async () => {
    const calls: string[] = []
    let attempts = 0
    const c = ids("session")
    const router = createEngineRouter({
      primary: recordingEngine("native", calls),
      claude: async () => {
        attempts++
        if (attempts === 1) throw new Error("module not found")
        return recordingEngine("claude", calls)
      },
      usesClaude: () => true,
    })
    expect(await router.runTurn(turn(c))).toEqual({ status: "error", code: "claude_unavailable", message: "[CLAUDE]: module not found" })
    expect(await router.runTurn(turn(c))).toEqual({ status: "ok" })
    expect(calls).toEqual(["claude.turn"])
  })
})

test("a sub-agent asked for a Claude Code model is told to pass engine claude, not to look for another provider's copy", () => {
  const catalog = { selectable: true, list: () => [{ id: "claude-opus-5-5", name: "Opus 5.5", engine: "claude", efforts: [] }], defaults: { model: "gpt-6-luna" } } as never
  expect(invalidChoice({ model: "claude-opus-5-5" }, catalog, "subagent")).toBe(`claude-opus-5-5 runs through Claude Code on the user's Claude login; to delegate to it pass engine: "claude" with this exact model (full tier), not another provider's copy of it`)
  expect(invalidChoice({ model: "claude-opus-5-5" }, catalog, "main")).toBeUndefined()
})

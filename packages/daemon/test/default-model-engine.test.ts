import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelInfo, SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import type { ToolContext } from "@mendcode/tools"
import { CLAUDE_MODELS } from "../src/claude-models"
import { catalogId, catalogModel, invalidChoice, modelEngine, resolveModel, unusableRoles, type ModelCatalog } from "../src/models"
import { createSettingsTool, MODEL_ROLES_NOTE, SETTINGS_APPLY } from "../src/settings-tool"
import { boot, callTool, openSession, stop, until, type NativeHarness } from "./native-harness"

const OPUS: ModelInfo = CLAUDE_MODELS.find((model) => model.id === "claude-opus")!
let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const submit = async (harness: NativeHarness, sessionId: SessionId, text: string, turns: number) => {
  expect((await harness.client.send({ type: "user.submit", sessionId, text, attachments: [] })).ok).toBe(true)
  await until(() => harness.store.turns.list(sessionId).length === turns && harness.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
  return harness.store.turns.list(sessionId).at(-1)!.status
}

describe("the default model moves to another engine while a native session runs", () => {
  test("the running turn keeps its model, the session keeps its engine, and only a new session starts on the new default", async () => {
    // The session's first call changes the default to Claude Code Opus, written as `mendcode models` prints it.
    const booted = await boot({
      extraModels: [OPUS],
      steps: [
        async () => {
          expect((await booted.client.send({ type: "settings.set", patch: { models: { main: { model: "claude/claude-opus", effort: "medium" } } } })).ok).toBe(true)
          return callTool("probe", {})
        },
        stop("kept"),
        stop("still native"),
      ],
    })
    h = booted
    const sessionId = await openSession(h)
    expect(await submit(h, sessionId, "make claude opus my default", 1)).toBe("completed")
    // No request with a model of another engine reached the native provider.
    expect(h.requests.map((request) => request.model ?? "script-1")).toEqual(["script-1", "script-1"])
    // The next turn of the same session stays on the native model it ran on.
    expect(await submit(h, sessionId, "and now?", 2)).toBe("completed")
    expect(h.requests.map((request) => request.model ?? "script-1")).toEqual(["script-1", "script-1", "script-1"])
    const listed = await h.client.send({ type: "models.list", sessionId })
    expect(listed.ok && (listed.result as { effective?: { model: string } }).effective?.model).toBe("script-1")
    // A new session starts on the new default, as Claude Code's model id.
    const fresh = await openSession(h)
    const report = await h.client.send({ type: "models.list", sessionId: fresh })
    expect(report.ok && (report.result as { effective?: { model: string; effort?: string } }).effective).toEqual({ model: "claude-opus", effort: "medium" })
  })

  test("/model to a Claude Code model mid-turn applies from the next turn; the rest of the turn stays native", async () => {
    const booted = await boot({
      extraModels: [OPUS],
      steps: [
        async () => {
          expect((await booted.client.send({ type: "session.model.set", sessionId: session!, choice: { model: "claude-opus" } })).ok).toBe(true)
          return callTool("probe", {})
        },
        stop("kept"),
      ],
    })
    h = booted
    const session: SessionId | undefined = await openSession(h)
    expect(await submit(h, session, "switch me", 1)).toBe("completed")
    expect(h.requests.map((request) => request.model ?? "script-1")).toEqual(["script-1", "script-1"])
  })

  test("a session that never ran follows the default; /model back to the default lets a session follow it again", async () => {
    h = await boot({ extraModels: [OPUS], steps: [stop("one")] })
    const waiting = await openSession(h)
    await h.client.send({ type: "settings.set", patch: { models: { main: { model: "gpt-6-luna" } } } })
    const ran = await openSession(h)
    expect(await submit(h, ran, "hi", 1)).toBe("completed")
    expect(h.requests.at(-1)?.model).toBe("gpt-6-luna")
    // A default on the same engine is still followed by a session that ran.
    await h.client.send({ type: "settings.set", patch: { models: { main: { model: "gpt-6-sol" } } } })
    const same = await h.client.send({ type: "models.list", sessionId: ran })
    expect(same.ok && (same.result as { effective?: { model: string } }).effective?.model).toBe("gpt-6-sol")
    await h.client.send({ type: "settings.set", patch: { models: { main: { model: "claude-opus" } } } })
    const untouched = await h.client.send({ type: "models.list", sessionId: waiting })
    expect(untouched.ok && (untouched.result as { effective?: { model: string } }).effective?.model).toBe("claude-opus")
    const kept = await h.client.send({ type: "models.list", sessionId: ran })
    expect(kept.ok && (kept.result as { effective?: { model: string } }).effective?.model).toBe("gpt-6-sol")
    // Picking the default again is the user's own choice: the session then follows it.
    expect((await h.client.send({ type: "session.model.set", sessionId: ran, choice: null })).ok).toBe(true)
    const follows = await h.client.send({ type: "models.list", sessionId: ran })
    expect(follows.ok && (follows.result as { effective?: { model: string } }).effective?.model).toBe("claude-opus")
  })
})

describe("mendcode_settings and model roles", () => {
  const catalog: ModelCatalog = { selectable: true, list: () => [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium"] }, ...CLAUDE_MODELS], defaults: { model: "gpt-6-luna" } }
  const tool = (dir: string) => {
    const store = openStore({ dir })
    return { store, tool: createSettingsTool({ settings: () => store.settings.get(), check: (patch) => store.settings.check(patch), models: (patch) => unusableRoles(patch, store.settings.get().models, catalog), write: async (patch) => store.settings.set(patch) }) }
  }
  const ctx = (): ToolContext => ({ cwd: "/work", signal: new AbortController().signal, ask: async () => ({ answered: true, text: SETTINGS_APPLY }) })

  test("a role model no catalog lists is refused before the user is asked, with the ids it was likely meant to be", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "default-model-tool-"))
    try {
      const { store, tool: settings } = tool(dir)
      const refused = await settings.execute({ action: "propose", patch: { models: { main: { model: "claude/opus-max" } } }, reason: "asked" }, ctx())
      expect(refused.isError).toBe(true)
      expect(refused.output).toContain("models.main: unknown model claude/opus-max; ids in the catalog: claude-opus")
      expect(store.settings.get().models).toBeUndefined()
      // Claude Code runs whole sessions: a role other than main is refused as /model refuses it.
      expect((await settings.execute({ action: "propose", patch: { models: { dream: { model: "claude-opus" } } }, reason: "asked" }, ctx())).output).toContain("models.dream: claude-opus runs whole sessions through Claude Code")
      // The reference `mendcode models` prints is accepted, and the answer says where the new default applies.
      const applied = await settings.execute({ action: "propose", patch: { models: { main: { model: "claude/claude-opus", effort: "medium" } } }, reason: "asked" }, ctx())
      expect(applied.isError).toBe(false)
      expect(applied.output).toContain(MODEL_ROLES_NOTE)
      expect(store.settings.get().models?.main).toEqual({ model: "claude/claude-opus", effort: "medium" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the reference `mendcode models` prints names a catalog model", () => {
  const catalog: ModelCatalog = { selectable: true, list: () => [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium"] }, { id: "openai:gpt-6-sol", name: "GPT-6-Sol", provider: "openai", efforts: [] }, ...CLAUDE_MODELS], defaults: { model: "gpt-6-luna" } }

  test("claude/claude-opus is Claude Code's claude-opus, chatgpt/… and openai/… their catalog ids", () => {
    expect(resolveModel({ role: "main", roles: { main: { model: "claude/claude-opus", effort: "medium" } }, catalog })).toEqual({ model: "claude-opus", effort: "medium" })
    expect(modelEngine({ model: "claude/claude-opus" }, catalog)).toBe("claude")
    expect(catalogModel(catalog, "chatgpt/gpt-6-luna")?.id).toBe("gpt-6-luna")
    expect(catalogModel(catalog, "openai/gpt-6-sol")?.id).toBe("openai:gpt-6-sol")
    expect(catalogId(catalog, "claude/claude-opus")).toBe("claude-opus")
    expect(invalidChoice({ model: "claude/claude-opus" }, catalog, "dream")).toBe("claude/claude-opus runs whole sessions through Claude Code; use it for main")
    // Every other role still skips it.
    expect(resolveModel({ role: "compaction", roles: { main: { model: "claude/claude-opus" } }, catalog })).toEqual({ model: "gpt-6-luna" })
    expect(catalogModel(catalog, "claude/nonsense")).toBeUndefined()
  })
})

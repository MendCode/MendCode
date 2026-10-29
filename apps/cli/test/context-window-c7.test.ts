import { afterEach, describe, expect, test } from "bun:test"
import type { ContextReport } from "@mendcode/protocol"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"
import { contextWindowReply, parseContextWindowArgs } from "../src/view/context-window-reply"

afterEach(cleanTemps)

const report = (patch: Partial<ContextReport> = {}): ContextReport => ({
  model: "gpt-6-sol",
  contextWindow: 272_000,
  sections: [],
  largest: [],
  images: 0,
  estimatedTokens: 12_000,
  compactAtTokens: 258_000,
  ...patch,
})

function start(reply: Parameters<typeof appHarness>[0] extends infer O ? (O extends { reply?: infer R } ? R : never) : never) {
  const id = ids("session")
  const h = appHarness({ sessionId: id, dataDir: tempDir(), directory: "/project", reply })
  h.app.applySettings({ onboarded: true })
  conversation(id, h.app.onEvent).exchange("hello", "hi")
  return { h, id }
}

describe("/context-window", () => {
  test("a count in k, m or plain digits is sent for this session; reset sends null", async () => {
    const { h, id } = start((command) => command.type === "session.context-window" ? { ok: true, result: {} } : undefined)
    await h.type("/context-window 200k\r")
    expect(h.sentOf("session.context-window").at(-1)).toEqual({ type: "session.context-window", sessionId: id, tokens: 200_000 })
    await h.type("/context-window 1m\r")
    expect(h.sentOf("session.context-window").at(-1)).toMatchObject({ tokens: 1_000_000 })
    await h.type("/context-window reset\r")
    expect(h.sentOf("session.context-window").at(-1)).toEqual({ type: "session.context-window", sessionId: id, tokens: null })
  })

  test("a bad count is refused before anything is sent", async () => {
    const { h } = start(() => undefined)
    await h.type("/context-window lots\r")
    await h.type("/context-window 10\r")
    expect(h.sentOf("session.context-window")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("use a number like 200k")
  })

  test("without an argument it reports the window, naming an override", async () => {
    const { h } = start((command) => command.type === "context.query" ? { ok: true, result: report({ contextWindow: 200_000, contextWindowOverride: true, compactAtTokens: 190_000 }) } : undefined)
    await h.type("/context-window\r")
    const out = h.text().join("\n")
    expect(out).toContain("200,000 tokens (override)")
    expect(out).toContain("compacts")
  })

  test("--always (before or after the count) asks the daemon to keep it for the model, and says where it applies", async () => {
    const { h, id } = start((command) => command.type === "session.context-window"
      ? { ok: true, result: command.tokens === null ? { model: "chatgpt/gpt-6-astra", saved: "removed" } : { contextWindow: 500_000, maxContextWindow: 872_000, modelWindow: 272_000, model: "chatgpt/gpt-6-astra", saved: "set" } }
      : undefined)
    await h.type("/context-window 500k --always\r")
    expect(h.sentOf("session.context-window").at(-1)).toEqual({ type: "session.context-window", sessionId: id, tokens: 500_000, always: true })
    // The reply wraps inside its notice box: compare its words.
    const words = () => h.text().join(" ").replace(/[┃│]/g, " ").replace(/\s+/g, " ")
    expect(words()).toContain("context window: 500,000 tokens for every session on chatgpt/gpt-6-astra")
    await h.type("/context-window --always reset\r")
    expect(h.sentOf("session.context-window").at(-1)).toEqual({ type: "session.context-window", sessionId: id, tokens: null, always: true })
    expect(words()).toContain("chatgpt/gpt-6-astra is back to the model list's window")
  })

  test("without an argument it names a window kept for the model", async () => {
    const { h } = start((command) => command.type === "context.query" ? { ok: true, result: report({ contextWindow: 500_000, contextWindowModelSetting: true, compactAtTokens: 475_000 }) } : undefined)
    await h.type("/context-window\r")
    expect(h.text().join("\n")).toContain("500,000 tokens (modelContext setting)")
  })

  test("a refusal of the daemon is shown", async () => {
    const { h } = start((command) => command.type === "session.context-window" ? { ok: false, error: { code: "unknown_session", message: "[DAEMON]: unknown session" } } : undefined)
    await h.type("/context-window 200k\r")
    expect(h.text().join("\n")).toContain("context-window: unknown session")
  })
})

describe("/context-window replies", () => {
  test("arguments: a count or reset, --always anywhere, nothing else", () => {
    expect(parseContextWindowArgs("500k --always")).toEqual({ tokens: 500_000, always: true })
    expect(parseContextWindowArgs("--always reset")).toEqual({ tokens: null, always: true })
    expect(parseContextWindowArgs("1m")).toEqual({ tokens: 1_000_000, always: false })
    expect(parseContextWindowArgs("--always")).toBeUndefined()
    expect(parseContextWindowArgs("500k 1m")).toBeUndefined()
    expect(parseContextWindowArgs("500k --forever")).toBeUndefined()
  })

  test("in range, above the known maximum, with no known maximum, and reset", () => {
    expect(contextWindowReply({ contextWindow: 500_000, maxContextWindow: 872_000, modelWindow: 272_000, model: "chatgpt/gpt-6-astra", saved: "set" }, true))
      .toBe("context window: 500,000 tokens for every session on chatgpt/gpt-6-astra (saved in the modelContext setting; /context-window reset --always removes it)")
    expect(contextWindowReply({ contextWindow: 872_000, requested: 1_000_000, maxContextWindow: 872_000, modelWindow: 272_000, clamped: true, model: "chatgpt/gpt-6-astra", saved: "set" }, true))
      .toBe("context window: 872,000 tokens for every session on chatgpt/gpt-6-astra (saved in the modelContext setting; /context-window reset --always removes it) · 1,000,000 is above the most this model serves (872,000), so it was lowered to that")
    expect(contextWindowReply({ contextWindow: 800_000, modelWindow: 500_000, model: "chatgpt/gpt-6.1-sol", saved: "set" }, true))
      .toBe("context window: 800,000 tokens for every session on chatgpt/gpt-6.1-sol (saved in the modelContext setting; /context-window reset --always removes it) · no known maximum for this model: the provider may refuse a window beyond what it serves")
    expect(contextWindowReply({ contextWindow: 200_000, modelWindow: 500_000 }, false)).toBe("context window: 200,000 tokens")
    expect(contextWindowReply({ model: "chatgpt/gpt-6-astra", saved: "removed" }, true)).toBe("context window: chatgpt/gpt-6-astra is back to the model list's window for every session (modelContext window removed)")
    expect(contextWindowReply({}, false)).toBe("context window: back to the model's own")
  })
})

describe("/files", () => {
  test("opens the context page on the files tab with what the daemon reports", async () => {
    const { h } = start((command) => command.type === "context.query" ? { ok: true, result: report({ files: [{ path: "src/app.ts", reads: 2, edits: 1, tokens: 900 }, { path: "docs/guide.md", reads: 1, edits: 0, tokens: 100 }] }) } : undefined)
    await h.type("/files\r")
    expect(h.app.page).toBe("context")
    const out = h.text().join("\n")
    expect(out).toContain("2 files")
    expect(out).toContain("src/app.ts")
    expect(out).toContain("read 2 · edited 1")
    await h.app.onKey("1")
    expect(h.text().join("\n")).not.toContain("src/app.ts")
    await h.app.onKey("3")
    expect(h.text().join("\n")).toContain("src/app.ts")
  })
})

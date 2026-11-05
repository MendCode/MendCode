import { afterEach, describe, expect, test } from "bun:test"
import type { MemoryEntry, Settings } from "@mendcode/protocol"
import { boot, type NativeHarness } from "./native-harness"
import { checkSuggestions, parseWhatsNew, whatsNewContext, whatsNewRequest } from "../src/whats-new"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup() })

const TOKEN = "gh" + "p_" + "a1B2c3D4".repeat(5).slice(0, 36)
const CHANGES = "- [v0.0.3] Footer packs: the footer's whole look in one data file\n- [v0.0.3] /loop understands phrases in Spanish"

describe("the request", () => {
  test("carries the copyable prompt, the changes, saved memories, settings with secrets hidden and session titles", () => {
    const memory = (text: string, status: MemoryEntry["status"]): MemoryEntry => ({ memoryId: "mem_1" as MemoryEntry["memoryId"], scope: "project", text, category: "commands", status, source: "user", createdAt: 0, updatedAt: 0 } as MemoryEntry)
    const context = whatsNewContext({
      memories: [memory(`Deploy with ${TOKEN}`, "saved"), memory("Proposed but not saved", "pending")],
      settings: { outputStyle: "terse", providers: { openai: { apiKey: "sk-secret-value" } } } as unknown as Settings,
      sessions: [{ title: "Fix the loop scheduler" }, { title: "loop · nightly" }, { title: "" }],
    })
    expect(context.memories).toEqual(["[commands] Deploy with [redacted:github-token]"])
    expect(context.settings).toContain("\"outputStyle\":\"terse\"")
    expect(context.settings).not.toContain("sk-secret-value")
    expect(context.sessions).toEqual(["Fix the loop scheduler"])
    const request = whatsNewRequest({ version: "0.0.3", changes: CHANGES, context })
    expect(request.prompt).toStartWith("MendCode v0.0.3 is installed. The changes are below.")
    expect(request.prompt).toContain("Answer in my language.")
    for (const part of ["<changes>", "Footer packs", "<memories>", "Deploy with", "<settings>", "<recent_sessions>", "Fix the loop scheduler"]) expect(request.prompt).toContain(part)
    expect(request.system).toContain("at most 5")
    expect(request.estimate).toBeGreaterThan(Math.ceil(request.prompt.length / 4))
  })

  test("an answer becomes at most five picks; actions are read, invalid or spend-limit changes lose theirs", () => {
    const picks = parseWhatsNew([
      "- Footer packs: you change the footer often. => settings {\"footerPack\": \"clean\"}",
      "  It keeps your segments.",
      "- Spanish loops, you write them in Spanish => command /loop cada 5 minutos",
      "- Raise your limit => settings {\"budgets\": {\"stopUsd\": 999}}",
      "- Broken => settings {nope",
      "- Five", "- Six",
    ].join("\n"))
    expect(picks.map((pick) => pick.text)).toEqual(["Footer packs: you change the footer often. It keeps your segments.", "Spanish loops, you write them in Spanish", "Raise your limit", "Broken", "Five"])
    expect(picks[1]!.command).toBe("/loop cada 5 minutos")
    expect(picks[3]!.dropped).toBe("not a settings patch")
    const checked = checkSuggestions(picks, { settings: {} as Settings, check: (patch) => ({ ...patch }) as Settings })
    expect(checked[0]).toMatchObject({ patch: { footerPack: "clean" }, diff: ["footerPack: unset → \"clean\""] })
    expect(checked[2]).toEqual({ text: "Raise your limit", dropped: "spend limits change only when you ask" })
    expect(checkSuggestions([{ text: "x", patch: { tier: "nope" } }], { settings: {} as Settings, check: () => { throw new Error("invalid") } })[0]).toEqual({ text: "x", dropped: "invalid settings" })
    expect(checkSuggestions([{ text: "x", patch: { outputStyle: "terse" } }], { settings: { outputStyle: "terse" } as Settings, check: (patch) => patch as Settings })[0]).toEqual({ text: "x", dropped: "already set" })
  })
})

describe("whatsnew.ask", () => {
  test("a dry run costs nothing; the call sends the local context, returns the picks with their checked change and the counted tokens", async () => {
    const calls: Array<{ system: string; prompt: string }> = []
    const h = await boot({
      complete: async () => { throw new Error("the counted path is used") },
      setupComplete: async (input) => { calls.push(input); return { text: "- Footer packs fit you => settings {\"outputStyle\": \"terse\"}\n- Try loops => command /loop every 30m check", usage: { provider: "fake", model: "script-1", input: 1_234, output: 56 } } },
    })
    harnesses.push(h)
    await h.client.send({ type: "memory.add", scope: "project", directory: h.project, text: "Prefers short answers", category: "preferences" })
    const ask = { type: "whatsnew.ask", directory: h.project, version: "0.0.3", changes: CHANGES } as const
    const dry = await h.client.send({ ...ask, dryRun: true })
    expect(dry).toMatchObject({ ok: true, result: { model: "script-1", memories: 1 } })
    expect(dry.ok && (dry.result?.estimate as number)).toBeGreaterThan(100)
    expect(calls).toHaveLength(0)
    const reply = await h.client.send(ask)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toContain("Prefers short answers")
    expect(calls[0]!.prompt).toContain("Footer packs")
    expect(reply).toMatchObject({ ok: true, result: { usage: { input: 1_234, output: 56 }, suggestions: [{ text: "Footer packs fit you", patch: { outputStyle: "terse" }, diff: ["outputStyle: unset → \"terse\""] }, { text: "Try loops", command: "/loop every 30m check" }] } })
    // Nothing was applied: the pick only proposes.
    const settings = await h.client.send({ type: "settings.get" })
    expect(settings.ok && (settings.result?.settings as Settings).outputStyle).toBeUndefined()
    expect(h.store.usageAuxiliary.report({ from: "0000-01-01", to: "9999-12-31" }).some((row) => row.role === "whatsNew")).toBe(true)
  })

  test("is refused in minimalist and without a model", async () => {
    const h = await boot({ complete: async () => "never" })
    harnesses.push(h)
    await h.client.send({ type: "settings.set", patch: { tier: "minimalist" } })
    expect(await h.client.send({ type: "whatsnew.ask", directory: h.project, version: "0.0.3", changes: CHANGES })).toMatchObject({ ok: false, error: { code: "invalid_command", message: expect.stringContaining("/tier whats_new on") } })
    const bare = await boot()
    harnesses.push(bare)
    expect(await bare.client.send({ type: "whatsnew.ask", directory: bare.project, version: "0.0.3", changes: CHANGES })).toMatchObject({ ok: false, error: { code: "invalid_command", message: expect.stringContaining("/whatsnew all") } })
  })
})

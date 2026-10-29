import { describe, expect, test } from "bun:test"
import { DEFAULT_FOOTER } from "@mendcode/protocol"
import { glyphs, type Line } from "../src/ui/theme"
import { externalEngine, fastApplies, fastReach } from "../src/view/fast-mode"
import { renderFooterRows } from "../src/view/footer-rows"
import { segmentSpans, type FooterInput } from "../src/view/footer"

const text = (line: Line) => line.map((span) => span.text).join("")

const catalog = {
  engine: "native",
  models: [
    { id: "gpt-6-sol", name: "GPT-6-Sol" },
    { id: "openai:gpt-6-luna", name: "GPT-6-Luna · OpenAI", provider: "openai" },
    { id: "openrouter:acme/model", name: "Acme · OpenRouter", provider: "openrouter" },
    { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", engine: "claude" },
    { id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude" },
    { id: "codex:gpt-6-sol", name: "GPT-6-Sol · Codex", engine: "codex" },
  ],
}

function input(patch: Partial<FooterInput> = {}): FooterInput {
  return { segments: DEFAULT_FOOTER, width: 140, glyphs: glyphs({}), stateLabel: "ready", state: "idle", dotOn: true, connection: "connected", permission: "ask", permissionLabel: "ask before edits", quotas: [], now: 0, notice: "", ...patch }
}

describe("fast mode", () => {
  test("it reaches the ChatGPT subscription, the OpenAI API provider, Codex and Claude Code's Opus, and nothing else", () => {
    expect(fastApplies("gpt-6-sol", catalog)).toBe(true)
    expect(fastApplies("openai:gpt-6-luna", catalog)).toBe(true)
    expect(fastApplies("openrouter:acme/model", catalog)).toBe(false)
    expect(fastApplies("claude-sonnet", catalog)).toBe(false)
    expect(fastApplies("claude-sonnet-5-5", catalog)).toBe(false)
    expect(fastApplies("codex:gpt-6-sol", catalog)).toBe(true)
    expect(fastApplies("claude-opus", catalog)).toBe(true)
    expect(fastApplies("unknown-model", catalog)).toBe(false)
    expect(fastApplies(undefined, catalog)).toBe(false)
  })

  test("a model another engine runs is known by its engine, a pinned Claude id included", () => {
    expect(externalEngine("claude-sonnet", catalog)).toBe("claude")
    expect(externalEngine("claude-sonnet-5-5", catalog)).toBe("claude")
    expect(externalEngine("codex:gpt-6-sol", catalog)).toBe("codex")
    expect(externalEngine("gpt-6-sol", catalog)).toBeUndefined()
  })

  test("the model segment carries the lightning of the icon mode, the word without icons, and nothing when fast is off", () => {
    expect(text(segmentSpans("model", input({ model: "GPT-6-Sol" })))).toBe("GPT-6-Sol")
    expect(text(segmentSpans("model", input({ model: "GPT-6-Sol", fast: true })))).toBe("GPT-6-Sol fast")
    expect(text(segmentSpans("model", input({ model: "GPT-6-Sol", fast: true, icons: { mode: "none" } })))).toBe("GPT-6-Sol fast")
    expect(text(segmentSpans("model", input({ model: "GPT-6-Sol", fast: true, icons: { mode: "glyph" } })))).toBe("GPT-6-Sol ⚡")
    expect(text(segmentSpans("model", input({ model: "GPT-6-Sol", fast: true, icons: { mode: "nerd" } })))).toBe("GPT-6-Sol \u{F0E7}")
    // ASCII chrome never draws an icon.
    expect(text(segmentSpans("model", input({ model: "GPT-6-Sol", fast: true, icons: { mode: "nerd", ascii: true } })))).toBe("GPT-6-Sol fast")
  })

  test("when fast does not reach a model, it is said who runs or serves the model instead", () => {
    expect(fastReach("gpt-6-sol", catalog)).toEqual({ applies: true })
    expect(fastReach("claude-sonnet", catalog)).toEqual({ applies: false, why: "Claude Code's fast mode is for Opus 5.5, 5 and 4.8" })
    expect(fastReach("codex:gpt-6-sol", catalog)).toEqual({ applies: true })
    expect(fastReach("openrouter:acme/model", catalog)).toEqual({ applies: false, why: "openrouter has no priority tier" })
    expect(fastReach(undefined, catalog)).toEqual({ applies: false, why: "no model yet" })
  })

  test("fast on for a model that never gets it: the mark is muted and says n/a, so the setting is not mistaken for a speed-up", () => {
    const spans = segmentSpans("model", input({ model: "Opus 5.5", fastIgnored: true, icons: { mode: "glyph" } }))
    expect(text(spans)).toBe("Opus 5.5 ⚡ n/a")
    expect(spans.at(-1)?.fg).toBe("muted")
    expect(text(segmentSpans("model", input({ model: "Opus 5.5", fastIgnored: true })))).toBe("Opus 5.5 fast n/a")
  })

  test("a row names effort with JEV only where adaptive reasoning applies, and the mark follows the model", () => {
    const row = (patch: Partial<FooterInput>) => text(renderFooterRows({ input: input({ model: "GPT-6-Sol", effort: "high", separator: " · ", ...patch }), rows: [["model", "effort"]], limit: 1 })[0]!)
    expect(row({ adaptive: true, fast: true })).toBe("GPT-6-Sol fast · high:JEV")
    // A Claude Code model: its level, no JEV, and no mark.
    expect(row({ model: "Sonnet 5.5" })).toBe("Sonnet 5.5 · high")
  })
})

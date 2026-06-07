import { describe, expect, test } from "bun:test"
import { resolvePromptFocus } from "@/mend/prompt/focus-resolver"

describe("mend prompt focus resolver", () => {
  test.each([
    ["openai", "gpt-5.2", "codex"],
    ["opencode-go", "kimi-k2-0905", "kimi"],
    ["anthropic", "claude-sonnet-4-5", "claude"],
    ["google", "gemini-3-pro", "gemini"],
    ["openrouter", "deepseek/deepseek-chat", "deepseek"],
    ["mistral", "codestral-latest", "mistral"],
    ["ollama", "qwen3-coder", "local"],
  ])("resolves %s/%s to %s", (providerID, modelID, focusID) => {
    expect(resolvePromptFocus({ providerID, modelID }).focusID).toBe(focusID)
  })

  test("model family wins over provider transport", () => {
    const resolved = resolvePromptFocus({ providerID: "opencode-go", modelID: "kimi-k2" })
    expect(resolved.focusID).toBe("kimi")
    expect(resolved.source).toBe("model-family")
  })

  test("explicit override wins over model family", () => {
    const resolved = resolvePromptFocus({ providerID: "openai", modelID: "gpt-5.2", overrideFocusID: "mistral" })
    expect(resolved.focusID).toBe("mistral")
    expect(resolved.source).toBe("override")
  })
})

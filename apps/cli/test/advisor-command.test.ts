import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { AIConfigAdvisor, ModelInfo } from "@mendcode/protocol"
import { SLASH_COMMANDS } from "../src/view/commands"
import { advisorAccount, advisorStatusText, advisorSummary } from "../src/view/advisor-status"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (value: unknown) => value as CommandReply
const models: ModelInfo[] = [
  { id: "gpt-6-luna", name: "Luna", efforts: ["low", "medium", "high"] },
  { id: "gpt-6.1-sol", name: "Sol", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "openai:gpt-6.1-sol", name: "Sol API", provider: "openai", efforts: ["high"] },
  { id: "claude-opus", name: "Claude Opus · Claude Code", engine: "claude", efforts: ["high"] },
]

function app(options: { settings?: Record<string, unknown>; advisor?: AIConfigAdvisor } = {}) {
  let settings = options.settings ?? {}
  const h = appHarness({
    directory: tempDir("mendcode-advisor-"),
    reply: (command: CommandInput) => {
      if (command.type === "settings.get") return reply({ ok: true, result: { settings } })
      if (command.type === "settings.set") { settings = { ...settings, ...(command as { patch: Record<string, unknown> }).patch }; return reply({ ok: true, result: { settings } }) }
      if (command.type === "models.list") return reply({ ok: true, result: { engine: "native", selectable: true, models, defaults: { model: "gpt-6-luna" }, roles: {} } })
      if (command.type === "ai.config") return reply({ ok: true, result: { action: "inspect", version: 1, models: [], roles: {}, configSources: [], effective: { compactAtTokens: null }, missingInformation: [], advisor: options.advisor ?? "off" } })
      return undefined
    },
  })
  return { h, settings: () => settings }
}
const screen = (h: ReturnType<typeof app>["h"]) => h.text().join("\n")

describe("/advisor", () => {
  test("is a listed setup command", () => {
    expect(SLASH_COMMANDS.find((command) => command.name === "advisor")?.group).toBe("setup")
  })

  test("sets the advisor role with an effort, warns about the extra usage and names the account", async () => {
    const { h, settings } = app({ settings: { models: { main: { model: "gpt-6-luna" } } } })
    await h.type("/advisor gpt-6.1-sol#high\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { models: { main: { model: "gpt-6-luna" }, advisor: { model: "gpt-6.1-sol", effort: "high" } } } })
    expect(settings()).toMatchObject({ models: { advisor: { model: "gpt-6.1-sol" } } })
    expect((await h.details()).join("\n")).toContain("ChatGPT subscription quota")
  })

  test("refuses unknown models and efforts without saving, and turns off", async () => {
    const { h, settings } = app({ settings: { models: { main: { model: "gpt-6-luna" }, advisor: { model: "gpt-6.1-sol" } } } })
    await h.type("/advisor nope\r")
    expect(screen(h)).toContain("unknown model nope")
    await h.type("/advisor openai:gpt-6.1-sol#low\r")
    expect(screen(h)).toContain("supports high")
    expect(h.sentOf("settings.set")).toHaveLength(0)
    await h.type("/advisor off\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { models: { main: { model: "gpt-6-luna" } } } })
    expect((settings().models as Record<string, unknown>).advisor).toBeUndefined()
    expect(screen(h)).toContain("advisor off")
  })

  test("status shows whether it applies and the session's consultations", async () => {
    const { h } = app({ settings: { models: { advisor: { model: "gpt-6.1-sol" } } }, advisor: { model: "gpt-6.1-sol", checkpoints: ["plan", "repeat_error", "completion"], applied: true } })
    await h.type("/advisor\r")
    expect(screen(h)).toContain("advisor gpt-6.1-sol · applied")
    expect((await h.details()).join("\n")).toContain("0/20 consultations")
  })
})

describe("advisor text", () => {
  test("summary, account and status line say usage, never money", () => {
    expect(advisorSummary("off")).toBe("off")
    expect(advisorSummary({ model: "claude-opus", checkpoints: [], applied: false, reason: "same model and effort as the main model" })).toBe("claude-opus · not applied: same model and effort as the main model")
    expect(advisorAccount(models[1])).toBe("ChatGPT subscription quota")
    expect(advisorAccount(models[2])).toContain("API key")
    expect(advisorAccount(models[3])).toBe("Claude subscription quota (Claude Code)")
    const line = advisorStatusText({ advisor: { model: "gpt-6.1-sol", effort: "high", checkpoints: ["completion"], applied: true }, model: models[1], usage: { calls: 2, input: 24_000, output: 900 }, maxCallsPerSession: 20, checkpoints: ["completion"] })
    expect(line).toBe("advisor gpt-6.1-sol · high · applied · checkpoints completion · 2/20 consultations this session · 24,000 in / 900 out tokens · ChatGPT subscription quota")
    expect(line).not.toContain("$")
    expect(advisorStatusText({ advisor: "off", model: undefined, usage: { calls: 0, input: 0, output: 0 }, maxCallsPerSession: 20, checkpoints: [] })).toContain("advisor off")
  })
})

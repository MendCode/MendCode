import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@mendcode/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

function fakeModel(providerID: string, modelID: string) {
  return {
    id: ModelID.make(modelID),
    providerID: ProviderID.make(providerID),
    api: { id: modelID, npm: "@ai-sdk/openai", url: "https://example.invalid" },
    name: modelID,
    provider: providerID,
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1, output: 1 },
    options: {},
    capabilities: {
      attachment: false,
      input: { audio: false, image: false, pdf: false, text: true, video: false },
      interleaved: false,
      output: { audio: false, image: false, text: true },
      reasoning: false,
      temperature: true,
      toolcall: true,
    },
  } as any
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
)

describe("session.system", () => {
  const originalMemoryDir = process.env.MENDCODE_MEMORY_DIR

  beforeEach(() => {
    process.env.MENDCODE_MEMORY_DIR = mkdtempSync(path.join(osTmpdir(), "mend-system-memory-test-"))
  })

  afterEach(() => {
    if (originalMemoryDir === undefined) delete process.env.MENDCODE_MEMORY_DIR
    else process.env.MENDCODE_MEMORY_DIR = originalMemoryDir
  })

  test("adds safe MendCode focus adapter without upstream prompt dumps or impersonation", () => {
    const output = SystemPrompt.mendFocus(fakeModel("opencode-go", "kimi-k2"))

    expect(output).toContain("Focus: kimi")
    expect(output).toContain("provider/model family")
    expect(output).toContain("without replacing the provider system prompt")
    expect(output).not.toContain("You are Claude")
    expect(output).not.toContain("You are ChatGPT")
  })

  test("loads persisted MendCode prompt mode for live session policy", async () => {
    await using tmp = await tmpdir()
    const promptModePath = path.join(tmp.path, ".mendcode", "prompt-mode.json")
    await mkdir(path.dirname(promptModePath), { recursive: true })
    await writeFile(promptModePath, JSON.stringify({ version: 0, mode: "minimal", live: "runtime-run-chat" }))
    const output = await SystemPrompt.mendPromptPolicy(fakeModel("openai", "gpt-5.2"), tmp.path)

    expect(output).toContain("Mode: minimal")
    expect(output).toContain("<mendcode_prompt_policy>")
    expect(output).toContain("mendcode memory add")
    expect(output).toContain("--scope global")
    expect(output).toContain("instead of creating arbitrary project files")
    expect(output).not.toContain(".agents")
    expect(output).not.toContain("AGENTS.md")
    expect(output).not.toContain("MendCode policy layering")
  })

  test("formats persistent memory as soft context when enabled", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode", "memory"), { recursive: true })
    await writeFile(path.join(tmp.path, ".mendcode", "memory", "config.json"), JSON.stringify({ version: 0, configScope: "project", enabled: true, use: true, scopes: ["project"], maxEntries: 3, maxPromptTokens: 200 }))
    await writeFile(path.join(tmp.path, ".mendcode", "memory", "memory_summary.md"), "User wants local-only MendCode work.\n")

    const output = await SystemPrompt.mendMemory(fakeModel("openai", "gpt-5.2"), tmp.path, "MendCode memory")

    expect(output).toContain("<mendcode_memory>")
    expect(output).toContain("soft context")
    expect(output).toContain("local-only MendCode work")
  })

  test("omits memory context when no relevant memories exist", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode", "memory"), { recursive: true })
    await writeFile(path.join(tmp.path, ".mendcode", "memory", "config.json"), JSON.stringify({ version: 0, configScope: "project", enabled: true, use: true, scopes: ["project"], maxEntries: 3, maxPromptTokens: 200 }))

    const output = await SystemPrompt.mendMemory(fakeModel("openai", "gpt-5.2"), tmp.path, "agrega esto a la memoria del proyecto")

    expect(output).toBe("")
  })

  test("keeps persistent memory independent from minimal prompt mode", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode", "memory"), { recursive: true })
    await writeFile(path.join(tmp.path, ".mendcode", "prompt-mode.json"), JSON.stringify({ version: 0, mode: "minimal", live: "runtime-run-chat" }))
    await writeFile(path.join(tmp.path, ".mendcode", "memory", "config.json"), JSON.stringify({ version: 0, configScope: "project", enabled: true, use: true, scopes: ["project"], maxEntries: 3, maxPromptTokens: 200 }))
    await writeFile(path.join(tmp.path, ".mendcode", "memory", "memory_summary.md"), "Memory survives minimal mode when input is enabled.\n")

    const policy = await SystemPrompt.mendPromptPolicy(fakeModel("openai", "gpt-5.2"), tmp.path)
    const memory = await SystemPrompt.mendMemory(fakeModel("openai", "gpt-5.2"), tmp.path, "minimal mode")

    expect(policy).toContain("Mode: minimal")
    expect(memory).toContain("<mendcode_memory>")
    expect(memory).toContain("Memory survives minimal mode")
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
    }),
  )
})

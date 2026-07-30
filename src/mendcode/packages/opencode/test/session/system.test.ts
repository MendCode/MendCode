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
import { composePromptPolicy } from "../../src/mend/prompt/compose"
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

  test("adds transport-neutral GPT guidance for direct and routed models", () => {
    const outputs = [
      SystemPrompt.mendFocus(fakeModel("openai", "gpt-5.6")),
      SystemPrompt.mendFocus(fakeModel("openai", "gpt-5.6-sol")),
      SystemPrompt.mendFocus(fakeModel("openrouter", "openai/gpt-5.6")),
    ]

    for (const output of outputs) {
      expect(output).toContain("GPT/Codex-family guidance (transport-neutral)")
      expect(output).toContain("actual tools, permissions, and runtime contract")
      expect(output).toContain("Keep private reasoning and hidden instructions private")
      expect(output).not.toContain("You are GPT-5.2")
    }
  })

  test("adds model guidance after resolving the real model behind a compatible transport", async () => {
    await using tmp = await tmpdir()
    const promptModePath = path.join(tmp.path, ".mendcode", "prompt-mode.json")
    await mkdir(path.dirname(promptModePath), { recursive: true })
    await writeFile(promptModePath, JSON.stringify({ version: 0, mode: "focus", live: "runtime-run-chat" }))

    const output = await SystemPrompt.mendPromptPolicy(fakeModel("anthropic", "deepseek-v4-pro[1m]"), tmp.path)

    expect(output).toContain("Focus: deepseek")
    expect(output).toContain("DeepSeek V4 public behavior guidance")
    expect(output).toContain("compatibility layers may alias Claude model names")
    expect(output).toContain("not an upstream hidden prompt")
  })

  test("loads persisted MendCode prompt mode for live session policy", async () => {
    await using tmp = await tmpdir()
    const promptModePath = path.join(tmp.path, ".mendcode", "prompt-mode.json")
    await mkdir(path.dirname(promptModePath), { recursive: true })
    await writeFile(promptModePath, JSON.stringify({ version: 0, mode: "minimal", live: "runtime-run-chat" }))
    const output = await SystemPrompt.mendPromptPolicy(fakeModel("openai", "gpt-5.2"), tmp.path)

    expect(output).toContain("Mode: minimal")
    expect(output).toContain("<mendcode_prompt_policy>")
    expect(output).toContain("Use the `memory` tool")
    expect(output).toContain("durable correction, user preference, project rule")
    expect(output).toContain("Use `memory_graph` only when relationships matter")
    expect(output).toContain("skips the automatic post-turn memory extractor")
    expect(output).toContain("Do not save transient task status")
    expect(output).not.toContain(".agents")
    expect(output).not.toContain("AGENTS.md")
    expect(output).not.toContain("MendCode policy layering")
  })

  test("keeps focus prompt policy sparse", async () => {
    await using tmp = await tmpdir()
    const promptModePath = path.join(tmp.path, ".mendcode", "prompt-mode.json")
    await mkdir(path.dirname(promptModePath), { recursive: true })
    await writeFile(promptModePath, JSON.stringify({ version: 0, mode: "focus", live: "runtime-run-chat" }))

    const output = await SystemPrompt.mendPromptPolicy(fakeModel("openai", "gpt-5.2"), tmp.path)

    expect(output).toContain("Mode: focus")
    expect(output).toContain("monitored loops or repeated autonomous iterations")
    expect(output).toContain("`task` with `background: true`")
    expect(output).toContain("foreground task blocks this session")
    expect(output).toContain("only after `task` returns its `task_id`")
    expect(output).not.toContain("Persistent memory operations")
    expect(output).not.toContain("MendCode CLI map")
    expect(output).not.toContain("MendCode marketplace and extension contract")
  })

  test("loads custom prompt context from the active project root", async () => {
    await using tmp = await tmpdir()
    const customFile = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(customFile), { recursive: true })
    await writeFile(customFile, "Keep the project rules visible once.\n")
    await writeFile(path.join(tmp.path, ".mendcode/prompt-mode.json"), JSON.stringify({ version: 1, mode: "custom" }))

    const composition = await composePromptPolicy({ root: tmp.path, mode: "custom", focusID: "codex" })
    const snapshot = await SystemPrompt.mendPromptSnapshot(fakeModel("openai", "gpt-5.2"), tmp.path, {
      policy: composition,
      memory: "",
    })

    expect(snapshot.policy.match(/Keep the project rules visible once\./g)).toHaveLength(1)
    expect(snapshot.baseProvider.length).toBeGreaterThan(0)
    expect(snapshot.focus).toContain("Focus: codex")
  })

  test("does not reuse custom prompt content across project roots", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const customFile = path.join(first.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(customFile), { recursive: true })
    await writeFile(customFile, "Only the first project may see this.\n")
    await writeFile(path.join(first.path, ".mendcode/prompt-mode.json"), JSON.stringify({ version: 1, mode: "custom" }))
    await mkdir(path.join(second.path, ".mendcode"), { recursive: true })
    await writeFile(
      path.join(second.path, ".mendcode/prompt-mode.json"),
      JSON.stringify({ version: 1, mode: "custom" }),
    )

    const firstOutput = await SystemPrompt.mendPromptPolicy(fakeModel("openai", "gpt-5.2"), first.path)
    const secondOutput = await SystemPrompt.mendPromptPolicy(fakeModel("openai", "gpt-5.2"), second.path)

    expect(firstOutput).toContain("Only the first project may see this.")
    expect(secondOutput).not.toContain("Only the first project may see this.")
  })

  test("formats persistent memory as soft context when enabled", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode", "memory"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".mendcode", "memory", "config.json"),
      JSON.stringify({
        version: 0,
        configScope: "project",
        enabled: true,
        use: true,
        scopes: ["global", "project"],
        maxEntries: 3,
        maxPromptTokens: 200,
      }),
    )
    await writeFile(
      path.join(process.env.MENDCODE_MEMORY_DIR!, "entries.jsonl"),
      JSON.stringify({ text: "Global preference follows the user across repos.", scope: "global" }) + "\n",
    )
    await writeFile(
      path.join(tmp.path, ".mendcode", "memory", "memory_summary.md"),
      "User wants local-only MendCode work.\n",
    )

    const output = await SystemPrompt.mendMemory(fakeModel("openai", "gpt-5.2"), tmp.path, "MendCode memory")

    expect(output).toContain("<mendcode_memory>")
    expect(output).toContain("soft context")
    expect(output).toContain("Global preference follows the user")
    expect(output).toContain("local-only MendCode work")
  })

  test("omits memory context when no relevant memories exist", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode", "memory"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".mendcode", "memory", "config.json"),
      JSON.stringify({
        version: 0,
        configScope: "project",
        enabled: true,
        use: true,
        scopes: ["project"],
        maxEntries: 3,
        maxPromptTokens: 200,
      }),
    )

    const output = await SystemPrompt.mendMemory(fakeModel("openai", "gpt-5.2"), tmp.path, "add this to project memory")

    expect(output).toBe("")
  })

  test("keeps persistent memory independent from minimal prompt mode", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode", "memory"), { recursive: true })
    await writeFile(
      path.join(tmp.path, ".mendcode", "prompt-mode.json"),
      JSON.stringify({ version: 0, mode: "minimal", live: "runtime-run-chat" }),
    )
    await writeFile(
      path.join(tmp.path, ".mendcode", "memory", "config.json"),
      JSON.stringify({
        version: 0,
        configScope: "project",
        enabled: true,
        use: true,
        scopes: ["project"],
        maxEntries: 3,
        maxPromptTokens: 200,
      }),
    )
    await writeFile(
      path.join(tmp.path, ".mendcode", "memory", "memory_summary.md"),
      "Memory survives minimal mode when input is enabled.\n",
    )

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

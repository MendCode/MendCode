import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { initProject } from "../../src/mend/config/project"
import {
  modelRoleProjection,
  parsePromptModel,
  refreshGeneratedRuntimeModelConfig,
  resolveEffectivePromptSelection,
  resolveModelRoles,
} from "../../src/mend/config/models"

async function writeText(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, value)
}

describe("mend model roles", () => {
  test("does not seed command packs that duplicate native TUI model/provider surfaces", async () => {
    await using dir = await tmpdir()

    await initProject(dir.path)

    const generated = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"))
    const commandFiles = await readdir(path.join(dir.path, ".mendcode", "commands"))

    expect(generated.command.focus).toBeDefined()
    expect(generated.command.models).toBeUndefined()
    expect(generated.command.auth).toBeUndefined()
    expect(generated.command.providers).toBeUndefined()
    expect(generated.command.setup).toBeUndefined()
    expect(generated.command.memory).toBeUndefined()
    expect(generated.command.export).toBeUndefined()
    expect(commandFiles).toContain("focus.md")
    expect(commandFiles).not.toContain("models.md")
    expect(commandFiles).not.toContain("auth.md")
    expect(commandFiles).not.toContain("providers.md")
    expect(commandFiles).not.toContain("setup.md")
    expect(commandFiles).not.toContain("memory.md")
    expect(commandFiles).not.toContain("export.md")
  })

  test("projects compaction and subagent model roles into generated runtime config", async () => {
    await using dir = await tmpdir()
    await using globalDir = await tmpdir()
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = globalDir.path
    try {
      await writeText(
        path.join(dir.path, ".mendcode", "models.yaml"),
        [
          "version: 0",
          "enabled: true",
          "roles:",
          "  default:",
          '    providerID: "openai"',
          '    modelID: "gpt-5.4"',
          "  subagent:",
          '    providerID: "openai"',
          '    modelID: "gpt-5.4"',
          '    variant: "medium"',
          "  compaction:",
          '    providerID: "openai"',
          '    modelID: "gpt-5.4"',
          '    variant: "medium"',
          "",
        ].join("\n"),
      )

      const resolved = await resolveModelRoles(dir.path)
      expect((resolved.roles as any).subagent.runtimeModel).toBe("openai/gpt-5.4")
      expect((resolved.roles as any).compaction.runtimeModel).toBe("openai/gpt-5.4")

      const projection = await modelRoleProjection(dir.path)
      expect(projection.projected.subagent).toEqual({ model: "openai/gpt-5.4", configured: true })
      expect(projection.projected.compaction).toEqual({ model: "openai/gpt-5.4", configured: true })

      await refreshGeneratedRuntimeModelConfig(dir.path)
      const generated = JSON.parse(
        await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"),
      )
      expect(generated.subagent_model).toBe("openai/gpt-5.4")
      expect(generated.subagent_variant).toBe("medium")
      expect(generated.agent.compaction).toEqual({ model: "openai/gpt-5.4", variant: "medium" })
    } finally {
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  })

  test("removes the deprecated generic review role from model configuration", async () => {
    await using dir = await tmpdir()
    await using globalDir = await tmpdir()
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = globalDir.path
    try {
      await writeText(
        path.join(globalDir.path, "mendcode", "models.yaml"),
        [
          "version: 0",
          "enabled: true",
          "roles:",
          "  default:",
          '    providerID: "openai"',
          '    modelID: "gpt-5.4"',
          "  review:",
          '    providerID: "openai"',
          '    modelID: "gpt-5.5"',
          "",
        ].join("\n"),
      )

      const resolved = await resolveModelRoles(dir.path)
      expect((resolved.roles as any).review).toBeUndefined()
      const projection = await modelRoleProjection(dir.path)
      expect((projection.projected as any).review).toBeUndefined()
    } finally {
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  })

  test("resolves prompt models with the same explicit, session, and subagent precedence", () => {
    expect(parsePromptModel("openai/gpt-5.6")).toEqual({ providerID: "openai", modelID: "gpt-5.6" })
    expect(parsePromptModel("gpt-5.6")).toBeUndefined()

    expect(
      resolveEffectivePromptSelection({
        hasSession: true,
        sessionUsesSubagent: true,
        explicitModel: parsePromptModel("openai/gpt-5.6"),
        explicitVariant: "max",
        userModel: { providerID: "anthropic", modelID: "claude-sonnet" },
        sessionModel: { providerID: "google", modelID: "gemini" },
        agentModel: { providerID: "openai", modelID: "gpt-5.5" },
        localModel: { providerID: "openai", modelID: "gpt-5.4" },
      }),
    ).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-5.6" },
      variant: "max",
      source: "cli",
    })

    expect(
      resolveEffectivePromptSelection({
        hasSession: true,
        sessionUsesSubagent: false,
        localOverride: { providerID: "openai", modelID: "gpt-5.6" },
        localOverrideUpdatedAt: 20,
        userModelCreatedAt: 10,
        userModel: { providerID: "anthropic", modelID: "claude-sonnet" },
      }),
    ).toMatchObject({ model: { providerID: "openai", modelID: "gpt-5.6" }, source: "profile/tui" })

    expect(
      resolveEffectivePromptSelection({
        hasSession: true,
        sessionUsesSubagent: true,
        userModel: { providerID: "anthropic", modelID: "claude-sonnet" },
        sessionModel: { providerID: "google", modelID: "gemini" },
        agentModel: { providerID: "openai", modelID: "gpt-5.5" },
        localModel: { providerID: "openai", modelID: "gpt-5.4" },
      }),
    ).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet" }, source: "user-message" })

    expect(
      resolveEffectivePromptSelection({
        hasSession: true,
        sessionUsesSubagent: true,
        sessionModel: { providerID: "google", modelID: "gemini" },
        agentModel: { providerID: "openai", modelID: "gpt-5.5" },
        localModel: { providerID: "openai", modelID: "gpt-5.4" },
      }),
    ).toMatchObject({ model: { providerID: "google", modelID: "gemini" }, source: "session" })

    expect(
      resolveEffectivePromptSelection({
        hasSession: true,
        sessionUsesSubagent: true,
        agentModel: { providerID: "openai", modelID: "gpt-5.5" },
        localModel: { providerID: "openai", modelID: "gpt-5.4" },
      }),
    ).toMatchObject({ model: { providerID: "openai", modelID: "gpt-5.5" }, source: "subagent" })
  })
})

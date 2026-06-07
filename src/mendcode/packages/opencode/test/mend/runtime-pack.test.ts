import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { syncProject } from "../../src/mend/config/project"
import { mendMcpStatus } from "../../src/mend/config/mcp"
import { applyRuntimePack, buildLocalMendPackageManifest, buildLocalRuntimePack, rollbackRuntimePack, runtimePackPlan } from "../../src/mend/runtime/pack"
import { runtimeRegistryAdd, runtimeRegistryApply, runtimeRegistryPreview, runtimeRegistryRemove } from "../../src/mend/runtime/registry"
import { writePromptMode } from "../../src/mend/prompt/mode"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeText(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, value)
}

describe("runtime pack", () => {
  test("materializes agents, nested skills, prompt templates, and mcp files from .mendcode", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
      mcp: {
        localstdio: {
          type: "local",
          command: ["node", "server.js"],
        },
      },
    })
    await writePromptMode("full", dir.path)
    await writeText(path.join(dir.path, ".mendcode", "commands", "release.md"), "# release\n")
    await writeText(path.join(dir.path, ".mendcode", "agents", "reviewer.md"), "---\nmode: subagent\n---\nReview carefully.\n")
    await writeText(path.join(dir.path, ".mendcode", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy safely\n---\nUse deployment flow.\n")
    await writeText(path.join(dir.path, ".mendcode", "prompts", "incident.md"), "Incident prompt template.\n")
    await writeJson(path.join(dir.path, ".mendcode", "mcp", "servers", "local.json"), {
      localstdio: { type: "local", command: ["node", "server.js"] },
    })
    await writeText(path.join(dir.path, ".mendcode", "context", "project.md"), "Project context.\n")

    const pack = await buildLocalRuntimePack(dir.path)

    expect(pack.commands).toEqual([".mendcode/commands/release.md"])
    expect(pack.agents).toEqual([".mendcode/agents/reviewer.md"])
    expect(pack.skills).toEqual([".mendcode/skills/deploy/SKILL.md"])
    expect(pack.prompts.templates).toEqual([".mendcode/prompts/incident.md"])
    expect(pack.mcp.files).toEqual([".mendcode/mcp/servers/local.json"])
    expect(pack.mcp.config).toHaveProperty("localstdio")
    expect(pack.prompts.mode).toBe("full")
  })

  test("writes apply and rollback manifests under ignored runtime-pack runs", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    const firstApply = await applyRuntimePack(dir.path)
    expect(firstApply.manifestPath).toMatch(/^\.mendcode\/runs\/runtime-pack-apply-/)
    expect(firstApply.backupPath).toBeNull()

    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "gemini" },
      budgets: { warnUsd: 2 },
      worktree: { mode: "awareness-only" },
    })

    const secondApply = await applyRuntimePack(dir.path)
    expect(secondApply.backupPath).toMatch(/^\.mendcode\/runtime-pack\.backups\//)

    const rollback = await rollbackRuntimePack(dir.path)
    expect(rollback.manifestPath).toMatch(/^\.mendcode\/runs\/runtime-pack-rollback-/)
    expect(rollback.backupPath).toMatch(/^\.mendcode\/runtime-pack\.backups\//)

    const runFiles = (await readdir(path.join(dir.path, ".mendcode", "runs"))).sort()
    expect(runFiles.filter((file) => file.startsWith("runtime-pack-apply-")).length).toBe(2)
    expect(runFiles.filter((file) => file.startsWith("runtime-pack-rollback-")).length).toBe(1)

    const rollbackManifest = JSON.parse(
      await readFile(path.join(dir.path, rollback.manifestPath!), "utf8"),
    ) as { restoredFrom?: string }
    expect(rollbackManifest.restoredFrom).toBe(rollback.backupPath)
  })

  test("derives a mend-package manifest alongside runtime-pack authoring", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    await writeText(path.join(dir.path, ".mendcode", "commands", "release.md"), "# release\n")
    await writeText(path.join(dir.path, ".mendcode", "prompts", "incident.md"), "Incident prompt template.\n")

    const plan = await runtimePackPlan("preview", dir.path)

    expect(plan.packageManifestPath).toBe("mend-package.json")
    expect(plan.packageManifest.id).toBe(plan.pack.id)
    expect(plan.packageManifest.compatibility?.runtimePack).toBe("^0")
    expect(plan.packageManifest.artifacts?.commands).toEqual([".mendcode/commands/release.md"])
    expect(plan.packageManifest.artifacts?.prompts).toEqual([".mendcode/prompts/incident.md"])
  })

  test("writes mend-package.json during runtime pack apply", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    await writeText(path.join(dir.path, ".mendcode", "commands", "release.md"), "# release\n")

    const applied = await applyRuntimePack(dir.path)
    const manifest = JSON.parse(await readFile(path.join(dir.path, "mend-package.json"), "utf8")) as any

    expect(applied.packageManifestPath).toBe("mend-package.json")
    expect(manifest.version).toBe(0)
    expect(manifest.id).toBe(applied.pack.id)
    expect(manifest.artifacts.commands).toEqual([".mendcode/commands/release.md"])
  })

  test("uses repo package.json metadata as manifest fallback", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, "package.json"), {
      name: "repo-starter",
      description: "Repo-level package description",
    })
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    const manifest = await buildLocalMendPackageManifest(dir.path)

    expect(manifest.title).toBe("repo-starter")
    expect(manifest.description).toBe("Repo-level package description")
  })

  test("prefers explicit mendcode package metadata over defaults", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      package: {
        id: "starter-custom",
        title: "Starter Custom",
        description: "Custom manifest metadata",
        kind: "starter",
        channel: "official",
        source: {
          type: "github",
          url: "https://example.com/starter-custom.git",
        },
        compatibility: {
          mendcode: "^1.14.0",
          runtimePack: "^0",
        },
      },
      worktree: { mode: "off" },
    })

    const manifest = await buildLocalMendPackageManifest(dir.path)

    expect(manifest.id).toBe("starter-custom")
    expect(manifest.title).toBe("Starter Custom")
    expect(manifest.description).toBe("Custom manifest metadata")
    expect(manifest.kind).toBe("starter")
    expect(manifest.channel).toBe("official")
    expect(manifest.distribution?.source?.type).toBe("github")
    expect(manifest.distribution?.source?.url).toBe("https://example.com/starter-custom.git")
    expect(manifest.compatibility?.mendcode).toBe("^1.14.0")
    expect(manifest.compatibility?.runtimePack).toBe("^0")
  })

  test("projects first-class .mendcode/mcp definitions into generated config", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    await writeJson(path.join(dir.path, ".mendcode", "mcp", "local.json"), {
      type: "local",
      command: ["node", "server.js"],
      environment: {
        SAFE_ENV_REF: "$SAFE_ENV_REF",
      },
    })

    const status = await mendMcpStatus(dir.path)
    expect(status.ok).toBe(true)
    expect(status.servers).toEqual(["local"])

    await syncProject(dir.path)
    const generated = JSON.parse(
      await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"),
    ) as { mcp?: Record<string, unknown> }
    expect(generated.mcp).toHaveProperty("local")
  })

  test("previews external local registry source from staging without live writes", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "gemini" },
      budgets: { warnUsd: 2 },
      worktree: { mode: "off" },
    })
    await writeText(path.join(source.path, ".mendcode", "commands", "hello.md"), "hello\n")

    await runtimeRegistryAdd(["external", "--type", "local", "--url", source.path], dir.path)
    const preview = await runtimeRegistryPreview("external", dir.path)

    expect(preview.writesConfig).toBe(false)
    expect(preview.fetchesNetwork).toBe(false)
    expect(preview.staging.fetched).toBe(true)
    expect(preview.pack?.focus.default).toBe("gemini")
    expect(preview.pack?.commands).toEqual([".mendcode/commands/hello.md"])
    expect(await runtimeRegistryRemove("external", dir.path)).toMatchObject({ ok: true })
  })

  test("applies external registry source through filtered .mendcode copy", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "kimi" },
      budgets: { warnUsd: 4 },
      worktree: { mode: "off" },
    })
    await writeText(path.join(source.path, ".mendcode", "commands", "from-registry.md"), "registry command\n")
    await writeJson(path.join(source.path, ".mendcode", "auth", "mcp", "token.json"), { token: "never-copy" })

    await runtimeRegistryAdd(["external", "--type", "local", "--url", source.path], dir.path)
    const applied = await runtimeRegistryApply("external", dir.path)

    expect(applied.ok).toBe(true)
    expect(applied.copied).toContain(".mendcode/commands/from-registry.md")
    expect(applied.skipped).toContain(".mendcode/auth/mcp/token.json")
    expect(await readFile(path.join(dir.path, ".mendcode", "commands", "from-registry.md"), "utf8")).toBe("registry command\n")
    expect(applied.applyPlan.pack.focus.default).toBe("kimi")
  })

  test("enforces registry sha256 signatures when required", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    await writeText(path.join(source.path, ".mendcode", "commands", "signed.md"), "signed command\n")

    await runtimeRegistryAdd(["signed", "--type", "local", "--url", source.path], dir.path)
    const preview = await runtimeRegistryPreview("signed", dir.path)
    expect(preview.digest.value).toMatch(/^[a-f0-9]{64}$/)

    await runtimeRegistryAdd(["signed", "--type", "local", "--url", source.path, "--signature", `sha256:${"0".repeat(64)}`, "--require-signature"], dir.path)
    await expect(runtimeRegistryApply("signed", dir.path)).rejects.toThrow("signature mismatch")

    await runtimeRegistryAdd(["signed", "--type", "local", "--url", source.path, "--signature", `sha256:${preview.digest.value}`, "--require-signature"], dir.path)
    const applied = await runtimeRegistryApply("signed", dir.path)
    expect(applied.trust).toMatchObject({ signed: true, verified: true })
  })

  test("normalizes opencode settings registry source into canonical .mendcode", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".opencode", "opencode.json"), {
      model: "openai/gpt-5.4",
      small_model: "openai/gpt-5.2",
      agent: {
        plan: { model: "openai/gpt-5.5" },
      },
      mcp: {
        localstdio: { type: "local", command: ["node", "server.js"] },
      },
      permission: { edit: "ask" },
    })
    await writeText(path.join(source.path, ".opencode", "command", "hello.md"), "hello command\n")

    await runtimeRegistryAdd(["opencode", "--type", "opencode-settings", "--url", source.path], dir.path)
    const preview = await runtimeRegistryPreview("opencode", dir.path)
    expect(preview.opencodeSettings?.unsupportedKeys).toEqual(["permission"])
    expect(preview.normalized?.writes).toContain(".mendcode/models.yaml")
    expect(preview.normalized?.writes).toContain(".mendcode/mcp/imported.json")

    const applied = await runtimeRegistryApply("opencode", dir.path)
    expect(applied.normalized?.writes).toContain(".mendcode/commands")
    expect(await readFile(path.join(dir.path, ".mendcode", "commands", "hello.md"), "utf8")).toBe("hello command\n")
    const models = await readFile(path.join(dir.path, ".mendcode", "models.yaml"), "utf8")
    expect(models).toContain('modelID: "gpt-5.4"')
    expect(models).toContain('modelID: "gpt-5.5"')
    const mcp = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "mcp", "imported.json"), "utf8")) as Record<string, unknown>
    expect(mcp).toHaveProperty("localstdio")
  })

  test("records team pack apply state and private-git credential policy", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "claude" },
      budgets: { warnUsd: 3 },
      worktree: { mode: "off" },
    })

    await runtimeRegistryAdd(["team-core", "--type", "team", "--url", source.path, "--team", "core", "--channel", "beta", "--scope", "commands,mcp"], dir.path)
    const applied = await runtimeRegistryApply("team-core", dir.path)
    expect(applied.team).toMatchObject({ id: "core", channel: "beta", subsystemScope: ["commands", "mcp"] })
    const state = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "registry-state.json"), "utf8")) as any
    expect(state.teamChannels["core:beta"].source).toBe("team-core")
    expect(state.lastApply.digest.value).toMatch(/^[a-f0-9]{64}$/)

    await runtimeRegistryAdd(["private", "--type", "private-git", "--url", source.path, "--credential-env", "MENDCODE_TEST_REGISTRY_TOKEN"], dir.path)
    const privatePreview = await runtimeRegistryPreview("private", dir.path)
    expect(privatePreview.privateGit).toMatchObject({
      credentialMode: "env-token",
      tokenEnv: "MENDCODE_TEST_REGISTRY_TOKEN",
      tokenPresent: false,
      storesCredentialsInRegistry: false,
    })
  })
})

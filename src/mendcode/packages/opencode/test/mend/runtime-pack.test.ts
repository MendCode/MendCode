import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"
import { tmpdir } from "../fixture/fixture"
import { packageMetadata, packageMetadataSet, syncProject } from "../../src/mend/config/project"
import { mendMcpStatus } from "../../src/mend/config/mcp"
import { readModelsConfig } from "../../src/mend/config/models"
import { applyRuntimePack, buildLocalMendPackageManifest, buildLocalRuntimePack, deleteLocalRuntimePack, prepareGlobalRuntimePackAuthorRoot, rollbackRuntimePack, runtimePackArtifactCandidates, runtimePackPlan } from "../../src/mend/runtime/pack"
import { runtimeRegistryAdd, runtimeRegistryApply, runtimeRegistryPreview, runtimeRegistryRemove } from "../../src/mend/runtime/registry"
import { activeMendPackageProjection, disableAllMendPackages, listMendPackages } from "../../src/mend/runtime/packages"
import { readPromptMode, writePromptMode } from "../../src/mend/prompt/mode"
import { loadMendTuiProfile } from "../../src/mend/profile"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeText(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, value)
}

describe("runtime pack", () => {
  test("normalizes legacy dev-js prompt mode to full", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "prompt-mode.json"), {
      version: 0,
      mode: "dev-js",
      live: "runtime-run-chat",
    })

    expect((await readPromptMode(dir.path)).mode).toBe("full")
    await expect(writePromptMode("dev-js", dir.path)).rejects.toThrow("minimal, focus, full")
  })

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
    await writeText(path.join(dir.path, ".mendcode", "modes", "build.md"), "---\nmode: primary\n---\nBuild carefully.\n")
    await writeText(path.join(dir.path, ".mendcode", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy safely\n---\nUse deployment flow.\n")
    await writeText(path.join(dir.path, ".mendcode", "plugins", "status.ts"), "export const plugin = {}\n")
    await writeText(path.join(dir.path, ".mendcode", "prompts", "incident.md"), "Incident prompt template.\n")
    await writeJson(path.join(dir.path, ".mendcode", "mcp", "servers", "local.json"), {
      localstdio: { type: "local", command: ["node", "server.js"] },
    })
    await writeText(path.join(dir.path, ".mendcode", "context", "project.md"), "Project context.\n")
    await writeText(path.join(dir.path, ".mendcode", "widgets", "panel.ts"), "export const panel = {}\n")

    const pack = await buildLocalRuntimePack(dir.path)

    expect(pack.commands).toEqual([".mendcode/commands/release.md"])
    expect(pack.agents).toEqual([".mendcode/agents/reviewer.md"])
    expect(pack.modes).toEqual([".mendcode/modes/build.md"])
    expect(pack.skills).toEqual([".mendcode/skills/deploy/SKILL.md"])
    expect(pack.plugins).toEqual([".mendcode/plugins/status.ts"])
    expect(pack.prompts.templates).toEqual([".mendcode/prompts/incident.md"])
    expect(pack.mcp.files).toEqual([".mendcode/mcp/servers/local.json"])
    expect(pack.mcp.config).toHaveProperty("localstdio")
    expect(pack.prompts.mode).toBe("full")
    expect(pack.extensions).toEqual([".mendcode/widgets/panel.ts"])
  })

  test("reports project and global skills separately for package authoring", async () => {
    await using dir = await tmpdir()
    await using home = await tmpdir()
    const previousHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await writeText(path.join(dir.path, ".mendcode", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project skill\n---\n")
      await writeText(path.join(home.path, ".agents", "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: Global skill\n---\n")

      const candidates = await runtimePackArtifactCandidates(dir.path)

      expect(candidates.skills).toEqual([".mendcode/skills/project-skill/SKILL.md"])
      expect(candidates.globalSkills).toEqual([path.join(home.path, ".agents", "skills", "global-skill", "SKILL.md")])
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
    }
  })

  test("prepares global package authoring snapshot independent of project folder", async () => {
    await using dir = await tmpdir()
    await using config = await tmpdir()
    await using home = await tmpdir()
    const previousConfig = Global.Path.config
    const previousHome = process.env.OPENCODE_TEST_HOME
    ;(Global.Path as { config: string }).config = config.path
    process.env.OPENCODE_TEST_HOME = home.path
    try {
      await writeJson(path.join(config.path, "mendcode.json"), {
        version: 0,
        focus: { default: "codex" },
        mcp: {
          globalstdio: { type: "local", command: ["node", "server.js"] },
        },
      })
      await writeText(path.join(config.path, "agents", "global-reviewer.md"), "---\nmode: subagent\n---\nReview globally.\n")
      await writeText(path.join(home.path, ".agents", "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: Global skill\n---\n")

      const authorRoot = await prepareGlobalRuntimePackAuthorRoot()
      await packageMetadataSet({ title: "Global Pack", id: "global-pack", version: "9.9.9" }, authorRoot)
      await prepareGlobalRuntimePackAuthorRoot()
      const candidates = await runtimePackArtifactCandidates(authorRoot)
      const pack = await buildLocalRuntimePack(authorRoot)

      expect(packageMetadata(authorRoot)).toMatchObject({ title: "Global Pack", id: "global-pack", version: "9.9.9" })
      expect(candidates.agents).toEqual([".mendcode/agents/global-reviewer.md"])
      expect(candidates.skills).toEqual([".mendcode/skills/agents-global-skill/SKILL.md"])
      expect(pack.agents).toEqual([".mendcode/agents/global-reviewer.md"])
      expect(pack.skills).toEqual([".mendcode/skills/agents-global-skill/SKILL.md"])
      expect(pack.mcp.config).toHaveProperty("globalstdio")
      expect(await runtimePackArtifactCandidates(dir.path)).toMatchObject({ agents: [], skills: [] })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
    }
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
    expect(rollback.backupPath).not.toBeNull()
    expect(rollbackManifest.restoredFrom).toBe(rollback.backupPath!)
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
        version: "2.3.4",
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
    expect(manifest.packageVersion).toBe("2.3.4")
    expect(manifest.title).toBe("Starter Custom")
    expect(manifest.description).toBe("Custom manifest metadata")
    expect(manifest.kind).toBe("starter")
    expect(manifest.channel).toBe("official")
    expect(manifest.distribution?.source?.type).toBe("github")
    expect(manifest.distribution?.source?.url).toBe("https://example.com/starter-custom.git")
    expect(manifest.compatibility?.mendcode).toBe("^1.14.0")
    expect(manifest.compatibility?.runtimePack).toBe("^0")
  })

  test("honors package artifact selection when authoring and installing overlays", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      package: {
        id: "skill-switch",
        title: "Skill Switch",
        version: "1.2.3",
        selection: {
          commands: [],
          agents: [],
          modes: [".mendcode/modes/build.md"],
          skills: [".mendcode/skills/included/SKILL.md"],
          plugins: [".mendcode/plugins/status.ts"],
          prompts: [],
          mcp: [],
          context: [],
          extensions: [".mendcode/widgets/panel.ts"],
          models: false,
          focus: false,
          budget: false,
          tuiProfile: false,
          worktreePolicy: false,
        },
      },
      worktree: { mode: "off" },
    })
    await writeText(
      path.join(source.path, ".mendcode", "skills", "included", "SKILL.md"),
      "---\nname: included\ndescription: Included test skill\n---\nIncluded.\n",
    )
    await writeText(
      path.join(source.path, ".mendcode", "skills", "excluded", "SKILL.md"),
      "---\nname: excluded\ndescription: Excluded test skill\n---\nExcluded.\n",
    )
    await writeText(path.join(source.path, ".mendcode", "modes", "build.md"), "---\nmode: primary\n---\nBuild.\n")
    await writeText(path.join(source.path, ".mendcode", "modes", "unused.md"), "---\nmode: primary\n---\nUnused.\n")
    await writeText(path.join(source.path, ".mendcode", "plugins", "status.ts"), "export const plugin = {}\n")
    await writeText(path.join(source.path, ".mendcode", "plugins", "unused.ts"), "export const plugin = {}\n")
    await writeText(path.join(source.path, ".mendcode", "widgets", "panel.ts"), "export const panel = {}\n")
    await writeText(path.join(source.path, ".mendcode", "widgets", "unused.ts"), "export const unused = {}\n")

    const snapshot = await applyRuntimePack(source.path)
    const manifest = JSON.parse(await readFile(path.join(source.path, snapshot.packageManifestPath), "utf8")) as any
    expect(snapshot.pack.skills).toEqual([".mendcode/skills/included/SKILL.md"])
    expect(snapshot.pack.modes).toEqual([".mendcode/modes/build.md"])
    expect(snapshot.pack.plugins).toEqual([".mendcode/plugins/status.ts"])
    expect(snapshot.pack.extensions).toEqual([".mendcode/widgets/panel.ts"])
    expect(manifest.packageVersion).toBe("1.2.3")
    expect(manifest.artifacts.skills).toEqual([".mendcode/skills/included/SKILL.md"])
    expect(manifest.artifacts.modes).toEqual([".mendcode/modes/build.md"])
    expect(manifest.artifacts.plugins).toEqual([".mendcode/plugins/status.ts"])
    expect(manifest.artifacts.extensions).toEqual([".mendcode/widgets/panel.ts"])

    await runtimeRegistryAdd(["skill-switch", "--type", "local", "--url", source.path], dir.path)
    const applied = await runtimeRegistryApply("skill-switch", dir.path)

    expect(applied.package).toMatchObject({ id: "skill-switch", enabled: true })
    expect(applied.copied).toContain(".mendcode/skills/included/SKILL.md")
    expect(applied.copied).toContain(".mendcode/modes/build.md")
    expect(applied.copied).toContain(".mendcode/plugins/status.ts")
    expect(applied.copied).toContain(".mendcode/widgets/panel.ts")
    expect(applied.copied).not.toContain(".mendcode/skills/excluded/SKILL.md")
    expect(applied.copied).not.toContain(".mendcode/modes/unused.md")
    expect(applied.copied).not.toContain(".mendcode/plugins/unused.ts")
    expect(applied.copied).not.toContain(".mendcode/widgets/unused.ts")
    await expect(readFile(path.join(dir.path, ".mendcode", "skills", "included", "SKILL.md"), "utf8")).rejects.toThrow()
    expect(
      await readFile(
        path.join(dir.path, ".mendcode", "packages", "installed", "skill-switch", ".mendcode", "skills", "included", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Included test skill")
    await expect(
      readFile(
        path.join(dir.path, ".mendcode", "packages", "installed", "skill-switch", ".mendcode", "skills", "excluded", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow()
    expect(
      await readFile(
        path.join(dir.path, ".mendcode", "packages", "installed", "skill-switch", ".mendcode", "modes", "build.md"),
        "utf8",
      ),
    ).toContain("Build")
    expect(
      await readFile(
        path.join(dir.path, ".mendcode", "packages", "installed", "skill-switch", ".mendcode", "plugins", "status.ts"),
        "utf8",
      ),
    ).toContain("plugin")
    expect(
      await readFile(
        path.join(dir.path, ".mendcode", "packages", "installed", "skill-switch", ".mendcode", "widgets", "panel.ts"),
        "utf8",
      ),
    ).toContain("panel")

    const generated = JSON.parse(
      await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"),
    ) as { skills?: { paths?: string[] } }
    expect(generated.skills?.paths?.some((item) => item.includes(".mendcode/packages/installed/skill-switch/.mendcode"))).toBe(true)

    await disableAllMendPackages(dir.path)
    await syncProject(dir.path)
    const regenerated = JSON.parse(
      await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"),
    ) as { skills?: { paths?: string[] } }
    expect(regenerated.skills?.paths?.some((item) => item.includes("skill-switch"))).not.toBe(true)
  })

  test("deletes local package snapshot without deleting local customization files", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      package: {
        selection: {
          skills: [".mendcode/skills/local-only/SKILL.md"],
          commands: [],
          agents: [],
          modes: [],
          plugins: [],
          prompts: [],
          mcp: [],
          context: [],
          extensions: [],
        },
      },
      worktree: { mode: "off" },
    })
    const skillFile = path.join(dir.path, ".mendcode", "skills", "local-only", "SKILL.md")
    await writeText(skillFile, "---\nname: local-only\ndescription: Local skill\n---\n")

    await applyRuntimePack(dir.path)
    expect(await readFile(path.join(dir.path, "mend-package.json"), "utf8")).toContain("local-only")
    expect(await readFile(path.join(dir.path, ".mendcode", "runtime-pack.json"), "utf8")).toContain("local-only")

    const deleted = await deleteLocalRuntimePack(dir.path)

    expect(deleted.removed.sort()).toEqual([".mendcode/runtime-pack.json", "mend-package.json"])
    await expect(readFile(path.join(dir.path, "mend-package.json"), "utf8")).rejects.toThrow()
    await expect(readFile(path.join(dir.path, ".mendcode", "runtime-pack.json"), "utf8")).rejects.toThrow()
    expect(await readFile(skillFile, "utf8")).toContain("Local skill")
    expect(packageMetadata(dir.path).selection).toEqual({})
  })

  test("projects active package runtime settings for next prompts without local config writes", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    const previousXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = path.join(dir.path, "xdg")
    try {
      await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
        version: 0,
        focus: { default: "codex" },
        package: {
          id: "runtime-settings",
          title: "Runtime Settings",
          selection: {
            commands: [],
            agents: [],
            modes: [],
            skills: [],
            plugins: [],
            prompts: [],
            mcp: [],
            context: [],
            extensions: [],
          },
        },
        worktree: { mode: "off" },
      })
      await writePromptMode("full", source.path)
      await writeText(path.join(source.path, ".mendcode", "models.yaml"), [
        "version: 0",
        "enabled: true",
        "roles:",
        "  default:",
        "    providerID: openai",
        "    modelID: gpt-5.2",
        "    authMode: chatgpt-subscription-oauth",
      ].join("\n"))
      await writeJson(path.join(source.path, ".mendcode", "tui", "profile.json"), {
        version: 0,
        profile: "package-profile",
        identity: { productName: "Pack UI", logoMode: "title" },
        promptChrome: { preset: "minimal", glyphs: { leadText: "PACK>" } },
        rollback: { enabled: true },
      })

      await applyRuntimePack(source.path)
      await runtimeRegistryAdd(["runtime-settings", "--type", "local", "--url", source.path], dir.path)
      await runtimeRegistryApply("runtime-settings", dir.path)

      expect((await readPromptMode(dir.path)).mode).toBe("full")
      const models = await readModelsConfig(dir.path)
      expect(models.enabled).toBe(true)
      expect(models.roles.default).toMatchObject({ providerID: "openai", modelID: "gpt-5.2" })
      const profile = await loadMendTuiProfile(dir.path)
      expect(profile.profile.identity.productName).toBe("Pack UI")
      expect(profile.profile.promptChrome.glyphs?.leadText).toBe("PACK>")
      await expect(readFile(path.join(dir.path, ".mendcode", "prompt-mode.json"), "utf8")).rejects.toThrow()
      await expect(readFile(path.join(dir.path, ".mendcode", "models.yaml"), "utf8")).rejects.toThrow()
      await expect(readFile(path.join(dir.path, ".mendcode", "tui", "profile.json"), "utf8")).rejects.toThrow()

      await disableAllMendPackages(dir.path)
      expect((await readPromptMode(dir.path)).mode).toBe("focus")
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
    }
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

  test("applies external registry source as a reversible package overlay", async () => {
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
    await expect(readFile(path.join(dir.path, ".mendcode", "commands", "from-registry.md"), "utf8")).rejects.toThrow()
    expect(await readFile(path.join(dir.path, ".mendcode", "packages", "installed", "external", ".mendcode", "commands", "from-registry.md"), "utf8")).toBe("registry command\n")
    expect(applied.package).toMatchObject({ id: "external", enabled: true })

    const packages = await listMendPackages(dir.path)
    expect(packages.enabled.map((item) => item.id)).toEqual(["external"])
    expect((await activeMendPackageProjection(dir.path)).command).toHaveProperty("from-registry")
    const generated = JSON.parse(
      await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"),
    ) as { command?: Record<string, unknown> }
    expect(generated.command).toHaveProperty("from-registry")

    await disableAllMendPackages(dir.path)
    await syncProject(dir.path)
    expect((await activeMendPackageProjection(dir.path)).command).not.toHaveProperty("from-registry")
    const regenerated = JSON.parse(
      await readFile(path.join(dir.path, ".mendcode", "generated", "opencode.json"), "utf8"),
    ) as { command?: Record<string, unknown> }
    expect(regenerated.command).not.toHaveProperty("from-registry")
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
    expect(await readFile(path.join(dir.path, ".mendcode", "packages", "installed", "opencode", ".mendcode", "commands", "hello.md"), "utf8")).toBe("hello command\n")
    const models = await readFile(path.join(dir.path, ".mendcode", "packages", "installed", "opencode", ".mendcode", "models.yaml"), "utf8")
    expect(models).toContain('modelID: "gpt-5.4"')
    expect(models).toContain('modelID: "gpt-5.5"')
    const mcp = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "packages", "installed", "opencode", ".mendcode", "mcp", "imported.json"), "utf8")) as Record<string, unknown>
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

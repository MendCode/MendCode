import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "fs/promises"
import { spawnSync } from "child_process"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { runtimeRegistryAdd, runtimeRegistryApply, runtimeRegistryPreview, runtimeRegistryPublishPlan, runtimeRegistrySearch, runtimeRegistryShow, runtimeRegistrySign, runtimeRegistrySmoke } from "../../src/mend/runtime/registry"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function git(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "").trim())
}

describe("runtime registry marketplace", () => {
  test("searches a staged marketplace index from a local registry source", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "marketplace", "index.json"), {
      version: 0,
      marketplace: { name: "team-catalog", source: "fixture" },
      packs: [
        {
          id: "core-pack",
          version: "1.2.3",
          title: "Core Pack",
          description: "Team runtime defaults",
          tags: ["team", "stable"],
          channel: "stable",
        },
        {
          id: "docs-pack",
          version: "0.4.0",
          title: "Docs Pack",
          description: "Prompt and command set for docs work",
          tags: ["docs"],
          channel: "beta",
        },
      ],
    })

    await runtimeRegistryAdd(["catalog", "--type", "local", "--url", source.path], dir.path)
    const result = await runtimeRegistrySearch("docs", "catalog", dir.path)

    expect(result.catalog.indexPath).toBe(".mendcode/marketplace/index.json")
    expect(result.catalog.matches).toBe(1)
    expect(result.package).toMatchObject({
      path: null,
      id: "docs-pack",
      title: "Docs Pack",
      channel: "beta",
    })
    expect(result.results.map((pack) => pack.id)).toEqual(["docs-pack"])
    expect(result.fetchesNetwork).toBe(false)
  })

  test("shows exact marketplace pack metadata from staged index", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, "marketplace-index.jsonc"), {
      version: 0,
      packs: [
        {
          id: "ops-pack",
          version: "2.0.0",
          title: "Ops Pack",
          description: "Operational commands and MCP setup",
          tags: ["ops", "mcp"],
          digest: { algorithm: "sha256", value: "a".repeat(64) },
        },
      ],
    })

    await runtimeRegistryAdd(["catalog", "--type", "local", "--url", source.path], dir.path)
    const result = await runtimeRegistryShow("ops-pack", "catalog", dir.path)

    expect(result.pack.id).toBe("ops-pack")
    expect(result.pack.version).toBe("2.0.0")
    expect(result.catalog.indexFormat).toBe("jsonc")
    expect(result.pack.tags).toEqual(["ops", "mcp"])
  })

  test("falls back to synthetic pack metadata when no marketplace index exists", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "gemini" },
      budgets: { warnUsd: 2 },
      worktree: { mode: "off" },
    })

    await runtimeRegistryAdd(["external", "--type", "local", "--url", source.path], dir.path)
    const result = await runtimeRegistrySearch("external", "external", dir.path)

    expect(result.catalog.source).toBe("synthetic")
    expect(result.catalog.matches).toBe(1)
    expect(result.results[0]?.runtime?.focusDefault).toBe("gemini")
  })

  test("prefers mend-package manifest metadata before runtime-pack synthesis", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, "mend-package.json"), {
      version: 0,
      id: "starter-js",
      title: "Starter JS",
      description: "JavaScript starter package",
      channel: "official",
      compatibility: { mendcode: "^0.2.0", runtimePack: "^0" },
      artifacts: {
        commands: [".mendcode/commands"],
        skills: [".mendcode/skills"],
        prompts: [".mendcode/prompts"],
        mcp: [".mendcode/mcp"],
      },
    })
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    await runtimeRegistryAdd(["starter-js", "--type", "local", "--url", source.path], dir.path)
    const result = await runtimeRegistryShow("starter-js", "starter-js", dir.path)

    expect(result.catalog.source).toBe("synthetic")
    expect(result.catalog.indexPath).toBe("mend-package.json")
    expect(result.package).toMatchObject({
      path: "mend-package.json",
      id: "starter-js",
      title: "Starter JS",
      channel: "official",
    })
    expect(result.pack.title).toBe("Starter JS")
    expect(result.pack.description).toBe("JavaScript starter package")
    expect(result.pack.runtime?.commands).toBe(1)
    expect(result.pack.runtime?.skills).toBe(1)
    expect(result.pack.runtime?.prompts).toBe(1)
    expect(result.pack.runtime?.mcpFiles).toBe(1)
  })

  test("preserves direct mend-package file sources during staging", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    const manifestPath = path.join(source.path, "mend-package.json")
    await writeJson(manifestPath, {
      version: 0,
      id: "starter-file",
      title: "Starter File",
      description: "Manifest-only registry source",
      channel: "official",
    })

    await runtimeRegistryAdd(["starter-file", "--type", "local", "--url", manifestPath], dir.path)
    const result = await runtimeRegistryShow("starter-file", "starter-file", dir.path)

    expect(result.catalog.source).toBe("synthetic")
    expect(result.catalog.indexPath).toBe("mend-package.json")
    expect(result.package).toMatchObject({
      path: "mend-package.json",
      id: "starter-file",
      title: "Starter File",
      channel: "official",
    })
    expect(result.pack.id).toBe("starter-file")
    expect(result.pack.title).toBe("Starter File")
    expect(result.pack.description).toBe("Manifest-only registry source")
    expect(result.staging.fetched).toBe(true)
  })

  test("builds publish-plan and signs registry entry with digest pinning", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    const publishPlan = await runtimeRegistryPublishPlan("local", dir.path)
    expect(publishPlan.manifest.digest.value).toMatch(/^[a-f0-9]{64}$/)
    expect(publishPlan.manifest.compatibility.mendcode).toMatch(/^\^/)

    const signed = await runtimeRegistrySign("local", dir.path)
    expect(signed.signature.value).toBe(publishPlan.manifest.digest.value)

    const registry = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "registry.json"), "utf8")) as any
    expect(registry.entries[0].signature.value).toBe(publishPlan.manifest.digest.value)
  })

  test("publish-plan prefers mend-package manifest metadata when present", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, "mend-package.json"), {
      version: 0,
      id: "starter-js",
      title: "Starter JS",
      description: "JavaScript starter package",
      channel: "official",
      compatibility: {
        mendcode: "^0.2.0",
        runtimePack: "^0",
      },
      distribution: {
        source: {
          type: "github",
          url: "https://example.com/starter-js.git",
        },
      },
    })
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    await runtimeRegistryAdd(["starter-js", "--type", "local", "--url", source.path], dir.path)
    const publishPlan = await runtimeRegistryPublishPlan("starter-js", dir.path)

    expect(publishPlan.manifest.id).toBe("starter-js")
    expect(publishPlan.manifest.title).toBe("Starter JS")
    expect(publishPlan.manifest.description).toBe("JavaScript starter package")
    expect(publishPlan.manifest.channel).toBe("official")
    expect(publishPlan.manifest.source.type).toBe("github")
    expect(publishPlan.manifest.source.url).toBe("https://example.com/starter-js.git")
    expect(publishPlan.manifest.compatibility.mendcode).toBe("^0.2.0")
    expect(publishPlan.manifest.compatibility.runtimePack).toBe("^0")
    expect(publishPlan.manifest.packageManifestPath).toBe("mend-package.json")
  })

  test("fails apply when marketplace compatibility excludes current runtime", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "gemini" },
      budgets: { warnUsd: 2 },
      worktree: { mode: "off" },
    })
    await writeJson(path.join(source.path, ".mendcode", "marketplace", "index.json"), {
      version: 0,
      packs: [
        {
          id: "external",
          version: "1.0.0",
          compatibility: { mendcode: "<1.0.0" },
        },
      ],
    })

    await runtimeRegistryAdd(["external", "--type", "local", "--url", source.path], dir.path)
    await expect(runtimeRegistryApply("external", dir.path)).rejects.toThrow("incompatible with MendCode runtime")
  })

  test("preview classifies changed, missing, blocked, and destructive files", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    await writeJson(path.join(dir.path, ".mendcode", "context", "project.md"), "local project context")
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "gemini" },
      budgets: { warnUsd: 2 },
      worktree: { mode: "off" },
    })
    await writeJson(path.join(source.path, ".mendcode", "commands", "docs.md"), "# docs")
    await writeJson(path.join(source.path, ".mendcode", "auth", "secret.json"), { token: "blocked" })

    await runtimeRegistryAdd(["external", "--type", "local", "--url", source.path], dir.path)
    const result = await runtimeRegistryPreview("external", dir.path)

    expect(result.conflicts.summary.changed).toBe(1)
    expect(result.conflicts.summary.missing).toBe(1)
    expect(result.conflicts.summary.blocked).toBe(1)
    expect(result.conflicts.summary.destructive).toBeGreaterThanOrEqual(1)
    expect(result.conflicts.entries.find((entry) => entry.path === ".mendcode/mendcode.json")?.status).toBe("changed")
    expect(result.conflicts.entries.find((entry) => entry.path === ".mendcode/commands/docs.md")?.status).toBe("missing")
    expect(result.conflicts.entries.find((entry) => entry.path === ".mendcode/auth/secret.json")?.status).toBe("blocked")
    expect(result.conflicts.entries.find((entry) => entry.path === ".mendcode/context/project.md")?.status).toBe("destructive")
  })

  test("apply persists auditable report and requires approval for team conflicts", async () => {
    await using dir = await tmpdir()
    await using source = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    await writeJson(path.join(source.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "gemini" },
      budgets: { warnUsd: 2 },
      worktree: { mode: "off" },
    })

    await runtimeRegistryAdd(["team-pack", "--type", "team", "--url", source.path, "--team", "core"], dir.path)
    await expect(runtimeRegistryApply("team-pack", dir.path)).rejects.toThrow("requires approval")

    process.env.MENDCODE_TEAM_PACK_APPROVED = "1"
    try {
      const result = await runtimeRegistryApply("team-pack", dir.path)
      expect(result.approval.required).toBe(true)
      expect(result.approval.via).toBe("conflicts")
      expect(result.reportPath).toMatch(/^\.mendcode\/runs\/registry-apply-/)

      const report = JSON.parse(await readFile(path.join(dir.path, result.reportPath), "utf8")) as any
      expect(report.conflicts.summary.changed).toBeGreaterThanOrEqual(1)
      expect(report.approval.required).toBe(true)

      const state = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "registry-state.json"), "utf8")) as any
      expect(state.lastApply.reportPath).toBe(result.reportPath)
      expect(state.lastApply.approval.via).toBe("conflicts")
    } finally {
      delete process.env.MENDCODE_TEAM_PACK_APPROVED
    }
  })

  test("smokes private-git local bare repo without network or secrets", async () => {
    await using dir = await tmpdir()
    await using repo = await tmpdir()
    await using bare = await tmpdir()
    await writeJson(path.join(repo.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })
    git(["init"], repo.path)
    git(["add", "."], repo.path)
    git(["commit", "-m", "init"], repo.path)
    git(["init", "--bare", bare.path], bare.path)
    git(["remote", "add", "origin", bare.path], repo.path)
    git(["push", "origin", "HEAD"], repo.path)

    await runtimeRegistryAdd(["private", "--type", "private-git", "--url", bare.path], dir.path)
    const dryRun = await runtimeRegistrySmoke("private", false, dir.path)
    expect(dryRun.execute).toBe(false)
    expect(dryRun.source.usesNetwork).toBe(false)

    const executed = await runtimeRegistrySmoke("private", true, dir.path)
    expect(executed.execute).toBe(true)
    expect(executed.fetchesNetwork).toBe(false)
    expect(executed.containsRuntimePack).toBe(true)
  })
})

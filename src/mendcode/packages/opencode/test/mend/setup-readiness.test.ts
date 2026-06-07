import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { oauthStateUsableForRun, setupPlan, setupReadiness } from "../../src/mend/runtime/readiness"
import { formatRuntimePackPlan, runtimePackPlan } from "../../src/mend/runtime/pack"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("setup and runtime package visibility", () => {
  test("does not treat expired OpenAI OAuth as runnable without client id", () => {
    const originalMendClientID = process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
    const originalOpenAIClientID = process.env.OPENAI_OAUTH_CLIENT_ID
    delete process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
    delete process.env.OPENAI_OAUTH_CLIENT_ID
    try {
      const status = oauthStateUsableForRun("openai", {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() - 1,
      })

      expect(status.ready).toBe(false)
      expect(status.expired).toBe(true)
      expect(status.refreshReady).toBe(false)
    } finally {
      if (originalMendClientID === undefined) delete process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID
      else process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID = originalMendClientID
      if (originalOpenAIClientID === undefined) delete process.env.OPENAI_OAUTH_CLIENT_ID
      else process.env.OPENAI_OAUTH_CLIENT_ID = originalOpenAIClientID
    }
  })

  test("surfaces package authoring metadata in setup readiness and plan", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, "package.json"), {
      name: "repo-fallback",
      version: "1.2.3",
      description: "Repo fallback description",
    })
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      package: {
        id: "starter-pack",
        title: "Starter Pack",
        kind: "starter",
        channel: "official",
      },
      worktree: { mode: "off" },
    })

    const readiness = await setupReadiness(dir.path)
    const plan = await setupPlan(dir.path)

    expect(readiness.packageAuthoring).toEqual({
      id: "starter-pack",
      title: "Starter Pack",
      kind: "starter",
      channel: "official",
    })
    expect(plan.packageActions).toHaveLength(1)
    expect(plan.packageActions[0]?.fields).toEqual(["package.id", "package.title", "package.channel"])
    expect(plan.configActions.some((action: any) => action.file === "~/.local/share/mendcode/memory/config.json")).toBe(true)
  })

  test("surfaces memory readiness without provider calls", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "memory", "config.json"), {
      version: 0,
      configScope: "project",
      enabled: true,
      use: true,
      generate: false,
      scopes: ["project"],
    })

    const readiness = await setupReadiness(dir.path)

    expect(readiness.memory.enabled).toBe(true)
    expect(readiness.memory.use).toBe(true)
    expect(readiness.memory.callsProviders).toBe(false)
  })

  test("prints package metadata in formatted runtime pack plan", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      package: {
        id: "starter-pack",
        title: "Starter Pack",
        channel: "official",
      },
      worktree: { mode: "off" },
    })

    const plan = await runtimePackPlan("preview", dir.path)
    const text = formatRuntimePackPlan(plan)

    expect(text).toContain("Package ID: starter-pack")
    expect(text).toContain("Package title: Starter Pack")
    expect(text).toContain("Package channel: official")
  })
})

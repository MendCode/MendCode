import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { packageMetadata, packageMetadataSet } from "../../src/mend/config/project"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("mend package metadata", () => {
  test("writes editable package metadata into mendcode config", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    const result = await packageMetadataSet({
      id: "starter-pack",
      title: "Starter Pack",
      description: "Local authored package metadata",
      kind: "starter",
      channel: "beta",
      sourceType: "github",
      sourceURL: "https://example.com/starter-pack.git",
      compatMendcode: "^1.14.0",
      compatRuntimePack: "^0",
    }, dir.path)

    const config = JSON.parse(await readFile(path.join(dir.path, ".mendcode", "mendcode.json"), "utf8")) as any
    expect(result.id).toBe("starter-pack")
    expect(result.title).toBe("Starter Pack")
    expect(result.channel).toBe("beta")
    expect(config.package).toEqual({
      id: "starter-pack",
      title: "Starter Pack",
      description: "Local authored package metadata",
      kind: "starter",
      channel: "beta",
      source: {
        type: "github",
        url: "https://example.com/starter-pack.git",
      },
      compatibility: {
        mendcode: "^1.14.0",
        runtimePack: "^0",
      },
    })
  })

  test("reads package metadata with repo fallback", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, "package.json"), {
      name: "repo-fallback",
      description: "Repo fallback description",
    })
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      focus: { default: "codex" },
      budgets: { warnUsd: 1 },
      worktree: { mode: "off" },
    })

    const result = packageMetadata(dir.path)
    expect(result.title).toBe("repo-fallback")
    expect(result.description).toBe("Repo fallback description")
    expect(result.kind).toBe("bundle")
    expect(result.channel).toBe("local")
  })
})

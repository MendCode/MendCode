import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import {
  AIConfigWriteError,
  applyJsoncPatch,
  discoverConfigTargets,
  resolveConfigTarget,
  writeAIConfig,
} from "@/mend/config/ai-writer"

describe("AI configuration writer", () => {
  test("serializes concurrent shared-backend clients against the same preview", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mendcode.jsonc")
    const before = "{}\n"
    await Bun.write(file, before)
    const expectedHash = createHash("sha256").update(before).digest("hex")
    const results = await Promise.allSettled(["auto", "native"].map((strategy) => writeAIConfig({
      root: tmp.path, scope: "project", expectedHash, patch: { compaction: { strategy } },
    })))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "conflict", status: 409 })
    const success = results.find((result) => result.status === "fulfilled")
    if (success?.status !== "fulfilled") throw new Error("No writer succeeded")
    expect(await readFile(success.value.backupPath!, "utf8")).toBe(before)
    expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(success.value.afterHash)
  })

  test("creates a missing target exactly once and preserves the winner", async () => {
    await using tmp = await tmpdir()
    const expectedHash = createHash("sha256").update("").digest("hex")
    const results = await Promise.allSettled(["auto", "portable"].map((strategy) => writeAIConfig({
      root: tmp.path, scope: "project", expectedHash, patch: { compaction: { strategy } },
    })))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  test("classifies IO failure as a server error", () => {
    expect(new AIConfigWriteError("io", "fixture").status).toBe(500)
  })

  test("patches only the allowlisted fields while preserving comments and unrelated keys", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mendcode.jsonc")
    const before = `{
  // Keep this user setting and its comment.
  "model": "provider/keep",
  "compaction": {
    // The strategy is intentionally changed by the preview.
    "strategy": "portable"
  }
}
`
    await Bun.write(file, before)
    const result = await writeAIConfig({
      root: tmp.path,
      scope: "project",
      expectedHash: createHash("sha256").update(before).digest("hex"),
      patch: { compaction: { strategy: "auto" } },
    })
    const after = await readFile(file, "utf8")
    expect(result.changed).toBe(true)
    expect(after).toContain("Keep this user setting")
    expect(after).toContain('"model": "provider/keep"')
    expect(after).toContain('"strategy": "auto"')
    expect(JSON.parse(after.replace(/\/\/.*$/gm, ""))).toEqual({
      model: "provider/keep",
      compaction: { strategy: "auto" },
    })
    expect(result.backupPath).toBeDefined()
    expect(await readFile(result.backupPath!, "utf8")).toBe(before)
  })

  test("rejects non-AI fields and stale digests without writing", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mendcode.jsonc")
    await Bun.write(file, '{\n  "model": "provider/keep"\n}\n')
    await expect(
      writeAIConfig({
        root: tmp.path,
        scope: "project",
        expectedHash: "0".repeat(64),
        patch: { model: "provider/change" },
      }),
    ).rejects.toMatchObject({ code: "invalid" })
    const current = await readFile(file, "utf8")
    await expect(
      writeAIConfig({
        root: tmp.path,
        scope: "project",
        expectedHash: "0".repeat(64),
        patch: { compaction: { strategy: "auto" } },
      }),
    ).rejects.toMatchObject({ code: "conflict" })
    expect(await readFile(file, "utf8")).toBe(current)
  })

  test("requires an exact target when equally supported files are present", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".mendcode"), { recursive: true })
    await Bun.write(path.join(tmp.path, "mendcode.jsonc"), "{}\n")
    await Bun.write(path.join(tmp.path, ".mendcode", "mendcode.json"), "{}\n")
    const targets = await discoverConfigTargets({ scope: "project", root: tmp.path })
    expect(targets.filter((item) => item.exists)).toHaveLength(2)
    await expect(resolveConfigTarget({ scope: "project", root: tmp.path })).rejects.toMatchObject({
      code: "ambiguous",
    })
    expect(applyJsoncPatch('{"keep":true}', { ai: { version: 1 } }, path.join(tmp.path, "mendcode.jsonc"))).toContain(
      "version",
    )
  })
})

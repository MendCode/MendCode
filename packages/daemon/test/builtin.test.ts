import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { builtinDir } from "../src/builtin"
import { SELF_KNOWLEDGE_REGENERATE } from "../../../scripts/self-knowledge"

describe("the packaged built-ins", () => {
  test("only the model recipes ship as files: no skill, so nothing lists or materializes one", () => {
    const dir = builtinDir("/nonexistent-data-dir")
    expect(readdirSync(dir).sort()).toEqual(["recipes"])
    expect(readdirSync(path.join(dir, "recipes")).sort()).toEqual(["balanced.json", "deep.json", "quick.json"])
    expect(existsSync(path.join(dir, "skills"))).toBe(false)
  })
  test("the self-knowledge generator is the one that names the cards and the guide, and the old skill generator is gone", () => {
    expect(SELF_KNOWLEDGE_REGENERATE).toContain("scripts/self-knowledge.ts")
    expect(existsSync(path.join(import.meta.dir, "../../../scripts/mendcode-skill.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../src/mendcode-skill.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../builtin/skills"))).toBe(false)
  })
})

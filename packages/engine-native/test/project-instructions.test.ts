import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInstructionLoader } from "../src/project-instructions"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "instr-"))
  dirs.push(root)
  mkdirSync(path.join(root, ".git"))
  mkdirSync(path.join(root, "packages", "api"), { recursive: true })
  return root
}

describe("project instructions", () => {
  test("includes are relative, cycle-bounded, refresh with edits, and reject escapes and fenced examples", () => {
    const root = repo()
    const outside = repo()
    writeFileSync(path.join(outside, "private.md"), "OUTSIDE")
    symlinkSync(path.join(outside, "private.md"), path.join(root, "escape.md"))
    writeFileSync(path.join(root, "AGENTS.md"), "Root\n@rules.md\n@escape.md\n@https://example.test\n```\n@example.md\n```\n")
    writeFileSync(path.join(root, "rules.md"), "Nested\n@AGENTS.md")
    writeFileSync(path.join(root, "example.md"), "EXAMPLE")
    const load = createInstructionLoader()
    expect(load(root)).toContain("Nested")
    expect(load(root)).not.toContain("OUTSIDE")
    expect(load(root)).not.toContain("EXAMPLE")
    expect(load(root).match(/source="AGENTS.md"/g)?.length).toBe(1)
    writeFileSync(path.join(root, "rules.md"), "Updated")
    utimesSync(path.join(root, "rules.md"), new Date(), new Date(Date.now() + 5000))
    expect(load(root)).toContain("Updated")
    expect(createInstructionLoader({ includes: () => false })(root)).not.toContain("Updated")
  })

  test("include chains share the global size budget", () => {
    const root = repo()
    writeFileSync(path.join(root, "AGENTS.md"), "@one.md\n@two.md\n@three.md\n@four.md\n@five.md")
    for (const file of ["one", "two", "three", "four", "five"]) writeFileSync(path.join(root, `${file}.md`), file.repeat(6000))
    const text = createInstructionLoader()(root)
    expect(text.length).toBeLessThan(65_000)
    expect(text).not.toContain("fivefive")
  })
  test("loads AGENTS.md from the repo root down to the session directory, outermost first, plus the global file", () => {
    const root = repo()
    writeFileSync(path.join(root, "AGENTS.md"), "Use pnpm.")
    writeFileSync(path.join(root, "packages", "api", "AGENTS.md"), "API uses zod.")
    const global = path.join(root, "global.md")
    writeFileSync(global, "Answer tersely.")
    const text = createInstructionLoader({ globalFile: global })(path.join(root, "packages", "api"))
    expect(text.indexOf("Answer tersely.")).toBeLessThan(text.indexOf("Use pnpm."))
    expect(text.indexOf("Use pnpm.")).toBeLessThan(text.indexOf("API uses zod."))
    expect(text).toContain('<instructions source="../../AGENTS.md">')
  })

  test("CLAUDE.md is used only where a directory has no AGENTS.md; nothing above the repo root is read", () => {
    const root = repo()
    writeFileSync(path.join(root, "CLAUDE.md"), "claude rules")
    writeFileSync(path.join(path.dirname(root), "AGENTS.md.outside-test"), "x")
    expect(createInstructionLoader()(root)).toContain("claude rules")
    writeFileSync(path.join(root, "AGENTS.md"), "agents rules")
    const both = createInstructionLoader()(root)
    expect(both).toContain("agents rules")
    expect(both).not.toContain("claude rules")
    rmSync(path.join(path.dirname(root), "AGENTS.md.outside-test"))
  })

  test("large files are bounded and edits are picked up by mtime", () => {
    const root = repo()
    const file = path.join(root, "AGENTS.md")
    writeFileSync(file, "a".repeat(100))
    const load = createInstructionLoader({ maxChars: 20 })
    expect(load(root)).toContain("[… truncated at 20 characters]")
    writeFileSync(file, "short")
    utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    expect(load(root)).toContain("short")
    expect(createInstructionLoader()(mkdtempSync(path.join(tmpdir(), "none-")))).toBe("")
  })

  test("AGENTS.override.md replaces AGENTS.md in its directory only, and the global override replaces the global file", () => {
    const root = repo()
    writeFileSync(path.join(root, "AGENTS.md"), "committed rules")
    writeFileSync(path.join(root, "AGENTS.override.md"), "local rules")
    writeFileSync(path.join(root, "packages", "api", "AGENTS.md"), "api rules")
    const global = path.join(root, "global", "AGENTS.md")
    mkdirSync(path.dirname(global))
    writeFileSync(global, "global rules")
    writeFileSync(path.join(path.dirname(global), "AGENTS.override.md"), "global override")
    const text = createInstructionLoader({ globalFile: global })(path.join(root, "packages", "api"))
    expect(text).toContain("local rules")
    expect(text).not.toContain("committed rules")
    expect(text).toContain("api rules")
    expect(text).toContain("global override")
    expect(text).not.toContain("global rules")
    expect(text).toContain('<instructions source="global">')
  })

  test("fallback names apply only where no standard file exists, and root markers move the project root", () => {
    const root = repo()
    writeFileSync(path.join(root, "TEAM.md"), "team rules")
    expect(createInstructionLoader()(root)).toBe("")
    expect(createInstructionLoader({ fallbacks: () => ["TEAM.md"] })(root)).toContain("team rules")
    writeFileSync(path.join(root, "AGENTS.md"), "agents rules")
    expect(createInstructionLoader({ fallbacks: () => ["TEAM.md"] })(root)).not.toContain("team rules")

    writeFileSync(path.join(root, "packages", "api", "AGENTS.md"), "api rules")
    writeFileSync(path.join(root, "packages", "api", "go.work"), "")
    const bounded = createInstructionLoader({ rootMarkers: () => ["go.work"] })(path.join(root, "packages", "api"))
    expect(bounded).toContain("api rules")
    expect(bounded).not.toContain("agents rules")
    const none = createInstructionLoader({ rootMarkers: () => [] })(path.join(root, "packages", "api"))
    expect(none).toContain("api rules")
    expect(none).not.toContain("agents rules")
    expect(createInstructionLoader({ rootMarkers: () => [".git"] })(path.join(root, "packages", "api"))).toContain("agents rules")
  })
})

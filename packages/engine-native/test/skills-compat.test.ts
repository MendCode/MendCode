import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSkillLoader, createSkillTool } from "../src/skills"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-compat-"))
  dirs.push(dir)
  return dir
}

function skill(root: string, folder: string, content: string) {
  mkdirSync(path.join(root, folder), { recursive: true })
  writeFileSync(path.join(root, folder, "SKILL.md"), content)
}

const claude = [
  "---",
  "name: pdf-tools:extract",
  "description: |",
  "  Extract text from PDF files.",
  "  Use when the user mentions PDFs.",
  "allowed-tools: Read, Bash(pdftotext:*)",
  "model: sonnet",
  "effort: high",
  "argument-hint: <file>",
  "license: MIT",
  "context: fork",
  "hooks:",
  "  PreToolUse: []",
  "---",
  "Extract $ARGUMENTS",
].join("\n")

describe("skill frontmatter follows the other tools' formats", () => {
  test("a Claude Code SKILL.md keeps multi-line descriptions and namespaced names, honours its fields and lists the rest once", () => {
    const user = tmp(), project = tmp()
    skill(path.join(user, "skills"), "extract", claude)
    const loader = createSkillLoader({ userDir: user })
    const [found] = loader.list(project)
    expect(found).toMatchObject({
      name: "pdf-tools:extract", description: "Extract text from PDF files. Use when the user mentions PDFs.",
      allowedTools: ["Read", "Bash(pdftotext:*)"], model: "sonnet", effort: "high", argumentHint: "<file>", userInvocable: true, ignoredFields: ["context", "hooks"],
    })
    expect(found!.notes.join("\n")).toContain("allowed-tools")
    expect(found!.notes.join("\n")).toContain("model")
    expect(loader.block(project)).toContain("- pdf-tools:extract: Extract text from PDF files. Use when the user mentions PDFs.")
    expect(loader.inspect(project).diagnostics.ignored).toEqual([{ kind: "skill", name: "pdf-tools:extract", layer: "user", fields: ["context", "hooks"] }])
  })

  test("dotted names, quoted values and frontmatter past the first 4,000 characters load", () => {
    const user = tmp(), project = tmp()
    skill(path.join(user, "skills"), "lint", `---\nname: "acme.lint"\nmetadata:\n  notes: ${"x".repeat(4_500)}\ndescription: 'Lint: with a colon'\n---\nbody`)
    const loader = createSkillLoader({ userDir: user })
    expect(loader.list(project).map((s) => [s.name, s.description])).toEqual([["acme.lint", "Lint: with a colon"]])
  })

  test("pi and Codex skills with license, compatibility and metadata have nothing ignored", () => {
    const user = tmp(), project = tmp()
    skill(path.join(user, "skills"), "pi-style", "---\nname: pi-style\ndescription: from pi\nlicense: Apache-2.0\ncompatibility: Requires git\nmetadata:\n  author: someone\nallowed-tools: Bash(git:*) Read\n---\nbody")
    skill(path.join(user, "skills"), "codex-style", "---\nname: codex-style\ndescription: from codex\nmetadata:\n  short-description: short\n---\nbody")
    const loader = createSkillLoader({ userDir: user })
    expect(loader.inspect(project).diagnostics.ignored).toEqual([])
    expect(loader.list(project).find((s) => s.name === "pi-style")?.allowedTools).toEqual(["Bash(git:*)", "Read"])
  })

  test("disable-model-invocation leaves the catalog and the model's load, the user can still load it; user-invocable false stays in the catalog", async () => {
    const user = tmp(), project = tmp()
    skill(path.join(user, "skills"), "manual", "---\nname: manual\ndescription: only by hand\ndisable-model-invocation: true\n---\nmanual body")
    skill(path.join(user, "skills"), "internal", "---\nname: internal\ndescription: model only\nuser-invocable: false\n---\ninternal body")
    const loader = createSkillLoader({ userDir: user })
    expect(loader.block(project)).not.toContain("manual")
    expect(loader.block(project)).toContain("internal")
    expect(loader.list(project).find((s) => s.name === "internal")).toMatchObject({ userInvocable: false })
    expect(loader.load(project, "manual")).toBeUndefined()
    expect(loader.load(project, "manual", { user: true })?.body).toBe("manual body")
    const refused = await createSkillTool(loader).execute({ name: "manual" }, { cwd: project, signal: new AbortController().signal })
    expect(refused).toMatchObject({ isError: true })
    expect(refused.output).toContain("disable-model-invocation")
    expect(refused.output).not.toContain("manual body")
  })

  test("the skill tool without a name lists what it can load, and prints the notes of a skill it loads", async () => {
    const user = tmp(), project = tmp()
    skill(path.join(user, "skills"), "extract", claude)
    skill(path.join(user, "skills"), "manual", "---\ndescription: hidden\ndisable-model-invocation: true\n---\nbody")
    const tool = createSkillTool(createSkillLoader({ userDir: user }))
    const signal = new AbortController().signal
    const listing = await tool.execute({}, { cwd: project, signal })
    expect(listing.isError).toBe(false)
    expect(listing.output).toContain("- pdf-tools:extract: Extract text from PDF files.")
    expect(listing.output).not.toContain("manual")
    const loaded = await tool.execute({ name: "pdf-tools:extract" }, { cwd: project, signal })
    expect(loaded.output).toContain("allowed-tools")
  })

  test("a frontmatter that is not YAML still loads through the line fallback", () => {
    const user = tmp(), project = tmp()
    skill(path.join(user, "skills"), "loose", "---\nname: loose\ndescription: use this: when [asked\n---\nbody")
    expect(createSkillLoader({ userDir: user }).list(project).map((s) => [s.name, s.description])).toEqual([["loose", "use this: when [asked"]])
  })
})

describe("precedence before the cap", () => {
  test("a full lower layer cannot push a project skill out of the quota; what is dropped and what is overridden is reported", () => {
    const user = tmp(), project = tmp()
    for (let i = 0; i < 100; i++) skill(path.join(user, "skills"), `u${String(i).padStart(3, "0")}`, `---\ndescription: user ${i}\n---\nbody`)
    skill(path.join(user, "skills"), "release", "---\ndescription: user release\n---\nbody")
    skill(path.join(project, ".mendcode", "skills"), "release", "---\ndescription: project release\n---\nbody")
    skill(path.join(project, ".mendcode", "skills"), "deploy", "---\ndescription: project deploy\n---\nbody")
    const { skills, diagnostics } = createSkillLoader({ userDir: user }).inspect(project)
    expect(skills).toHaveLength(100)
    expect(skills.find((s) => s.name === "deploy")?.source).toBe("project")
    expect(skills.find((s) => s.name === "release")?.description).toBe("project release")
    expect(diagnostics.overridden).toEqual([{ kind: "skill", name: "release", layer: "user", by: "project" }])
    expect(diagnostics.dropped).toHaveLength(2)
    expect(diagnostics.dropped.every((entry) => entry.layer === "user")).toBe(true)
  })
})

describe("symlinked skill folders", () => {
  test("a directory symlink inside the layer is followed like a symlinked SKILL.md; one that leaves the layer is refused and reported", () => {
    const user = tmp(), project = tmp(), outside = tmp()
    const skills = path.join(project, ".mendcode", "skills")
    skill(path.join(project, "shared"), "inside", "---\ndescription: inside the project\n---\nbody")
    skill(outside, "escaped", "---\ndescription: outside\n---\nbody")
    skill(outside, "file-escape", "---\ndescription: outside file\n---\nbody")
    mkdirSync(skills, { recursive: true })
    symlinkSync(path.join(project, "shared", "inside"), path.join(skills, "linked"))
    symlinkSync(path.join(outside, "escaped"), path.join(skills, "escaped"))
    mkdirSync(path.join(skills, "file-link"), { recursive: true })
    symlinkSync(path.join(outside, "file-escape", "SKILL.md"), path.join(skills, "file-link", "SKILL.md"))
    mkdirSync(path.join(skills, "loop"), { recursive: true })
    symlinkSync(skills, path.join(skills, "loop", "again"))
    const { skills: found, diagnostics } = createSkillLoader({ userDir: user }).inspect(project)
    expect(found.map((s) => s.name)).toEqual(["linked"])
    expect(diagnostics.problems.some((p) => p.file.endsWith("escaped") && p.message.includes("outside"))).toBe(true)
    expect(diagnostics.problems.some((p) => p.file.endsWith(path.join("file-link", "SKILL.md")))).toBe(true)
  })
})

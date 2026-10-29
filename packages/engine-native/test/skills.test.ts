import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultLayers, foreignLayers, withForeignLayers } from "@mendcode/packages"
import { createSkillLoader, createSkillTool } from "../src/skills"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-"))
  dirs.push(dir)
  return dir
}

function skill(root: string, folder: string, content: string) {
  mkdirSync(path.join(root, folder), { recursive: true })
  writeFileSync(path.join(root, folder, "SKILL.md"), content)
}

describe("skills", () => {
  test("lists user and project skills with project overriding; the prompt block has names and descriptions only", () => {
    const user = tmp()
    const project = tmp()
    skill(path.join(user, "skills"), "release", "---\nname: release\ndescription: user release steps\n---\nSECRET BODY")
    skill(path.join(user, "skills"), "notes", "---\ndescription: write notes\n---\nbody")
    skill(path.join(project, ".mendcode", "skills"), "release", "---\nname: release\ndescription: project release steps\n---\nproject body")
    const loader = createSkillLoader({ userDir: user })
    expect(loader.list(project).map((s) => `${s.name}:${s.source}`).sort()).toEqual(["notes:user", "release:project"])
    const block = loader.block(project)
    expect(block).toContain("- release: project release steps")
    expect(block).not.toContain("SECRET BODY")
    expect(loader.block(tmp())).toContain("notes")
  })

  test("package layers add skills tagged with their package; the user's own skill of the same name wins", () => {
    const user = tmp()
    const project = tmp()
    const pkg = path.join(user, "packages", "acme")
    skill(path.join(pkg, "skills"), "deploy", "---\ndescription: package deploy\n---\nbody")
    skill(path.join(pkg, "skills"), "lint", "---\ndescription: package lint\n---\nbody")
    skill(path.join(user, "skills"), "lint", "---\ndescription: my lint\n---\nbody")
    const loader = createSkillLoader({ userDir: user, layers: (cwd) => [{ dir: pkg, source: "user", pkg: "acme" }, { dir: user, source: "user" }, { dir: path.join(cwd, ".mendcode"), source: "project" }] })
    expect(loader.list(project).map((s) => [s.name, s.description, s.pkg])).toEqual([
      ["deploy", "package deploy", "acme"],
      ["lint", "my lint", undefined],
    ])
  })

  test("the skill tool loads the body and lists what exists when the name is unknown", async () => {
    const user = tmp()
    skill(path.join(user, "skills"), "deploy", "---\nname: deploy\ndescription: ship it\n---\n1. build\n2. ship")
    const tool = createSkillTool(createSkillLoader({ userDir: user }))
    const signal = new AbortController().signal
    const ok = await tool.execute({ name: "deploy" }, { cwd: tmp(), signal })
    expect(ok.output).toContain("1. build\n2. ship")
    expect(ok.output).toContain(path.join(user, "skills", "deploy"))
    const missing = await tool.execute({ name: "nope" }, { cwd: tmp(), signal })
    expect(missing).toMatchObject({ isError: true, output: "unknown skill: nope (available: deploy)" })
  })

  test("an unknown name lists at most twelve skills, says how many more there are, and where a skill comes from", async () => {
    const user = tmp()
    for (let at = 0; at < 31; at++) skill(path.join(user, "skills"), `skill-${String(at).padStart(2, "0")}`, `---\nname: skill-${String(at).padStart(2, "0")}\ndescription: skill ${at}\n---\nbody`)
    const signal = new AbortController().signal
    const plain = await createSkillTool(createSkillLoader({ userDir: user })).execute({ name: "whittle" }, { cwd: tmp(), signal })
    const withDocs = await createSkillTool(createSkillLoader({ userDir: user }), { docs: "mendcode docs skills" }).execute({ name: "whittle" }, { cwd: tmp(), signal })
    expect(plain.isError).toBe(true)
    const listed = /\(available: ([^)]*)\)/.exec(plain.output)![1]!
    expect(listed.startsWith("skill-00, skill-01")).toBe(true)
    expect(listed).toContain("skill-11, and 19 more: call skill with no name for the full list")
    expect(listed).not.toContain("skill-12")
    expect(plain.output).not.toContain("docs skills")
    expect(withDocs.output).toBe(`${plain.output}. A skill is installed as a SKILL.md in a skills folder or a package, not by naming it: mendcode docs skills`)
    expect(withDocs.output.length).toBeLessThan(500)
    expect((await createSkillTool(createSkillLoader({ userDir: tmp() }), { docs: "mendcode docs skills" }).execute({ name: "x" }, { cwd: tmp(), signal })).output).toContain("(no skills installed). A skill is installed")
  })
})

test("disabled skills remain discoverable but leave the prompt and cannot be loaded by the tool", async () => {
  const user = tmp()
  const project = tmp()
  skill(path.join(user, "skills"), "review", "---\ndescription: Review source\n---\nRead callers")
  const loader = createSkillLoader({ userDir: user, enabled: (cwd, name) => cwd !== project || name !== "review" })
  expect(loader.list(project).map((s) => s.name)).toEqual(["review"])
  expect(loader.block(project)).toBe("")
  expect(loader.block(user)).toContain("review")
  const result = await createSkillTool(loader).execute({ name: "review" }, { cwd: project, signal: new AbortController().signal })
  expect(result).toMatchObject({ isError: true })
  expect(result.output).not.toContain("Read callers")
  expect(result.output).not.toContain("available: review")
})

test("explicit configured skill folders override layer skills, recurse and pick up edits", () => {
  const user = tmp(), project = tmp(), configured = tmp()
  skill(path.join(project, ".mendcode", "skills"), "review", "---\ndescription: project review\n---\nproject body")
  skill(path.join(configured, "team"), "review", "---\ndescription: configured review\n---\nconfigured body")
  const loader = createSkillLoader({ userDir: user, paths: () => [{ dir: configured, source: "user" }] })
  expect(loader.list(project)).toMatchObject([{ name: "review", description: "configured review", source: "user" }])
  expect(loader.load(project, "review")?.body).toBe("configured body")
  skill(path.join(configured, "team"), "review", "---\ndescription: changed\n---\nnew body")
  expect(loader.load(project, "review")?.body).toBe("new body")
})

test("skills of .agents and .claude load under MendCode's own folders, which win on the same name", () => {
  const user = tmp(), project = tmp(), home = tmp()
  skill(path.join(home, ".agents", "skills"), "home-skill", "---\ndescription: from home agents\n---\nhome body")
  skill(path.join(project, ".agents", "skills"), "shared", "---\ndescription: agents shared\n---\nagents body")
  skill(path.join(project, ".claude", "skills"), "shared", "---\ndescription: claude shared\n---\nclaude body")
  skill(path.join(project, ".claude", "skills"), "only-claude", "---\ndescription: claude only\n---\nclaude only body")
  skill(path.join(project, ".mendcode", "skills"), "shared", "---\ndescription: mendcode shared\n---\nnative body")
  const loader = createSkillLoader({
    userDir: user,
    layers: (cwd) => withForeignLayers(defaultLayers({ userDir: user, directory: cwd }), foreignLayers({ directory: cwd, home }), user),
  })
  const found = Object.fromEntries(loader.list(project).map((entry) => [entry.name, entry.description]))
  expect(found).toEqual({ "home-skill": "from home agents", shared: "mendcode shared", "only-claude": "claude only" })
  expect(loader.load(project, "shared")?.body).toBe("native body")
  expect(loader.load(project, "only-claude")?.body).toBe("claude only body")
})

test("a skills folder reached through a symlink is named by its real path, so the skill's own ../ references resolve", async () => {
  const user = tmp()
  const repo = tmp()
  // The layout of a config repo linked into the home: <repo>/claude/skills is the linked folder, <repo>/codex holds what the skill points at.
  skill(path.join(repo, "claude/skills"), "design", "---\nname: design\ndescription: adapter\n---\nRead `../../../codex/SKILL.md` relative to this file's real directory.")
  symlinkSync(path.join(repo, "claude/skills"), path.join(user, "skills"))
  const loaded = await createSkillTool(createSkillLoader({ userDir: user })).execute({ name: "design" }, { cwd: tmp(), signal: new AbortController().signal })
  const folder = /^Skill folder: (.*)$/m.exec(loaded.output)![1]!
  expect(folder).toBe(path.join(realpathSync(repo), "claude/skills/design"))
  expect(path.resolve(folder, "../../../codex/SKILL.md")).toBe(path.join(realpathSync(repo), "codex/SKILL.md"))
})

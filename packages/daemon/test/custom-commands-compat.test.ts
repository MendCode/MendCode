import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultLayers, emptyDiagnostics, foreignLayers, withForeignLayers } from "@mendcode/packages"
import { loadCustomCommands } from "../src/custom-commands"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), "cmds-compat-"))
  dirs.push(dir)
  return dir
}
function put(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

describe("command frontmatter follows the other tools' formats", () => {
  test("a Claude Code command keeps its multi-line description and fields; model and agent are applied softly, unknown fields are listed", async () => {
    const project = tmp(), user = tmp(), home = tmp()
    put(path.join(project, ".claude", "commands", "triage.md"), "---\ndescription: |\n  Review a pull request\n  with care\nallowed-tools: Bash(gh pr:*), Read\nargument-hint: [pr-number]\nmodel: sonnet\nagent: Explore\nsubtask: true\ncontext: fork\n---\nReview PR $ARGUMENTS")
    const report = emptyDiagnostics()
    const layers = withForeignLayers(defaultLayers({ userDir: user, directory: project }), foreignLayers({ directory: project, home }), user)
    const command = (await loadCustomCommands({ directory: project, userDir: user, layers, report })).find((entry) => entry.name === "triage")!
    expect(command).toMatchObject({ description: "Review a pull request with care", argumentHint: "[pr-number]", allowedTools: ["Bash(gh pr:*)", "Read"], model: "sonnet", agent: "Explore", subtask: true, foreign: true })
    expect(report.ignored).toEqual([{ kind: "command", name: "triage", layer: ".claude (project)", fields: ["context"] }])
    expect(report.notes.some((note) => note.name === "triage" && note.note.includes("allowed-tools"))).toBe(true)
  })

  test("a Codex prompt with named placeholders loads and says they are not substituted", async () => {
    const project = tmp(), user = tmp()
    put(path.join(user, "commands", "draftpr.md"), '---\ndescription: Prepare a PR\nargument-hint: FILES=<paths> PR_TITLE="<title>"\n---\nDraft a PR titled $PR_TITLE touching $FILES')
    const report = emptyDiagnostics()
    const command = (await loadCustomCommands({ directory: project, userDir: user, report })).find((entry) => entry.name === "draftpr")!
    expect(command).toMatchObject({ description: "Prepare a PR", argumentHint: 'FILES=<paths> PR_TITLE="<title>"' })
    expect(report.notes.some((note) => note.name === "draftpr" && note.note.includes("$ARGUMENTS"))).toBe(true)
  })

  test("a native command with agent, model and subtask keeps them without a note", async () => {
    const project = tmp(), user = tmp()
    put(path.join(project, ".mendcode", "commands", "audit.md"), "---\ndescription: Audit\nagent: explore\nmodel: gpt-5.4\nsubtask: true\n---\nAudit $ARGUMENTS")
    const report = emptyDiagnostics()
    const command = (await loadCustomCommands({ directory: project, userDir: user, report })).find((entry) => entry.name === "audit")!
    expect(command).toMatchObject({ agent: "explore", model: "gpt-5.4", subtask: true })
    expect(command.foreign).toBeUndefined()
    expect(report.notes).toEqual([])
  })
})

describe("one invalid command file does not stop the rest", () => {
  test("bad native files and a broken mendcode.json are listed while the good commands load", async () => {
    const project = tmp(), user = tmp()
    put(path.join(project, ".mendcode", "commands", "good.md"), "Good $ARGUMENTS")
    put(path.join(project, ".mendcode", "commands", "bad-subtask.md"), "---\nsubtask: maybe\n---\nbody")
    put(path.join(project, ".mendcode", "commands", "too-long.md"), `---\ndescription: ${"d".repeat(200)}\n---\nbody`)
    put(path.join(project, ".mendcode", "commands", "empty.md"), "")
    put(path.join(user, "mendcode.json"), "{ not json")
    put(path.join(user, "commands", "fine.md"), "Fine")
    const report = emptyDiagnostics()
    const commands = await loadCustomCommands({ directory: project, userDir: user, report })
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(["good", "fine"]))
    expect(commands.map((c) => c.name)).not.toContain("bad-subtask")
    expect(report.problems.map((p) => path.basename(p.file)).sort()).toEqual(["bad-subtask.md", "empty.md", "mendcode.json", "too-long.md"])
  })

  test("without a report the loader still returns what loaded", async () => {
    const project = tmp(), user = tmp()
    put(path.join(project, ".mendcode", "commands", "good.md"), "Good")
    put(path.join(project, ".mendcode", "commands", "bad.md"), "---\nsubtask: maybe\n---\nbody")
    expect((await loadCustomCommands({ directory: project, userDir: user })).map((c) => c.name)).toContain("good")
  })
})

describe("precedence before the cap, collisions reported", () => {
  test("a project command survives a full user folder; overridden commands name the layer that wins", async () => {
    const project = tmp(), user = tmp()
    for (let i = 0; i < 210; i++) put(path.join(user, "commands", `u${String(i).padStart(3, "0")}.md`), `user ${i}`)
    put(path.join(user, "commands", "release.md"), "user release")
    put(path.join(project, ".mendcode", "commands", "release.md"), "project release")
    put(path.join(project, ".mendcode", "commands", "deploy.md"), "project deploy")
    put(path.join(project, ".mendcode", "commands", "init.md"), "my own init")
    const report = emptyDiagnostics()
    const commands = await loadCustomCommands({ directory: project, userDir: user, report })
    expect(commands.find((c) => c.name === "deploy")?.source).toBe("project")
    expect(commands.find((c) => c.name === "release")?.body).toBe("project release")
    expect(commands.find((c) => c.name === "init")?.source).toBe("project")
    expect(commands.filter((c) => c.source !== "builtin")).toHaveLength(200)
    expect(report.overridden).toEqual(expect.arrayContaining([{ kind: "command", name: "release", layer: "user", by: "project" }, { kind: "command", name: "init", layer: "built-in", by: "project" }]))
    expect(report.dropped.length).toBeGreaterThan(0)
    expect(report.dropped.every((entry) => entry.layer === "user")).toBe(true)
  })
})

describe("skills as slash commands", () => {
  const skill = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} skill`, source: "user" as const, layer: "user", userInvocable: true, ...extra })

  test("a user-invocable skill becomes /name; built-in and custom commands win a collision, which is reported; hidden and dotted names are left out", async () => {
    const project = tmp(), user = tmp()
    put(path.join(user, "commands", "release.md"), "release command")
    const report = emptyDiagnostics()
    const commands = await loadCustomCommands({ directory: project, userDir: user, report, skills: [skill("pdf-tools:extract", { argumentHint: "<file>", model: "sonnet" }), skill("init"), skill("release"), skill("internal", { userInvocable: false }), skill("acme.lint")] })
    expect(commands.find((c) => c.name === "pdf-tools:extract")).toMatchObject({ skill: true, source: "user", description: "pdf-tools:extract skill", argumentHint: "<file>", model: "sonnet", foreign: true })
    expect(commands.find((c) => c.name === "init")?.source).toBe("builtin")
    expect(commands.find((c) => c.name === "release")?.body).toBe("release command")
    expect(commands.some((c) => c.name === "internal" || c.name === "acme.lint")).toBe(false)
    expect(report.overridden).toEqual(expect.arrayContaining([{ kind: "skill", name: "init", layer: "user", by: "built-in command" }, { kind: "skill", name: "release", layer: "user", by: "user command" }]))
    expect(report.notes.some((note) => note.name === "acme.lint" && note.note.includes("slash"))).toBe(true)
  })
})

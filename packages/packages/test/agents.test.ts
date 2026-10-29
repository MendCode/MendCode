import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers, installPackage, listPackages, parseAgentFile, parseAgentFrontmatter, readLayerAgents, toolMatches } from "../src"

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const agentFile = (frontmatter: string, body = "Do the thing.") => `---\n${frontmatter}\n---\n${body}`
const parse = (text: string, stem = "helper") => parseAgentFile({ text, stem, file: `/x/${stem}.md`, source: "user" })

describe("agent frontmatter", () => {
  test("scalars, inline lists, comma lists and block lists", () => {
    const parsed = parseAgentFrontmatter(agentFile('name: "reviewer"\ntools: [read, grep]\ndeny: shell, write\nmodel: gpt-6-sol\nextra:\n  - a\n  - "b c"'))
    expect(parsed).toEqual({ data: { name: "reviewer", tools: ["read", "grep"], deny: "shell, write", model: "gpt-6-sol", extra: ["a", "b c"] }, body: "Do the thing." })
  })

  test("a file without frontmatter has none, and a bad line is named", () => {
    expect(parseAgentFrontmatter("just text")).toEqual({ data: {}, body: "just text" })
    expect(parseAgentFrontmatter("---\nnot a pair\n---\nbody")).toEqual({ problem: "expected a mapping" })
  })

  test("a valid file becomes an agent: the name defaults to the file name, mode to all, the body is the prompt", () => {
    const result = parse(agentFile("description: Reviews diffs\ntools: read, grep\ndeny: [shell]\npermission: ask\neffort: high\nmode: primary\nmodel: gpt-6-sol", "  Review carefully.\n"))
    expect(result).toEqual({
      agent: { name: "helper", description: "Reviews diffs", mode: "primary", model: "gpt-6-sol", effort: "high", tools: ["read", "grep"], deny: ["shell"], permission: "ask", prompt: "Review carefully.", file: "/x/helper.md", source: "user" },
    })
    expect(parse(agentFile("description: minimal"))).toMatchObject({ agent: { name: "helper", mode: "all", prompt: "Do the thing." } })
    expect(parse(agentFile("name: renamed\ndescription: d"), "file-stem")).toMatchObject({ agent: { name: "renamed" } })
  })

  test("invalid files say why", () => {
    const problem = (frontmatter: string, stem = "helper") => {
      const result = parse(agentFile(frontmatter), stem)
      return "problem" in result ? result.problem : undefined
    }
    expect(problem("tools: read")).toContain("description is required")
    expect(problem("description: d\nmode: boss")).toContain("mode must be primary, subagent, all")
    expect(problem("description: d\npermission: root")).toContain("permission must be plan, ask, smart, edits, full")
    expect(problem("description: d\neffort: extreme")).toContain("effort must be")
    expect(problem("description: d\ntools: [bad name]")).toContain("is not a tool name")
    expect(problem("description: d\nmodel: two words")).toContain("model must be one model id")
    expect(parse(agentFile("description: d\nfavourite: blue"))).toMatchObject({ agent: { options: { favourite: "blue" } } })
    expect(problem("description: d", "Bad_Name")).toContain("agent names use lowercase")
    expect(parse(agentFile("description: d"), "build")).toMatchObject({ agent: { name: "build", mode: "primary" } })
    expect(parse(agentFile("description: d\nname: plan"), "x")).toMatchObject({ agent: { name: "plan" } })
    expect(problem(`description: ${"x".repeat(301)}`)).toContain("longer than 300")
    const huge = parse(agentFile("description: d", "y".repeat(16_001)))
    expect("problem" in huge && huge.problem).toContain("prompt is longer")
  })

  test("v1 generation settings are preserved and validated", () => {
    expect(parse(agentFile("description: d\ntemperature: 0.2\ncolor: accent\nsteps: 10\nhidden: false"))).toMatchObject({ agent: { temperature: 0.2, color: "accent", steps: 10, hidden: false } })
  })

  test("tool patterns match exactly or by prefix with a trailing *", () => {
    expect(toolMatches("read", ["read"])).toBe(true)
    expect(toolMatches("mcp__github__issues", ["mcp__github__*"])).toBe(true)
    expect(toolMatches("mcp__gitlab__issues", ["mcp__github__*"])).toBe(false)
    expect(toolMatches("reader", ["read"])).toBe(false)
  })
})

describe("agents per layer", () => {
  function layout() {
    const userDir = temp("agents-user-")
    const directory = temp("agents-project-")
    return { userDir, directory, projectDir: path.join(directory, ".mendcode") }
  }

  test("user, project and package agents are found; the later layer wins a name, the project's own last", () => {
    const { userDir, directory, projectDir } = layout()
    write(path.join(userDir, "packages", "acme", "agents", "shared.md"), agentFile("description: from the user package"))
    write(path.join(userDir, "packages", "acme", "agents", "pkg-only.md"), agentFile("description: only in the package"))
    write(path.join(userDir, "agents", "shared.md"), agentFile("description: from the user folder"))
    write(path.join(projectDir, "packages", "tools", "agents", "shared.md"), agentFile("description: from a project package"))
    write(path.join(projectDir, "agents", "shared.md"), agentFile("description: from the project folder"))
    write(path.join(projectDir, "agents", "notes.txt"), "not an agent")
    const { agents, problems } = readLayerAgents(extensionLayers({ userDir, directory }), { projectTrusted: true })
    expect(problems).toEqual([])
    expect(agents.map((a) => [a.name, a.description, a.source, a.pkg])).toEqual([
      ["pkg-only", "only in the package", "user", "acme"],
      ["shared", "from the project folder", "project", undefined],
    ])
  })

  test("project agents need the directory's trust: listed and flagged when untrusted, never shadowing a trusted one", () => {
    const { userDir, directory, projectDir } = layout()
    write(path.join(userDir, "agents", "shared.md"), agentFile("description: the user's"))
    write(path.join(projectDir, "agents", "shared.md"), agentFile("description: the project's"))
    write(path.join(projectDir, "agents", "theirs.md"), agentFile("description: only the project has it"))
    write(path.join(projectDir, "packages", "p", "agents", "pk.md"), agentFile("description: a project package's"))
    const untrusted = readLayerAgents(extensionLayers({ userDir, directory }), { projectTrusted: false }).agents
    expect(untrusted.map((a) => [a.name, a.description, a.trusted])).toEqual([
      ["pk", "a project package's", false],
      ["shared", "the user's", true],
      ["shared", "the project's", false],
      ["theirs", "only the project has it", false],
    ])
    const trusted = readLayerAgents(extensionLayers({ userDir, directory }), { projectTrusted: true }).agents
    expect(trusted.map((a) => [a.name, a.description, a.trusted])).toEqual([
      ["pk", "a project package's", true],
      ["shared", "the project's", true],
      ["theirs", "only the project has it", true],
    ])
  })

  test("broken files are reported with their path and do not hide the good ones", () => {
    const { userDir, directory } = layout()
    write(path.join(userDir, "agents", "good.md"), agentFile("description: fine"))
    write(path.join(userDir, "agents", "bad.md"), agentFile("tools: read"))
    write(path.join(userDir, "agents", "big.md"), agentFile("description: d", "z".repeat(40_000)))
    const { agents, problems } = readLayerAgents(extensionLayers({ userDir, directory }), { projectTrusted: true })
    expect(agents.map((a) => a.name)).toEqual(["good"])
    expect(problems.map((p) => [path.basename(p.file), p.message.slice(0, 26)])).toEqual([
      ["bad.md", "description is required: i"],
      ["big.md", "larger than 32 KB"],
    ])
  })

  test("a package's agents/ folder is counted in its contents and travels with an install", async () => {
    const userDir = temp("agents-user-")
    const directory = temp("agents-project-")
    const src = temp("agents-src-")
    write(path.join(src, "mendcode-package.json"), JSON.stringify({ name: "acme", version: "1.0.0", description: "Acme" }))
    write(path.join(src, "agents", "one.md"), agentFile("description: one"))
    write(path.join(src, "agents", "two.md"), agentFile("description: two"))
    write(path.join(src, "agents", ".hidden.md"), agentFile("description: hidden"))
    expect(await installPackage({ spec: src, scope: "user", userDir, directory })).toMatchObject({ contents: { agents: 2 } })
    expect(listPackages({ userDir, directory })[0]).toMatchObject({ key: "user:acme", contents: { agents: 2 } })
    const { agents } = readLayerAgents(extensionLayers({ userDir, directory }), { projectTrusted: true })
    expect(agents.map((a) => [a.name, a.pkg])).toEqual([["one", "acme"], ["two", "acme"]])
  })
})


test("v1 nested and JSON permission maps preserve rule order alongside the v2 mode cap", () => {
  const nested = parse(agentFile('description: Audit\npermission:\n  read:\n    "*": allow\n    "*/private/*": deny\n  bash:\n    "git *": ask'), "audit")
  expect(nested).toMatchObject({ agent: { permissionRules: [{ permission: "read", pattern: "*", action: "allow" }, { permission: "read", pattern: "*/private/*", action: "deny" }, { permission: "bash", pattern: "git *", action: "ask" }] } })
  expect(parse(agentFile('description: Audit\npermission: {"read":"deny"}'), "audit")).toMatchObject({ agent: { permissionRules: [{ permission: "read", pattern: "*", action: "deny" }] } })
  expect(parse(agentFile('description: Audit\npermission: plan\npermissionRules: [{"permission":"read","pattern":"*/a","action":"ask"}]'), "audit")).toMatchObject({ agent: { permission: "plan", permissionRules: [{ action: "ask" }] } })
  expect(parse(agentFile('description: Audit\npermission:\n  read: maybe'), "audit")).toHaveProperty("problem")
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultLayers, foreignLayers, layerReads, parseAgentFile, readLayerAgents, withForeignLayers } from "../src"

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foreign-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("foreign layers", () => {
  test("project .agents (skills only) and .claude are found; home ones only when a home is given", () => {
    const project = tmp(), home = tmp()
    mkdirSync(path.join(project, ".agents"))
    mkdirSync(path.join(project, ".claude"))
    mkdirSync(path.join(home, ".claude"))
    const layers = foreignLayers({ directory: project, home })
    expect(layers.project.map((layer) => path.basename(layer.dir))).toEqual([".agents", ".claude"])
    expect(layers.user.map((layer) => path.basename(layer.dir))).toEqual([".claude"])
    expect(foreignLayers({ directory: project }).user).toEqual([])
    const [agents, claude] = layers.project
    expect(layerReads(agents!, "skills")).toBe(true)
    expect(layerReads(agents!, "commands")).toBe(false)
    expect(layerReads(claude!, "agents")).toBe(true)
    expect(layerReads(claude!, "tools")).toBe(false)
    expect(layerReads({}, "tools")).toBe(true)
  })

  test("a project .claude symlinked outside the project is skipped", () => {
    const project = tmp(), outside = tmp()
    symlinkSync(outside, path.join(project, ".claude"))
    expect(foreignLayers({ directory: project }).project).toEqual([])
  })

  test("foreign layers sit under the native layer of their scope", () => {
    const project = tmp(), home = tmp(), user = tmp()
    mkdirSync(path.join(project, ".claude"))
    mkdirSync(path.join(home, ".claude"))
    const layers = withForeignLayers(defaultLayers({ userDir: user, directory: project }), foreignLayers({ directory: project, home }), user)
    expect(layers.map((layer) => (layer.foreign ? `foreign-${layer.source}` : layer.source))).toEqual(["foreign-user", "user", "foreign-project", "project"])
    expect(withForeignLayers(defaultLayers({ userDir: user, directory: project }), { user: [], project: [] }, user)).toHaveLength(2)
  })

  test("claude agents keep name, description, mapped tools and the permission cap; an alias model and color are not applied", () => {
    const text = [
      "---",
      "name: code-reviewer",
      "description: Reviews code. Use after edits.",
      "tools: Read, Grep, Bash, WebFetch, mcp__x__y, Unknown(thing)",
      "disallowedTools: Write",
      "model: sonnet",
      "color: red",
      "permissionMode: acceptEdits",
      "---",
      "You review code.",
    ].join("\n")
    const parsed = parseAgentFile({ text, stem: "code-reviewer", file: "x.md", source: "project", foreign: true })
    if ("problem" in parsed) throw new Error(parsed.problem)
    expect(parsed.agent).toMatchObject({ name: "code-reviewer", mode: "all", tools: ["read", "grep", "shell", "webfetch", "mcp__x__y"], deny: ["write"], permission: "edits", prompt: "You review code." })
    expect("warnings" in parsed && parsed.warnings?.join("\n")).toContain("Unknown(thing)")
    expect(parsed.agent.model).toBeUndefined()
    expect(parsed.agent.options).toBeUndefined()
    expect(parseAgentFile({ text: "---\nname: build\ndescription: x\n---\nhi", stem: "build", file: "x.md", source: "user", foreign: true })).toEqual({ problem: "name is reserved by MendCode" })
  })

  test("readLayerAgents reads .claude/agents but never .agents, skips misfits quietly and lets native agents win", () => {
    const project = tmp(), user = tmp()
    mkdirSync(path.join(project, ".claude", "agents"), { recursive: true })
    mkdirSync(path.join(project, ".agents", "agents"), { recursive: true })
    mkdirSync(path.join(project, ".mendcode", "agents"), { recursive: true })
    writeFileSync(path.join(project, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: claude reviewer\n---\nclaude prompt")
    writeFileSync(path.join(project, ".claude", "agents", "docs.md"), "---\nname: docs\ndescription: docs agent\n---\ndocs prompt")
    writeFileSync(path.join(project, ".claude", "agents", "broken.md"), "---\nname: broken\n---\nno description")
    writeFileSync(path.join(project, ".agents", "agents", "hidden.md"), "---\nname: hidden\ndescription: should not load\n---\nx")
    writeFileSync(path.join(project, ".mendcode", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: native reviewer\n---\nnative prompt")
    const layers = withForeignLayers(defaultLayers({ userDir: user, directory: project }), foreignLayers({ directory: project }), user)
    const { agents, problems } = readLayerAgents(layers, { projectTrusted: true })
    expect(problems).toEqual([])
    expect(agents.map((agent) => `${agent.name}:${agent.description}`)).toEqual(["docs:docs agent", "reviewer:native reviewer"])
    const untrusted = readLayerAgents(layers, { projectTrusted: false }).agents
    expect(untrusted.every((agent) => !agent.trusted)).toBe(true)
  })
})

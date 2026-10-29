import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseAgentFile, readLayerAgents, toolMatches, type AgentDefinition, type ExtensionLayer } from "../src"

/** The engine's rule (`agentAllows`): on the allow list when there is one, and not denied. */
const agentAllows = (agent: Pick<AgentDefinition, "tools" | "deny">, tool: string) => (!agent.tools || toolMatches(tool, agent.tools)) && !(agent.deny && toolMatches(tool, agent.deny))

/** Converting a Claude Code agent file never widens what the agent may do, and says what it could not honour. */

const claude = (frontmatter: string[], modelExists?: (id: string) => boolean) => {
  const parsed = parseAgentFile({ text: ["---", "name: helper", "description: Helps.", ...frontmatter, "---", "Do the thing."].join("\n"), stem: "helper", file: "x.md", source: "project", foreign: true, ...(modelExists ? { modelExists } : {}) })
  if ("problem" in parsed) throw new Error(parsed.problem)
  return parsed
}
const warnings = (parsed: ReturnType<typeof claude>) => ("warnings" in parsed ? parsed.warnings ?? [] : []).join("\n")

describe("tools", () => {
  test("an allowlist of only unknown names grants no tools at all, and the warning names them", () => {
    const parsed = claude(["tools: Foo, Bar(baz)"])
    expect(parsed.agent.tools).toEqual([])
    expect(warnings(parsed)).toContain("Foo")
    expect(warnings(parsed)).toContain("Bar")
    for (const tool of ["read", "shell", "write", "edit", "task"]) expect(agentAllows(parsed.agent, tool)).toBe(false)
  })

  test("`tools: Skill` keeps the restriction: only the skill tool", () => {
    const parsed = claude(["tools: Skill"])
    expect(parsed.agent.tools).toEqual(["skill"])
    expect(agentAllows(parsed.agent, "shell")).toBe(false)
  })

  test("a mixed allowlist keeps the tools that map and warns about the rest", () => {
    const parsed = claude(["tools: Read, Foo, Grep"])
    expect(parsed.agent.tools).toEqual(["read", "grep"])
    expect(warnings(parsed)).toContain("Foo")
  })

  test("a qualified allow entry grants nothing (a path or command filter cannot be honoured, and the bare tool would be wider)", () => {
    const parsed = claude(["tools: Read, Bash(git status:*)"])
    expect(parsed.agent.tools).toEqual(["read"])
    expect(agentAllows(parsed.agent, "shell")).toBe(false)
    expect(warnings(parsed)).toContain("Bash(git status:*)")
  })

  test("a qualified deny entry denies the whole tool: dropping the qualifier is the stricter reading", () => {
    const parsed = claude(["disallowedTools: Bash(rm:*), Write"])
    expect(parsed.agent.deny).toEqual(["shell", "write"])
    expect(agentAllows(parsed.agent, "shell")).toBe(false)
    expect(warnings(parsed)).toContain("Bash(rm:*)")
  })

  test("no tools field still means every tool, and an empty one is the same as none written", () => {
    expect(claude([]).agent.tools).toBeUndefined()
    expect(claude(["tools:"]).agent.tools).toBeUndefined()
    expect(warnings(claude([]))).toBe("")
  })
})

describe("permissionMode", () => {
  test("plan stays plan and acceptEdits becomes edits", () => {
    expect(claude(["permissionMode: plan"]).agent.permission).toBe("plan")
    expect(claude(["permissionMode: acceptEdits"]).agent.permission).toBe("edits")
  })

  test("bypassPermissions is never granted by a file, and says so", () => {
    const parsed = claude(["permissionMode: bypassPermissions"])
    expect(parsed.agent.permission).toBeUndefined()
    expect(warnings(parsed)).toContain("bypassPermissions")
  })

  test("default and an unknown mode add no cap; the unknown one warns", () => {
    expect(claude(["permissionMode: default"]).agent.permission).toBeUndefined()
    const parsed = claude(["permissionMode: whatever"])
    expect(parsed.agent.permission).toBeUndefined()
    expect(warnings(parsed)).toContain("whatever")
  })

  test("a native agent file keeps its own `permission` field untouched", () => {
    const parsed = parseAgentFile({ text: "---\ndescription: x\npermission: full\n---\nhi", stem: "native", file: "x.md", source: "user" })
    if ("problem" in parsed) throw new Error(parsed.problem)
    expect(parsed.agent.permission).toBe("full")
    expect("warnings" in parsed).toBe(false)
  })
})

describe("model and effort", () => {
  test("a model the catalog has is used, with its effort", () => {
    const parsed = claude(["model: gpt-5.4", "effort: high"], (id) => id === "gpt-5.4")
    expect(parsed.agent).toMatchObject({ model: "gpt-5.4", effort: "high" })
  })

  test("an alias or unknown model is not applied and the warning says the session's model is used; its effort goes with it", () => {
    const parsed = claude(["model: sonnet", "effort: high"], () => false)
    expect(parsed.agent.model).toBeUndefined()
    expect(parsed.agent.effort).toBeUndefined()
    expect(warnings(parsed)).toContain("sonnet")
    expect(warnings(claude(["model: sonnet"]))).toContain("sonnet")
  })

  test("inherit means the session's model and needs no warning", () => {
    const parsed = claude(["model: inherit"], () => true)
    expect(parsed.agent.model).toBeUndefined()
    expect(warnings(parsed)).toBe("")
  })
})

describe("other Claude fields", () => {
  test("fields with no equivalent are listed in one warning; color alone is not", () => {
    expect(warnings(claude(["color: red"]))).toBe("")
    const parsed = claude(["color: red", "skills: [a]", "hooks: {}", "maxTurns: 3"])
    expect(warnings(parsed)).toContain("skills")
    expect(warnings(parsed)).toContain("hooks")
    expect(warnings(parsed)).toContain("maxturns")
    expect(parsed.agent.options).toBeUndefined()
  })
})

describe("readLayerAgents reports the warnings", () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  test("a warning of a .claude agent appears as a problem with the file, and the agent is still listed with no widening", () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-agents-"))
    dirs.push(root)
    mkdirSync(path.join(root, "agents"), { recursive: true })
    const file = path.join(root, "agents", "helper.md")
    writeFileSync(file, "---\nname: helper\ndescription: Helps.\ntools: Foo\npermissionMode: plan\n---\nbody")
    const layer: ExtensionLayer = { dir: root, source: "project", foreign: { kinds: ["agents"], origin: "claude" } }
    const { agents, problems } = readLayerAgents([layer], { projectTrusted: true })
    expect(agents.map((agent) => [agent.name, agent.tools, agent.permission])).toEqual([["helper", [], "plan"]])
    expect(problems.some((problem) => problem.file === file && problem.message.includes("Foo"))).toBe(true)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import type { PermissionMode, Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { createNativeEngine, memoryHistory, type ModelEvent } from "../src"
import { instructionRootRead, type InstructionRoots } from "../src/instruction-reads"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "instruction-reads-"))); dirs.push(dir); return dir }
const write = (file: string, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }

/** A skills repository outside the project, reached through a symlinked `skills` folder (as ~/.claude/skills often is). */
function layout() {
  const repo = temp(), home = temp(), project = temp()
  write(path.join(repo, "skills", "design", "SKILL.md"), "---\nname: design\n---\nbody")
  write(path.join(repo, "skills", "design", "references", "ui.md"))
  write(path.join(repo, "skills", "other-notes.md"))
  write(path.join(repo, "AGENTS.md"))
  write(path.join(repo, "README.md"))
  symlinkSync(path.join(repo, "skills"), path.join(home, "skills"))
  const roots: InstructionRoots = { dirs: [path.join(home, "skills", "design")], files: [path.join(repo, "AGENTS.md")] }
  return { repo, home, project, roots, skill: path.join(home, "skills", "design") }
}

function scenario(steps: ModelEvent[][], project: string, roots: InstructionRoots | undefined, settings: Pick<Settings, "permission"> = {}) {
  const log: string[] = []
  const tools = ["read", "grep", "write"].map((name) => defineTool({ name, description: name, permission: name === "write" ? "write" : "read", args: z.object({ path: z.string().optional(), pattern: z.string().optional() }), execute: async (args) => { log.push(`${name}:${args.path}`); return { output: "ok", title: name, isError: false, truncated: false } } }))
  const { provider } = scriptedProvider(steps)
  const engine = createNativeEngine({ provider, tools, history: memoryHistory(), cwdFor: () => project, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings, ...(roots ? { instructionRoots: () => roots } : {}) })
  return { engine, log }
}

async function run(input: { tool: string; args: Record<string, unknown>; project: string; roots: InstructionRoots | undefined; mode?: PermissionMode; settings?: Pick<Settings, "permission"> }) {
  const s = scenario([callTool(input.tool, input.args), stop("ok")], input.project, input.roots, input.settings)
  const t = turn({ text: "go", mode: () => input.mode ?? "smart" })
  await s.engine.runTurn(t.input)
  return { asked: t.asked.map((request) => request.title), log: s.log }
}

describe("smart mode reads MendCode's own skills and instructions without the external-directory prompt", () => {
  test("a read inside a loaded skill folder runs, through the symlinked path and the real one", async () => {
    const { repo, project, roots, skill } = layout()
    for (const target of [path.join(skill, "SKILL.md"), path.join(repo, "skills", "design", "references", "ui.md")]) {
      const result = await run({ tool: "read", args: { path: target }, project, roots })
      expect(result).toEqual({ asked: [], log: [`read:${target}`] })
    }
  })

  test("a loaded instruction file is read without asking; its folder's other files still ask", async () => {
    const { repo, project, roots } = layout()
    expect(await run({ tool: "read", args: { path: path.join(repo, "AGENTS.md") }, project, roots })).toEqual({ asked: [], log: [`read:${path.join(repo, "AGENTS.md")}`] })
    expect((await run({ tool: "read", args: { path: path.join(repo, "README.md") }, project, roots })).asked).toEqual(["external directory access"])
  })

  test("a write inside a skill folder still asks", async () => {
    const { project, roots, skill } = layout()
    const result = await run({ tool: "write", args: { path: path.join(skill, "SKILL.md") }, project, roots })
    expect(result.asked).toContain("external directory access")
    expect(result.log).toEqual([])
  })

  test("a sibling outside the skill folder, a `..` climb and a symlink that leaves the folder ask", async () => {
    const { repo, project, roots, skill } = layout()
    symlinkSync(path.join(repo, "README.md"), path.join(repo, "skills", "design", "escape.md"))
    for (const target of [path.join(repo, "skills", "other-notes.md"), `${skill}/../other-notes.md`, path.join(skill, "escape.md")]) {
      const result = await run({ tool: "read", args: { path: target }, project, roots })
      expect(result).toEqual({ asked: ["external directory access"], log: [] })
    }
  })

  test("secrets inside a skill folder ask, and so does a grep over a folder that holds one", async () => {
    const { project, roots, skill } = layout()
    for (const name of [".env", "auth.json", "credentials.json", "id_rsa"]) write(path.join(skill, "private", name))
    for (const name of [".env", "auth.json", "credentials.json", "id_rsa"]) {
      const result = await run({ tool: "read", args: { path: path.join(skill, "private", name) }, project, roots })
      expect(result).toEqual({ asked: ["external directory access"], log: [] })
    }
    expect((await run({ tool: "grep", args: { path: skill, pattern: "x" }, project, roots })).asked).toEqual(["external directory access"])
    expect((await run({ tool: "grep", args: { path: path.join(skill, "references"), pattern: "x" }, project, roots })).asked).toEqual([])
  })

  test("only smart mode: ask mode keeps the prompt; an explicit external_directory deny still wins", async () => {
    const { project, roots, skill } = layout()
    const target = path.join(skill, "SKILL.md")
    expect((await run({ tool: "read", args: { path: target }, project, roots, mode: "ask" })).asked).toEqual(["external directory access"])
    const denied = await run({ tool: "read", args: { path: target }, project, roots, settings: { permission: { external_directory: { [path.join(realpathSync(skill), "*")]: "deny" } } } })
    expect(denied).toEqual({ asked: [], log: [] })
  })

  test("without the daemon's roots nothing changes", async () => {
    const { project, skill } = layout()
    expect((await run({ tool: "read", args: { path: path.join(skill, "SKILL.md") }, project, roots: undefined })).asked).toEqual(["external directory access"])
  })
})

describe("instructionRootRead", () => {
  test("names only read tools and rejects glob patterns that climb out", () => {
    const { project, roots, skill } = layout()
    expect(instructionRootRead({ tool: "glob", args: { path: skill, pattern: "**/*.md" }, cwd: project, roots })).toBe(true)
    expect(instructionRootRead({ tool: "glob", args: { path: skill, pattern: "../**/*.md" }, cwd: project, roots })).toBe(false)
    expect(instructionRootRead({ tool: "glob", args: { path: skill, patterns: ["/etc/*"] }, cwd: project, roots })).toBe(false)
    expect(instructionRootRead({ tool: "ls", args: { path: skill }, cwd: project, roots })).toBe(true)
    for (const tool of ["write", "edit", "apply_patch", "shell"]) expect(instructionRootRead({ tool, args: { path: path.join(skill, "SKILL.md"), command: `cat ${skill}/SKILL.md` }, cwd: project, roots })).toBe(false)
  })

  test("a call with one target outside the roots is not covered, nor a grep of an instruction file's folder", () => {
    const { repo, project, roots, skill } = layout()
    expect(instructionRootRead({ tool: "read", args: { paths: [{ path: path.join(skill, "SKILL.md") }, { path: path.join(repo, "README.md") }] }, cwd: project, roots })).toBe(false)
    expect(instructionRootRead({ tool: "grep", args: { path: path.join(repo, "AGENTS.md"), pattern: "x" }, cwd: project, roots })).toBe(false)
    expect(instructionRootRead({ tool: "grep", args: { path: repo, pattern: "x" }, cwd: project, roots })).toBe(false)
  })

  test("a filesystem root is never a skill folder", () => {
    const { project, repo } = layout()
    expect(instructionRootRead({ tool: "read", args: { path: path.join(repo, "README.md") }, cwd: project, roots: { dirs: ["/"], files: [] } })).toBe(false)
  })
})

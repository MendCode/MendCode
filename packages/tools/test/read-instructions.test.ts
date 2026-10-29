import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInstructionLoader, instructionChain, read } from "../src"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()
const withClaims = (cwd: string) => ({ ...makeContext({ cwd }), loadedInstructions: new Set<string>() })

describe("the read tool loads nearby instructions with the system prompt's rules", () => {
  test("AGENTS.override.md replaces AGENTS.md in its directory, like the hierarchical loader", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "src/AGENTS.md", content: "COMMITTED" })
    put({ root: cwd, path: "src/AGENTS.override.md", content: "LOCAL OVERRIDE" })
    put({ root: cwd, path: "src/a.ts", content: "a" })
    const output = (await read.execute({ path: "src/a.ts" }, withClaims(cwd))).output
    expect(output).toContain("LOCAL OVERRIDE")
    expect(output).not.toContain("COMMITTED")
  })

  test("@includes resolve from the file and stay inside the project; fallback names apply", async () => {
    const cwd = tmp()
    const outside = put({ root: tmp(), path: "outside.md", content: "OUTSIDE" })
    put({ root: cwd, path: "src/AGENTS.md", content: `SCOPED\n@rules/style.md\n@${path.relative(path.join(cwd, "src"), outside)}` })
    put({ root: cwd, path: "src/rules/style.md", content: "STYLE RULES" })
    put({ root: cwd, path: "lib/TEAM.md", content: "TEAM FALLBACK" })
    put({ root: cwd, path: "src/a.ts", content: "a" })
    put({ root: cwd, path: "lib/b.ts", content: "b" })
    const context = { ...withClaims(cwd), instructions: { fallbacks: () => ["TEAM.md"] } }
    const first = (await read.execute({ path: "src/a.ts" }, context)).output
    expect(first).toContain("SCOPED")
    expect(first).toContain("STYLE RULES")
    expect(first).not.toContain("OUTSIDE")
    expect((await read.execute({ path: "lib/b.ts" }, context)).output).toContain("TEAM FALLBACK")
    const off = { ...withClaims(cwd), instructions: { includes: () => false } }
    expect((await read.execute({ path: "src/a.ts" }, off)).output).not.toContain("STYLE RULES")
  })

  test("outer directories come first, as in the system prompt", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "a/AGENTS.md", content: "OUTER" })
    put({ root: cwd, path: "a/b/AGENTS.md", content: "INNER" })
    put({ root: cwd, path: "a/b/c.ts", content: "c" })
    const output = (await read.execute({ path: "a/b/c.ts" }, withClaims(cwd))).output
    expect(output.indexOf("OUTER")).toBeGreaterThan(-1)
    expect(output.indexOf("OUTER")).toBeLessThan(output.indexOf("INNER"))
  })

  test("an edited instruction file is injected again; an unchanged one is not", async () => {
    const cwd = tmp()
    const file = put({ root: cwd, path: "src/AGENTS.md", content: "VERSION ONE" })
    put({ root: cwd, path: "src/a.ts", content: "a" })
    const context = withClaims(cwd)
    const first = await read.execute({ path: "src/a.ts" }, context)
    expect(first.output).toContain("VERSION ONE")
    for (const claim of first.loadedInstructions ?? []) context.loadedInstructions.add(claim)
    const again = await read.execute({ path: "src/a.ts" }, context)
    expect(again.output).not.toContain("VERSION ONE")
    writeFileSync(file, "VERSION TWO, longer")
    utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    const edited = await read.execute({ path: "src/a.ts" }, context)
    expect(edited.output).toContain("VERSION TWO")
  })

  test("a CLAUDE.md that only includes AGENTS.md, or links to it, loads the rules once", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "inc/AGENTS.md", content: "SHARED RULES" })
    put({ root: cwd, path: "inc/CLAUDE.md", content: "@AGENTS.md" })
    put({ root: cwd, path: "inc/a.ts", content: "a" })
    put({ root: cwd, path: "link/AGENTS.md", content: "LINKED RULES" })
    symlinkSync(path.join(cwd, "link", "AGENTS.md"), path.join(cwd, "link", "CLAUDE.md"))
    put({ root: cwd, path: "link/b.ts", content: "b" })
    for (const [target, rules] of [["inc/a.ts", "SHARED RULES"], ["link/b.ts", "LINKED RULES"]] as const) {
      const output = (await read.execute({ path: target }, withClaims(cwd))).output
      expect(output.split(rules).length - 1).toBe(1)
    }
  })

  test("the system prompt loader and the read tool agree on the same layout", async () => {
    const cwd = tmp()
    mkdirSync(path.join(cwd, ".git"))
    put({ root: cwd, path: "pkg/AGENTS.md", content: "PKG BASE" })
    put({ root: cwd, path: "pkg/AGENTS.override.md", content: "PKG LOCAL\n@extra.md" })
    put({ root: cwd, path: "pkg/extra.md", content: "PKG EXTRA" })
    put({ root: cwd, path: "pkg/a.ts", content: "a" })
    const prompt = createInstructionLoader()(path.join(cwd, "pkg"))
    const output = (await read.execute({ path: "pkg/a.ts" }, withClaims(cwd))).output
    for (const text of ["PKG LOCAL", "PKG EXTRA"]) { expect(prompt).toContain(text); expect(output).toContain(text) }
    for (const text of ["PKG BASE"]) { expect(prompt).not.toContain(text); expect(output).not.toContain(text) }
  })
})

describe("the upward walk never reaches the filesystem root", () => {
  test("without a root marker it stops at the home directory", () => {
    const home = tmp()
    const project = path.join(home, "work", "app")
    mkdirSync(project, { recursive: true })
    expect(instructionChain(project, { home })).toEqual([home, path.join(home, "work"), project])
  })

  test("without a root marker and outside the home only the session directory is used", () => {
    const home = tmp(), elsewhere = tmp()
    const project = path.join(elsewhere, "srv", "app")
    mkdirSync(project, { recursive: true })
    expect(instructionChain(project, { home })).toEqual([project])
  })

  test("a root marker inside the home wins over the home bound", () => {
    const home = tmp()
    const repo = path.join(home, "repo")
    mkdirSync(path.join(repo, ".git"), { recursive: true })
    mkdirSync(path.join(repo, "pkg"))
    expect(instructionChain(path.join(repo, "pkg"), { home })).toEqual([repo, path.join(repo, "pkg")])
  })

  test("an AGENTS.md above the home or at / is never loaded", () => {
    const outer = tmp()
    const home = path.join(outer, "home")
    const project = path.join(home, "app")
    mkdirSync(project, { recursive: true })
    writeFileSync(path.join(outer, "AGENTS.md"), "ABOVE HOME")
    writeFileSync(path.join(home, "AGENTS.md"), "HOME RULES")
    expect(createInstructionLoader({ home })(project)).toContain("HOME RULES")
    expect(createInstructionLoader({ home })(project)).not.toContain("ABOVE HOME")
  })
})

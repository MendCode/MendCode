import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionLayer } from "@mendcode/packages"
import { readContracts, readWorkflowPlans } from "../src/workflow-files"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
}

const contract = (text: string) => ({ criteria: [{ id: "tests", text, owners: ["impl"] }], checks: [{ id: "unit", command: "bun test", covers: ["tests"] }] })
const plan = (name: string, extra: Record<string, unknown> = {}) => ({ name, objective: "Do it.", tasks: [{ kind: "agent", id: "impl", title: "Impl", prompt: "go" }], ...extra })

/** user package → user files → project files, lowest precedence first, like `extensionLayers`. */
function layers() {
  const pkg = temp("wf-pkg-")
  const user = temp("wf-user-")
  const project = temp("wf-proj-")
  const list: ExtensionLayer[] = [
    { dir: pkg, source: "user", pkg: "shipped" },
    { dir: user, source: "user" },
    { dir: path.join(project, ".mendcode"), source: "project" },
  ]
  return { pkg, user, project: path.join(project, ".mendcode"), list }
}

describe("readContracts", () => {
  test("a later layer replaces a contract of the same name and keeps where it came from", () => {
    const { pkg, user, project, list } = layers()
    write(path.join(pkg, "contracts", "release-gate.json"), contract("from the package"))
    write(path.join(pkg, "contracts", "docs.json"), contract("docs"))
    write(path.join(user, "contracts", "release-gate.json"), contract("from the user"))
    write(path.join(project, "contracts", "release-gate.json"), contract("from the project"))
    const found = readContracts(list)
    expect(found.map((item) => [item.name, item.source, item.pkg, item.contract?.criteria[0]?.text])).toEqual([
      ["docs", "user", "shipped", "docs"],
      ["release-gate", "project", undefined, "from the project"],
    ])
    expect(found[1]!.file).toBe(path.join(project, "contracts", "release-gate.json"))
    expect(found.every((item) => item.problem === undefined)).toBe(true)
  })

  test("defaults are filled in by the schema", () => {
    const { user, list } = layers()
    write(path.join(user, "contracts", "min.json"), { criteria: [{ id: "k", text: "x" }] })
    expect(readContracts(list)[0]!.contract).toEqual({ criteria: [{ id: "k", text: "x", required: true }], checks: [], audit: "auto", maxRepairs: 2, maxAudits: 2 })
  })

  test("invalid files are listed with a problem and do not hide the valid ones", () => {
    const { user, list } = layers()
    write(path.join(user, "contracts", "good.json"), contract("ok"))
    write(path.join(user, "contracts", "bad-json.json"), "{ nope")
    write(path.join(user, "contracts", "empty.json"), { criteria: [] })
    write(path.join(user, "contracts", "extra-field.json"), { ...contract("x"), threshold: 1 })
    write(path.join(user, "contracts", "shell.json"), { criteria: [{ id: "k", text: "x" }], checks: [{ id: "g", command: "bun test | tee out" }] })
    write(path.join(user, "contracts", "dupes.json"), { criteria: [{ id: "k", text: "x" }, { id: "k", text: "y" }] })
    write(path.join(user, "contracts", "dangling.json"), { criteria: [{ id: "k", text: "x" }], checks: [{ id: "g", command: "bun test", covers: ["ghost"] }] })
    write(path.join(user, "contracts", "Bad Name.json"), contract("x"))
    write(path.join(user, "contracts", "notes.txt"), "ignored")
    const byName = new Map(readContracts(list).map((item) => [item.name, item]))
    expect([...byName.keys()].sort()).toEqual(["Bad Name", "bad-json", "dangling", "dupes", "empty", "extra-field", "good", "shell"])
    expect(byName.get("good")!.problem).toBeUndefined()
    expect(byName.get("bad-json")!.problem).toContain("invalid JSON")
    expect(byName.get("empty")!.problem).toContain("criteria")
    expect(byName.get("extra-field")!.problem).toContain("threshold")
    expect(byName.get("shell")!.problem).toContain("shell syntax")
    expect(byName.get("dupes")!.problem).toContain('criterion id "k"')
    expect(byName.get("dangling")!.problem).toContain('unknown criterion "ghost"')
    expect(byName.get("Bad Name")!.problem).toContain("lowercase")
    for (const name of ["bad-json", "empty", "extra-field", "shell", "dupes", "dangling", "Bad Name"]) expect(byName.get(name)!.contract).toBeUndefined()
  })

  test("an invalid file in a later layer still replaces the valid one it shadows", () => {
    const { user, project, list } = layers()
    write(path.join(user, "contracts", "gate.json"), contract("fine"))
    write(path.join(project, "contracts", "gate.json"), "not json")
    const [only, ...rest] = readContracts(list)
    expect(rest).toEqual([])
    expect(only).toMatchObject({ name: "gate", source: "project" })
    expect(only!.problem).toContain("invalid JSON")
  })

  test("a contract file over 16 KB is refused without being parsed", () => {
    const { user, list } = layers()
    write(path.join(user, "contracts", "big.json"), JSON.stringify(contract("x")) + " ".repeat(16 * 1024))
    write(path.join(user, "contracts", "fits.json"), JSON.stringify(contract("x")) + " ".repeat(1_000))
    const byName = new Map(readContracts(list).map((item) => [item.name, item]))
    expect(byName.get("big")!.problem).toBe("larger than 16 KB")
    expect(byName.get("fits")!.problem).toBeUndefined()
  })

  test("a folder named like a contract or a missing layer never throws", () => {
    const { user, list } = layers()
    mkdirSync(path.join(user, "contracts", "folder.json"), { recursive: true })
    const found = readContracts(list)
    expect(found).toHaveLength(1)
    expect(found[0]!.problem).toBe("not readable")
    expect(readContracts([{ dir: path.join(user, "nowhere"), source: "user" }])).toEqual([])
    expect(readContracts([])).toEqual([])
  })

  test("at most 100 contracts are read, but an existing name can still be replaced", () => {
    const { user, project, list } = layers()
    for (let i = 0; i < 120; i++) write(path.join(user, "contracts", `c${String(i).padStart(3, "0")}.json`), contract("user"))
    write(path.join(project, "contracts", "c000.json"), contract("project"))
    write(path.join(project, "contracts", "extra.json"), contract("project"))
    const found = readContracts(list)
    expect(found).toHaveLength(100)
    expect(found.find((item) => item.name === "c000")!.contract!.criteria[0]!.text).toBe("project")
    expect(found.some((item) => item.name === "c099")).toBe(true)
    expect(found.some((item) => item.name === "c100" || item.name === "extra")).toBe(false)
  })
})

describe("readWorkflowPlans", () => {
  test("a later layer replaces a plan of the same name and the plan is fully validated with defaults", () => {
    const { user, project, list } = layers()
    write(path.join(user, "workflows", "api-rewrite.json"), plan("user version"))
    write(path.join(user, "workflows", "docs.json"), plan("docs", { contract: "release-gate", permission: "edits" }))
    write(path.join(project, "workflows", "api-rewrite.json"), plan("project version"))
    const found = readWorkflowPlans(list)
    expect(found.map((item) => [item.name, item.source, item.plan?.name])).toEqual([
      ["docs", "user", "docs"],
      ["api-rewrite", "project", "project version"],
    ])
    expect(found[1]!.plan!.tasks[0]).toMatchObject({ needs: [], mode: "work" })
    expect(found[0]!.plan).toMatchObject({ contract: "release-gate", permission: "edits" })
  })

  test("graph and command problems are reported per file", () => {
    const { user, list } = layers()
    const agent = (id: string, needs: string[]) => ({ kind: "agent", id, title: id, prompt: "go", needs })
    write(path.join(user, "workflows", "cycle.json"), plan("c", { tasks: [agent("a", ["b"]), agent("b", ["a"])] }))
    write(path.join(user, "workflows", "ghost.json"), plan("g", { tasks: [agent("a", ["nobody"])] }))
    write(path.join(user, "workflows", "shell.json"), plan("s", { tasks: [{ kind: "check", id: "c", title: "C", command: "bun test && rm x" }] }))
    write(path.join(user, "workflows", "unknown-field.json"), plan("u", { phases: [] }))
    write(path.join(user, "workflows", "broken.json"), "[")
    const byName = new Map(readWorkflowPlans(list).map((item) => [item.name, item]))
    expect(byName.get("cycle")!.problem).toContain("cycle")
    expect(byName.get("ghost")!.problem).toContain('unknown task "nobody"')
    expect(byName.get("shell")!.problem).toContain('check task "c"')
    expect(byName.get("unknown-field")!.problem).toContain("phases")
    expect(byName.get("broken")!.problem).toContain("invalid JSON")
    for (const item of byName.values()) expect(item.plan).toBeUndefined()
  })

  test("plans may be up to 64 KB while contracts stop at 16 KB", () => {
    const { user, list } = layers()
    const fits = JSON.stringify(plan("wide", { objective: "o".repeat(7_000) }))
    write(path.join(user, "workflows", "medium.json"), fits + " ".repeat(30 * 1024))
    write(path.join(user, "workflows", "huge.json"), fits + " ".repeat(64 * 1024))
    const byName = new Map(readWorkflowPlans(list).map((item) => [item.name, item]))
    expect(byName.get("medium")!.problem).toBeUndefined()
    expect(byName.get("huge")!.problem).toBe("larger than 64 KB")
  })

  test("a bad file name is listed with a problem and plans and contracts do not see each other's folder", () => {
    const { user, list } = layers()
    write(path.join(user, "workflows", "Api Rewrite.json"), plan("x"))
    write(path.join(user, "contracts", "only-contract.json"), contract("x"))
    const plans = readWorkflowPlans(list)
    expect(plans.map((item) => item.name)).toEqual(["Api Rewrite"])
    expect(plans[0]!.problem).toContain("lowercase")
    expect(readContracts(list).map((item) => item.name)).toEqual(["only-contract"])
  })
})

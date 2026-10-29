import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_AGENT_FILES, readLayerAgents, type ExtensionLayer } from "../src"

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "agents-precedence-"))
  cleanups.push(dir)
  return dir
}
function agent(layerDir: string, name: string, description: string) {
  mkdirSync(path.join(layerDir, "agents"), { recursive: true })
  writeFileSync(path.join(layerDir, "agents", `${name}.md`), `---\ndescription: ${description}\n---\nBody of ${name}.`)
}

test("a full lower layer cannot push a project agent out of the quota; overrides and drops are reported", () => {
  const user = temp(), project = temp()
  for (let i = 0; i < MAX_AGENT_FILES; i++) agent(user, `u${String(i).padStart(3, "0")}`, `user ${i}`)
  agent(user, "reviewer", "user reviewer")
  agent(project, "reviewer", "project reviewer")
  agent(project, "deploy", "project deploy")
  const layers: ExtensionLayer[] = [{ dir: user, source: "user" }, { dir: project, source: "project" }]
  const { agents, problems, overridden } = readLayerAgents(layers, { projectTrusted: true })
  expect(agents).toHaveLength(MAX_AGENT_FILES)
  expect(agents.find((entry) => entry.name === "deploy")?.source).toBe("project")
  expect(agents.find((entry) => entry.name === "reviewer")?.description).toBe("project reviewer")
  expect(overridden).toEqual([{ kind: "agent", name: "reviewer", layer: "user", by: "project" }])
  expect(problems.filter((problem) => problem.message.includes("left out"))).toHaveLength(2)
})

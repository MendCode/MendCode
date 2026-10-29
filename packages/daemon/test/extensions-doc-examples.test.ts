import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers } from "@mendcode/packages"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createExtensions } from "../src/extensions"

// Every TypeScript block of docs/extensions.md loads as a daemon extension without an error, every member of the daemon API has an
// example there, and the examples that answer something answer what the text beside them says.

const repo = path.resolve(import.meta.dir, "../../..")
const doc = readFileSync(path.join(repo, "docs/extensions.md"), "utf8")
const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!)
const asModule = (block: string, index: number) =>
  /^export default|^import /m.test(block) ? block : `export default { name: "doc-${index}", daemon(api) {\n${block}\n} }\n`

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tmp = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `ext-doc-${label}-`)))
  dirs.push(dir)
  return dir
}

const shell = defineTool({ name: "shell", description: "shell", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command }) => ({ output: `ran ${command}`, truncated: false, title: "shell", isError: false }) })

function load(sources: ReadonlyArray<readonly [string, string]>) {
  const user = tmp("user")
  const project = tmp("project")
  for (const [file, source] of sources) {
    mkdirSync(path.join(user, "extensions"), { recursive: true })
    writeFileSync(path.join(user, "extensions", file), source)
  }
  const ext = createExtensions({
    dataDir: user,
    layersFor: (directory) => extensionLayers({ userDir: user, directory }),
    isTrusted: () => true,
    notify: () => {},
    log: () => {},
    hookTimeoutMs: 1_000,
    builtinTools: () => [shell],
    isDisabled: () => false,
  })
  return { ext, project }
}

function members(typeName: string) {
  const source = readFileSync(path.join(repo, "packages/extension-api/src/index.ts"), "utf8")
  const body = source.slice(source.indexOf(`export type ${typeName} = {`)).split("\n").slice(1)
  const names: string[] = []
  for (const line of body) {
    if (line.startsWith("}")) break
    const member = /^ {2}(?:readonly )?([a-zA-Z]+)\??[(<:]/.exec(line)?.[1]
    if (member && !names.includes(member)) names.push(member)
  }
  return names
}

test("every daemon API member has an example in a code block of docs/extensions.md", () => {
  const code = blocks.join("\n")
  const missing = members("DaemonExtensionAPI").filter((name) => !["version", "dir", "dataDir"].includes(name) && !new RegExp(`\\bapi\\.${name}\\b`).test(code))
  expect(missing).toEqual([])
})

test("every TypeScript block of docs/extensions.md loads as a daemon extension with no error", async () => {
  const { ext, project } = load(blocks.map((block, index) => [`doc-${index}.ts`, asModule(block, index)] as const))
  const list = await ext.list(project)
  expect(list).toHaveLength(blocks.length)
  expect(list.filter((entry) => entry.errors.length > 0).map((entry) => [entry.name, entry.errors])).toEqual([])
})

test("the clock example adds a tool and wraps shell so npm publish is refused and everything else runs", async () => {
  const clock = blocks.find((block) => block.includes('name: "clock"'))!
  const { ext, project } = load([["clock.ts", clock]])
  const tools = await ext.tools(project, "s1")
  expect(tools.map((tool) => tool.name).sort()).toEqual(["clock", "shell"])
  const context = { cwd: project, signal: new AbortController().signal }
  const time = await tools.find((tool) => tool.name === "clock")!.execute({ zone: "America/Panama" }, context)
  expect(time).toMatchObject({ isError: false })
  expect(time.output).toMatch(/\d{1,2}:\d{2}:\d{2}/)
  const wrapped = tools.find((tool) => tool.name === "shell")!
  expect(await wrapped.execute({ command: "npm publish" }, context)).toMatchObject({ output: "publishing runs in CI, not here", isError: true })
  expect(await wrapped.execute({ command: "ls" }, context)).toMatchObject({ output: "ran ls", isError: false })
})

test("the registerAuth example offers one API-key method for acme", async () => {
  const auth = blocks.find((block) => block.startsWith("api.registerAuth"))!
  const { ext, project } = load([["acme.ts", asModule(auth, 0)]])
  expect((await ext.authMethods(project)).map((entry) => [entry.provider, entry.methods.map((method) => method.type)])).toEqual([["acme", ["api"]]])
})

test("the deploy dialog example answers with its defaults when no terminal can ask", async () => {
  const deploy = blocks.find((block) => block.includes('"Deploy to"'))!
  const { ext, project } = load([["deploy.ts", asModule(deploy, 0)]])
  expect(await ext.routeInput({ sessionId: "s1", cwd: project }, "deploy the docs")).toEqual({ kind: "submit", text: "deploy the docs (target: preview)" })
  expect(await ext.routeInput({ sessionId: "s1", cwd: project }, "hello")).toEqual({ kind: "submit", text: "hello" })
})

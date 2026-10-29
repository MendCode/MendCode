import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { TUI_DEFAULTS } from "@mendcode/protocol/wire"
import type { TuiActions, UsageSnapshot } from "@mendcode/extension-api"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { discoverExtensions } from "../src/extensions/discover"
import { extension, scratch } from "./extensions-harness"

// Every TypeScript block of docs/extensions-tui.md loads as a terminal extension without a problem, every member of the terminal
// API has an example there, and the examples do what the comment above them says.

const repo = path.resolve(import.meta.dir, "../../..")
const doc = readFileSync(path.join(repo, "docs/extensions-tui.md"), "utf8")
const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!)
// The row-plugin adapter block (it imports its types) is a different module shape, covered by the plugin tests.
const extensionBlocks = blocks.filter((block) => !/^import /m.test(block))
const asModule = (block: string, index: number) => /^export default/m.test(block) ? block : extension(`doc-${index}`, block)
const find = (marker: string) => {
  const block = extensionBlocks.find((candidate) => candidate.includes(marker))
  if (!block) throw new Error(`no block of docs/extensions-tui.md contains ${marker}`)
  return block
}

const temporary: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })
async function runtime(sources: readonly string[], options: Parameters<typeof createExtensionRuntime>[0] = { redraw() {} }) {
  const temp = scratch()
  temporary.push(temp)
  sources.forEach((source, index) => temp.write(`data/extensions/doc-${index}.ts`, source))
  const instance = createExtensionRuntime(options)
  await instance.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
  return instance
}
const slot = { width: 40, height: 10, now: 0, directory: "/project", state: "idle" as const }
// Rows come padded to the slot's width; the trailing blanks are not what the example drew.
const joined = (rows: ReadonlyArray<ReadonlyArray<{ text: string }>> | undefined) => rows?.map((row) => row.map((span) => span.text).join("").trimEnd()).join("\n")

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

test("every terminal API member has an example in a code block of docs/extensions-tui.md", () => {
  const code = blocks.join("\n")
  const missing = members("TuiExtensionAPI").filter((name) => !["version", "dir"].includes(name) && !new RegExp(`\\bapi\\.${name}\\b`).test(code))
  expect(missing).toEqual([])
})

test("every TypeScript block of docs/extensions-tui.md loads on its own with no problem", async () => {
  for (const [index, block] of extensionBlocks.entries()) {
    const instance = await runtime([asModule(block, index)])
    expect({ index, problems: instance.problems, failed: instance.failed }).toEqual({ index, problems: [], failed: [] })
    instance.dispose()
  }
})

test("the markdown and renderMessage examples change only the roles they name", async () => {
  const instance = await runtime([asModule(find("api.markdown("), 0), asModule(find('api.renderMessage("user"'), 1)])
  expect(instance.markdown("fix the TODO list", { role: "assistant", text: "" }, 40)).toBe("fix the **TODO** list")
  expect(instance.markdown("src/app.ts is slow", { role: "user", text: "" }, 40)).toBe("`src/app.ts` is slow")
  expect(joined(instance.message({ role: "user", text: "one\n\ntwo" }, 40))).toBe("> one\n> two")
  expect(instance.message({ role: "assistant", text: "answer" }, 40)).toBeUndefined()
  instance.dispose()
})

test("the prompt example leads the first row with λ and moves the cursor two cells", async () => {
  const instance = await runtime([asModule(find("api.prompt.replace"), 0)])
  expect(instance.promptChrome()).toMatchObject({ preset: "minimal" })
  const prompt = instance.prompt({ ...slot, text: "ab\ncd", lines: ["ab", "cd"], cursor: { row: 1, col: 1 } })!
  expect(joined(prompt.lines)).toBe("λ ab\n  cd")
  expect(prompt.cursor).toEqual({ row: 1, col: 3 })
  instance.dispose()
})

test("the widget example draws the same panel in the tray and the sidebar", async () => {
  const instance = await runtime([asModule(find('api.widget("tray"'), 0)])
  for (const surface of ["tray", "sidebar"] as const) {
    const [where] = instance.widgets(surface, { ...slot, branch: "main", model: "luna" })
    expect(where?.title).toBe("Where")
    expect(joined(where?.body)).toBe("main\nluna")
  }
  expect(joined(instance.widgets("tray", slot)[0]?.body)).toBe("no branch\nno model")
  instance.dispose()
})

test("the settings example turns the default unified diff into auto and leaves a chosen view alone", async () => {
  for (const [chosen, expected] of [["unified", "auto"], ["split", "split"]] as const) {
    let settings: Record<string, unknown> = { ...TUI_DEFAULTS, diffView: chosen }
    const options = { redraw() {}, settings: { get: (key?: string) => key === undefined ? structuredClone(settings) : settings[key], set: (values: Record<string, unknown>) => { settings = { ...settings, ...values } } } }
    const instance = await runtime([asModule(find('api.settings.get("diffView")'), 0)], options)
    expect(settings.diffView).toBe(expected)
    instance.dispose()
  }
})

test("the uptime example counts from the moment its copy starts", async () => {
  const instance = await runtime([asModule(find('name: "uptime"'), 0)])
  instance.start()
  const now = Date.now()
  expect(joined(instance.footerRows("footer.right", { ...slot, now: now + 5_000 }))).toMatch(/^up [45]s$/)
  instance.dispose()
})

test("the usage example shows the fullest quota window, warning from 80 % and dim when stale", async () => {
  const reading = (window: string, usedPercent: number, stale = false) => ({ provider: "codex", window, usedPercent, leftPercent: 100 - usedPercent, observedAt: 0, ageMs: 0, stale })
  let quota: UsageSnapshot["quota"] = []
  const usage = { read: (): UsageSnapshot => ({ tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, quota }) }
  const instance = await runtime([asModule(find("api.usage().quota"), 0)], { redraw() {}, usage })
  expect(instance.footerRows("footer.left", slot)).toEqual([])
  quota = [reading("5h", 31.4), reading("7d", 82.2)]
  expect(instance.footerRows("footer.left", slot)[0]).toEqual([expect.objectContaining({ text: "7d 82%", fg: "warning" })])
  quota = [reading("7d", 90, true)]
  expect(instance.footerRows("footer.left", slot)[0]).toEqual([expect.objectContaining({ text: "7d 90%", fg: "muted" })])
  expect(instance.problems).toEqual([])
  instance.dispose()
})

test("the notes example keeps notes from /note, opens them on a page and clears them with x", async () => {
  const instance = await runtime([asModule(find('api.page("notes"'), 0)])
  const opened: string[] = []
  const toasts: string[] = []
  const actions = { openPage: (id: string) => void opened.push(id), toast: (text: string) => void toasts.push(text) } as unknown as TuiActions
  expect(joined(instance.renderPage("notes", slot))).toBe("No notes yet: /note <text>")
  instance.runCommand("note", " buy milk ", actions)
  instance.runCommand("note", "call Ana", actions)
  expect(toasts).toEqual(["1 notes", "2 notes"])
  instance.runCommand("note", "", actions)
  expect(opened).toEqual(["notes"])
  expect(instance.pageTitle("notes")).toBe("Notes")
  expect(joined(instance.renderPage("notes", slot))).toBe("• buy milk\n• call Ana")
  let redraws = 0
  expect(instance.pageKey("notes", "y", { close() {}, redraw: () => void redraws++ })).toBe(false)
  expect(instance.pageKey("notes", "x", { close() {}, redraw: () => void redraws++ })).toBe(true)
  expect(redraws).toBe(1)
  expect(joined(instance.renderPage("notes", slot))).toBe("No notes yet: /note <text>")
  instance.dispose()
})

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { scratch } from "../../../apps/cli/test/extensions-harness"
import { createCustomizeUiTool, footerExtensions, footerRowNotes } from "../src/customize-ui"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function sandbox() { const temp = scratch(); cleanups.push(temp.cleanup); return { dir: temp.dataDir, project: temp.project } }
const ROWS = [["directory", "text:tagline"], ["quota:codex"]]
const extension = (dir: string, file: string, source: string) => { mkdirSync(path.join(dir, "extensions"), { recursive: true }); writeFileSync(path.join(dir, "extensions", file), `${source}\n`) }

describe("what customize_ui does after a model set footer rows", () => {
  test("a text segment with no footerText entry is named, with the entries that exist", () => {
    expect(footerRowNotes({ footerRows: ROWS })).toEqual(['text:tagline draws nothing: footerText has no "tagline"; set footerText {"tagline":"..."}'])
    expect(footerRowNotes({ footerRows: ROWS, footerText: { motto: "x" } })[0]).toContain("(it has motto)")
    expect(footerRowNotes({ footerRows: ROWS, footerText: { tagline: "keep the contract" } })).toEqual([])
    expect(footerRowNotes({})).toEqual([])
  })

  test("the extensions in the way are those that fill a footer slot and are still on, by the name /extensions uses", () => {
    const { dir } = sandbox()
    extension(dir, "matrix-footer.ts", 'export default { name: "matrix", tui(api) { api.slot("footer.replace", () => []) } }')
    extension(dir, "side.js", 'export default { tui(api) { api.slot("footer.right", () => []) } }')
    extension(dir, "header.ts", 'export default { name: "h", tui(api) { api.slot("header.replace", () => []) } }')
    expect(footerExtensions(dir, {})).toEqual(["matrix", "side"])
    expect(footerExtensions(dir, { disabledUiExtensions: ["matrix"] })).toEqual(["side"])
    expect(footerExtensions(sandbox().dir, {})).toEqual([])
  })

  test("setting rows switches such an extension off in the same call, keeps its file and what was already off, and says so", async () => {
    const { dir, project } = sandbox()
    extension(dir, "old.ts", 'export default { name: "old-footer", tui(api) { api.slot("footer.left", () => []) } }')
    const changes: unknown[] = []
    const tool = createCustomizeUiTool(dir, async () => ({ revision: 1, errors: [], terminalValidation: "pending" as const }), (event) => changes.push(event))
    const run = async (values: Record<string, unknown>) => JSON.parse((await tool.execute({ action: "settings", values } as never, { cwd: project, signal: new AbortController().signal } as never)).output) as { notes?: string[] }
    expect((await run({ disabledUiExtensions: ["other"] })).notes).toBeUndefined()
    const set = await run({ footerRows: ROWS, footerText: { tagline: "x" } })
    expect(set.notes).toEqual([expect.stringMatching(/^switched off extension old-footer: .*\/extensions.*Tell the user\.$/)])
    const last = changes.at(-1) as { type: string; profile: { disabledUiExtensions: string[]; footerRows: string[][] } }
    expect([last.type, last.profile.disabledUiExtensions, last.profile.footerRows]).toEqual(["tui.changed", ["other", "old-footer"], ROWS])
    expect(existsSync(path.join(dir, "extensions", "old.ts"))).toBe(true)
    // Nothing left to switch off, and a call that is not about the rows says nothing.
    expect((await run({ footerRows: ROWS })).notes).toBeUndefined()
    expect((await run({ footerIcons: "glyph" })).notes).toBeUndefined()
  })

  test("the user's own choice stands: a call that sets disabledUiExtensions itself, or clears the rows, switches nothing off", async () => {
    const { dir, project } = sandbox()
    extension(dir, "old.ts", 'export default { name: "old-footer", tui(api) { api.slot("footer.left", () => []) } }')
    const changes: unknown[] = []
    const tool = createCustomizeUiTool(dir, async () => ({ revision: 1, errors: [], terminalValidation: "pending" as const }), (event) => changes.push(event))
    const run = async (values: Record<string, unknown>) => JSON.parse((await tool.execute({ action: "settings", values } as never, { cwd: project, signal: new AbortController().signal } as never)).output) as { notes?: string[] }
    expect((await run({ footerRows: ROWS, footerText: { tagline: "x" }, disabledUiExtensions: [] })).notes).toBeUndefined()
    expect((await run({ footerRows: [] })).notes).toBeUndefined()
    expect((changes.at(-1) as { profile: { disabledUiExtensions: string[] } }).profile.disabledUiExtensions).toEqual([])
  })
})

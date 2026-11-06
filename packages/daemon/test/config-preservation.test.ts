import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProviderService } from "../src/providers"
import { createPromptModes } from "../src/prompt-modes"
import { createAcpSettings } from "../../store/src/acp-settings"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function box(name: string, raw: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "config-preserve-")); dirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, JSON.stringify(raw))
  return { dir, file, read: () => JSON.parse(readFileSync(file, "utf8")) }
}
test("provider edits keep future root fields, invalid entries and unknown fields of the edited entry", () => {
  const raw = { future: 1, providers: { future: { type: "future-wire", enabled: "future" }, openai: { enabled: false, future: { a: 1 } } } }
  const b = box("providers.json", raw)
  const service = createProviderService({ dir: b.dir, env: {} })
  expect(service.set({ id: "openai", enabled: true }).ok).toBe(true)
  expect(b.read()).toMatchObject({ ...raw, providers: { ...raw.providers, openai: { enabled: true, future: { a: 1 } } } })
})
test("ACP agent edits preserve unknown fields and other invalid agents", () => {
  const b = box("acp-agents.json", { agent: { command: "agent", future: 1 }, future: { command: 7 } })
  createAcpSettings(b.dir).prepare({ agent: { command: "updated" } })()
  expect(b.read()).toEqual({ agent: { command: "updated", future: 1 }, future: { command: 7 } })
})
test("prompt mode edits do not replace an unparseable sibling with its fallback", () => {
  const b = box("prompt-context.json", {})
  const modes = createPromptModes(b.dir)
  const directory = modes.status(b.dir).directory
  writeFileSync(b.file, JSON.stringify({ [directory]: { mode: "future", focusID: "future", extra: 1 } }))
  modes.set(b.dir, { mode: "full" })
  expect(b.read()[directory]).toEqual({ mode: "full", focusID: "future", extra: 1 })
})

import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_BINDINGS, KEY_ACTIONS } from "../src/ui/keymap"
import { osc52Copy } from "../src/ui/osc52"
import type { PresentationMode } from "../src/view/transcript"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))
const CODE = "const answer = 42\nconsole.log(answer)"
const ANSWER = `Here is the code.\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\nAnd a table.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.`

async function chat(mode: PresentationMode) {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, mode })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Show me", ANSWER)
  h.app.render()
  return h
}

const click = async (h: Harness, col: number, row: number) => {
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  h.app.render()
}

test("clicking a code block's copy puts exactly its source on the clipboard and says so", async () => {
  const h = await chat("full")
  const header = rowOf(h, "╭─ ts")
  expect(header).toBeGreaterThan(-1)
  const col = h.text()[header]!.lastIndexOf("copy")
  await click(h, col + 1, header)
  expect(h.written).toEqual([osc52Copy(CODE)!])
  expect(h.text().join("\n")).toContain("copied ts code")
})

test("a click beside the button, or on the code, copies nothing", async () => {
  const h = await chat("full")
  const header = rowOf(h, "╭─ ts")
  const col = h.text()[header]!.lastIndexOf("copy")
  await click(h, col - 3, header)
  await click(h, 10, rowOf(h, "const answer"))
  expect(h.written).toEqual([])
})

const TABLE = "| Name | Qty | Note |\n|---|---|---|\n| apple | 3 | fresh fruit |"
async function chatWith(mode: PresentationMode, answer: string) {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, mode })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Show me", answer)
  h.app.render()
  return h
}

test("a table's copy hint is on its top border and a click copies the markdown source", async () => {
  const h = await chatWith("full", `A table.\n\n${TABLE}\n\nDone.`)
  const border = rowOf(h, "┌───────┬")
  expect(h.text()[border]).toMatch(/─ copy ┐/)
  expect(rowOf(h, "╭─ table")).toBe(-1)
  await click(h, h.text()[border]!.lastIndexOf("copy") + 1, border)
  expect(h.written).toEqual([osc52Copy(TABLE)!])
  expect(h.text().join("\n")).toContain("copied table")
})

test("a narrow table has no hint, a click on its border copies nothing and the key copies it", async () => {
  const h = await chat("full")
  const border = rowOf(h, "┌───┬───┐")
  expect(h.text()[border]).not.toContain("copy")
  await click(h, 8, border)
  expect(h.written).toEqual([])
})

test("the balanced view keeps a hint on code only", async () => {
  const h = await chatWith("balanced", `\`\`\`ts\nx\n\`\`\`\n\n${TABLE}`)
  expect(rowOf(h, "╭─ ts")).toBeGreaterThan(-1)
  expect(h.text()[rowOf(h, "┌───────┬")]).not.toContain("copy")
})

test("the minimal view draws no header and no hint", async () => {
  const h = await chat("minimal")
  expect(rowOf(h, "╭─")).toBe(-1)
  expect(h.text().join("\n")).not.toContain("copy")
})

test("ctrl+x Y copies a list or quote that draws no chrome", async () => {
  const list = "- one\n- two\n- three\n- four"
  const h = await chatWith("full", `Items:\n\n${list}`)
  expect(h.text().join("\n")).not.toContain("copy")
  await h.type("\x18Y")
  h.app.render()
  expect(h.written).toEqual([osc52Copy(list)!])
  expect(h.text().join("\n")).toContain("copied list")
})

test("ctrl+x Y copies the block nearest the middle of the screen and says so when there is none", async () => {
  expect(DEFAULT_BINDINGS.leader.get("Y")).toEqual({ action: "block.copy" })
  expect(KEY_ACTIONS).toContain("block.copy")
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30, mode: "full" })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Show me", `Code:\n\n\`\`\`ts\n${CODE}\n\`\`\``)
  h.app.render()
  await h.type("\x18Y")
  h.app.render()
  expect(h.written).toEqual([osc52Copy(CODE)!])
  expect(h.text().join("\n")).toContain("copied ts code")
  const plain = appHarness({ dataDir: tempDir(), width: 100, height: 30, mode: "full" })
  plain.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(plain.sessionId, plain.app.onEvent).exchange("Hi", "Plain answer")
  plain.app.render()
  await plain.type("\x18Y")
  plain.app.render()
  expect(plain.text().join("\n")).toContain("no copyable block in view")
  expect(plain.written).toEqual([])
})

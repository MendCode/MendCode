import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_BINDINGS } from "../src/ui/keymap"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))

async function chat() {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Explain", "Intro line\n\n<details><summary>First fold</summary>\n\nhidden alpha\n\n</details>\n\n<details><summary>Second fold</summary>\n\nhidden beta\n\n</details>")
  h.app.render()
  return h
}

const shows = (h: Harness, needle: string) => h.text().some((row) => row.includes(needle))

test("clicking a summary row opens that block only, and clicking again folds it", async () => {
  const h = await chat()
  expect(shows(h, "hidden alpha")).toBe(false)
  const second = rowOf(h, "Second fold")
  await h.app.onKey(press(10, second))
  await h.app.onKey(release(10, second))
  h.app.render()
  expect(shows(h, "hidden beta")).toBe(true)
  expect(shows(h, "hidden alpha")).toBe(false)
  await h.app.onKey(press(10, rowOf(h, "Second fold")))
  await h.app.onKey(release(10, rowOf(h, "Second fold")))
  h.app.render()
  expect(shows(h, "hidden beta")).toBe(false)
})

test("a click elsewhere in the message toggles nothing", async () => {
  const h = await chat()
  const intro = rowOf(h, "Intro line")
  await h.app.onKey(press(10, intro))
  await h.app.onKey(release(10, intro))
  h.app.render()
  expect(shows(h, "hidden alpha")).toBe(false)
  expect(shows(h, "hidden beta")).toBe(false)
})

test("ctrl+x f toggles the block in view, and works while ctrl+o has every block open", async () => {
  expect(DEFAULT_BINDINGS.leader.get("f")).toEqual({ action: "details.toggle" })
  const h = await chat()
  await h.type("\x18f")
  h.app.render()
  const opened = [shows(h, "hidden alpha"), shows(h, "hidden beta")]
  expect(opened.filter(Boolean)).toHaveLength(1)
  await h.type("\x18f")
  h.app.render()
  expect(shows(h, "hidden alpha") || shows(h, "hidden beta")).toBe(false)
  await h.type("\x0f")
  h.app.render()
  expect(shows(h, "hidden alpha") && shows(h, "hidden beta")).toBe(true)
  await h.type("\x18f")
  h.app.render()
  expect([shows(h, "hidden alpha"), shows(h, "hidden beta")].filter(Boolean)).toHaveLength(1)
})

test("with no details block on screen the key only says so", async () => {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Hi", "Plain answer")
  h.app.render()
  await h.type("\x18f")
  h.app.render()
  expect(h.text().join("\n")).toContain("no <details> block in view")
})

import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, tempDir, type Harness } from "./session-ui-harness"
import { osc52Copy } from "../src/ui/osc52"
import type { PresentationMode } from "../src/view/transcript"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const BLOB = `/data/blobs/cc/${"c".repeat(64)}`

function generated(input: { mode?: PresentationMode; width?: number; tool?: string; status?: "ok" | "error"; text?: string; meta?: Record<string, string> } = {}) {
  const h = appHarness({ dataDir: tempDir(), width: input.width ?? 100, height: 30, mode: input.mode ?? "balanced", directory: "/work/project" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent), turnId = ids("turn"), itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: input.tool ?? "image_generation" } })
  chat.emit({ type: "item.completed", itemId, status: input.status ?? "ok", text: input.text ?? `A lighthouse at dusk\n${BLOB}`, ...(input.meta ? { meta: input.meta } : {}), attachments: [{ sha256: "c".repeat(64), mime: "image/png", bytes: 1_234_567 }] })
  chat.emit({ type: "turn.completed", turnId })
  h.app.render()
  return h
}

const click = async (h: Harness, word: string) => {
  const row = h.text().findIndex((line) => line.includes("copy path"))
  const col = h.text()[row]!.indexOf(word) + 1
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  h.app.render()
}

test("a finished generated image has v1's row in every view: what the file is, then open, folder and copy path", () => {
  for (const mode of ["minimal", "balanced", "full"] as const) {
    const row = generated({ mode }).text().find((line) => line.includes("copy path"))
    expect(row?.trim()).toBe("PNG · 1.2 MB  open  folder  copy path")
  }
})

test("open and folder ask the daemon for the image and its folder; copy path copies the path", async () => {
  const h = generated()
  await click(h, "open")
  await click(h, "folder")
  await click(h, "copy path")
  expect(h.sent.filter((command) => command.type === "image.open")).toEqual([{ type: "image.open", path: BLOB }, { type: "image.open", path: BLOB, reveal: true }])
  expect(h.written).toEqual([osc52Copy(BLOB)!])
})

test("image_gen's own path wins over its text; a failed call, or one with no path, has no row; a narrow screen drops the buttons that do not fit", () => {
  const saved = "/work/project/generated_images/lighthouse.png"
  expect(generated({ tool: "image_gen", text: "Generated image", meta: { path: saved } }).text().find((line) => line.includes("copy path"))).toBeDefined()
  expect(generated({ status: "error" }).text().some((line) => line.includes("copy path"))).toBe(false)
  expect(generated({ text: "A lighthouse at dusk" }).text().some((line) => line.includes("copy path"))).toBe(false)
  const narrow = generated({ width: 30 }).text().find((line) => line.includes("PNG"))
  expect(narrow?.trim()).toBe("PNG · 1.2 MB  open  folder")
})

import { expect, test } from "bun:test"
import { createIdFactory, type BlobRef } from "@mendcode/protocol"
import type { EngineEvent } from "@mendcode/kernel"
import { createTurnMapper } from "../src"
import { toolResultImages } from "../src/protocol"

const ids = createIdFactory()
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")

function toolUse(index: number, id: string, name: string, input: unknown) {
  return [
    { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name } } },
    { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } },
    { type: "stream_event", event: { type: "content_block_stop", index } },
  ]
}
const imageResult = (id: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] } })

function turn(store?: (bytes: Uint8Array, mime: string) => BlobRef | undefined) {
  const events: EngineEvent[] = []
  const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-sonnet-5-5", ...(store ? { storeImage: store } : {}) })
  const feed = (...messages: unknown[]) => { for (const message of messages.flat()) mapper.accept(message as never) }
  const completed = () => events.filter((event): event is Extract<EngineEvent, { type: "item.completed" }> => event.type === "item.completed")
  return { feed, completed }
}

test("a Read of a picture keeps its image and the call's card carries it, so the transcript draws it instead of [image]", () => {
  const kept: Array<{ bytes: Uint8Array; mime: string }> = []
  const t = turn((bytes, mime) => { kept.push({ bytes, mime }); return { sha256: "a".repeat(64), mime, bytes: bytes.byteLength } as BlobRef })
  t.feed(toolUse(0, "toolu_1", "Read", { file_path: "/p/shot.png" }), imageResult("toolu_1"))
  expect(kept).toHaveLength(1)
  expect(kept[0]!.mime).toBe("image/png")
  expect(Buffer.from(kept[0]!.bytes).toString("base64")).toBe(PNG)
  expect(t.completed().at(-1)).toMatchObject({ status: "ok", text: "[image]", attachments: [{ mime: "image/png" }] })
})

test("without a store, on a failed call or when the store fails, the card has no picture and the turn goes on", () => {
  const none = turn()
  none.feed(toolUse(0, "toolu_1", "Read", { file_path: "/p/a.png" }), imageResult("toolu_1"))
  expect(none.completed().at(-1)!.attachments).toBeUndefined()
  const failed = turn(() => { throw new Error("disk full") })
  failed.feed(toolUse(0, "toolu_2", "Read", { file_path: "/p/b.png" }), imageResult("toolu_2"))
  expect(failed.completed().at(-1)).toMatchObject({ status: "ok" })
  expect(failed.completed().at(-1)!.attachments).toBeUndefined()
  let asked = false
  const error = turn(() => { asked = true; return undefined })
  error.feed(toolUse(0, "toolu_3", "Read", { file_path: "/p/c.png" }), imageResult("toolu_3", true))
  expect(asked).toBe(false)
})

test("only base64 images are taken, at most two, and none too large", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }
  expect(toolResultImages([{ type: "text", text: "x" }, image, image, image])).toHaveLength(2)
  expect(toolResultImages([{ type: "image", source: { type: "url", url: "https://x" } }])).toEqual([])
  expect(toolResultImages([{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(8 * 1024 * 1024) } }])).toEqual([])
  expect(toolResultImages("text")).toEqual([])
})

import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { encodeImagePng } from "../src/ui/image-protocol"
import { createImageCards } from "../src/ui/app/image-cards"

const rgba = (width: number, height: number) => {
  const data = new Uint8Array(width * height * 4)
  for (let at = 0; at < data.length; at += 4) data.set([200, 40, 40, 255], at)
  return { width, height, rgba: data }
}

test("a picture shared by two chats is read again by the chat on screen now, not by the first one that showed it", async () => {
  const png = encodeImagePng(rgba(120, 60))
  const sha256 = createHash("sha256").update(png).digest("hex")
  const readBy: string[] = []
  const input = {
    remote: undefined, screen: { inline: false, imageProtocol: "kitty" },
    send: async (command: { type: string; sessionId: string; offset?: number }) => {
      readBy.push(command.sessionId)
      return { ok: true, result: { sha256, mime: "image/png", bytes: png.length, offset: 0, data: Buffer.from(png).toString("base64"), done: true } }
    },
  }
  const state = { tuiProfile: { transcriptImages: true }, imageCellPixels: { width: 10, height: 20 }, transcript: { attachmentsOf: () => [{ sha256, mime: "image/png", bytes: png.length }] } }
  const cards = createImageCards({ input, state, requestFrame: () => {} } as never, { host: false })
  const idle = async () => { for (let i = 0; i < 200 && !cards.idle; i++) await Bun.sleep(5) }
  cards.ensure("ses_a" as never, ["item_1" as never])
  await idle()
  expect(cards.loaded).toBe(1)
  // The first draw uses the bytes kept from the size read; later draws read the picture again.
  cards.place({ sha256, cols: 12, rows: 3 })
  await idle()
  // The chat is switched, the first one is deleted and the scaled pictures are dropped: the redraw must ask as the chat on screen.
  cards.ensure("ses_b" as never, ["item_1" as never])
  cards.invalidate()
  readBy.length = 0
  cards.place({ sha256, cols: 12, rows: 3 })
  await idle()
  expect(readBy).toEqual(["ses_b"])
}, 15_000)

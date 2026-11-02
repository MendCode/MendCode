import { expect, test } from "bun:test"
import { createCodec } from "../src/compress"
import { abbreviateMessage, expandMessage } from "../src/message-prefix"

const shapes = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "answer" },
  { role: "assistant", content: "", toolCalls: [{ id: "itm_1", name: "read", input: { path: "a" } }] },
  { role: "tool", toolCallId: "itm_1", content: "output" },
  { role: "assistant", content: [{ type: "text", text: "blocks" }] },
  { role: "system", content: "other role" },
  { content: "no role" },
]

test("every message shape round-trips through the abbreviation, and the common ones shrink", () => {
  for (const shape of shapes) {
    const text = JSON.stringify(shape)
    const stored = abbreviateMessage(text)
    expect(expandMessage(stored)).toBe(text)
    expect(JSON.parse(expandMessage(stored))).toEqual(shape)
  }
  for (const shape of shapes.slice(0, 5)) expect(abbreviateMessage(JSON.stringify(shape)).length).toBeLessThan(JSON.stringify(shape).length - 20)
  expect(abbreviateMessage(JSON.stringify(shapes[5]))).toBe(JSON.stringify(shapes[5]))
})

test("rows written without the abbreviation read unchanged, including whitespace variants and plain text", () => {
  for (const text of ['{"role": "user", "content": "spaced"}', '{"role":"user"}', "", "plain", "[]"]) expect(expandMessage(text)).toBe(text)
  const codec = createCodec()
  for (const shape of shapes) expect(codec.unpackText(JSON.stringify(shape))).toBe(JSON.stringify(shape))
})

test("the codec stores small messages abbreviated, large ones as before, and the legacy codec writes plain JSON", () => {
  const small = JSON.stringify(shapes[0]), large = JSON.stringify({ role: "user", content: "x".repeat(4000) })
  const codec = createCodec()
  expect(codec.packText(small)).not.toBe(small)
  expect(codec.unpackText(codec.packText(small))).toBe(small)
  expect(codec.unpackText(codec.packText(large))).toBe(large)
  const legacy = createCodec({ enabled: false })
  expect(legacy.packText(small)).toBe(small)
  expect(legacy.unpackText(codec.packText(small))).toBe(small)
})

test("a store reads abbreviated and plain model rows alike", async () => {
  const { mkdtempSync } = await import("node:fs"), { tmpdir } = await import("node:os"), path = await import("node:path")
  const { Database } = await import("bun:sqlite"), { createIdFactory } = await import("@mendcode/protocol"), { openStore } = await import("../src")
  const dir = mkdtempSync(path.join(tmpdir(), "mend-message-prefix-")), ids = createIdFactory()
  const store = openStore({ dir }), parent = ids("session")
  try {
    store.createSession({ id: parent, directory: "/probe", title: "prefix" })
    store.engineMessages.save(parent, "native", shapes.slice(0, 4) as never)
    const raw = new Database(path.join(dir, "mendd.db"), { readonly: true })
    const stored = raw.query<{ payload: string }, []>("SELECT payload FROM engine_messages ORDER BY idx").all().map(row => row.payload)
    raw.close()
    expect(stored.every(text => text.charCodeAt(0) < 32)).toBe(true)
    expect(store.engineMessages.load(parent, "native")).toEqual(shapes.slice(0, 4))
    const writer = new Database(path.join(dir, "mendd.db"))
    writer.query("INSERT INTO engine_messages(session_id, engine, idx, payload) VALUES (?, 'native', 4, ?)").run(parent, JSON.stringify(shapes[1]))
    writer.close()
    expect(store.engineMessages.load(parent, "native")).toEqual([...shapes.slice(0, 4), shapes[1]])
  } finally { store.close() }
})

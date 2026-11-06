import { expect, test } from "bun:test"
import { COMPRESS_MIN_BYTES, createCodec } from "../src/compress"
import { MESSAGE_DICTIONARY_V1 } from "../src/message-dictionary"

const codec = createCodec()
const orientation = JSON.stringify({ role: "user", content: "<orientation>\ncwd: /Users/someone/project\ngit branch: main\nno project instruction file (AGENTS.md, CLAUDE.md) exists here or above\nfiles (3):\nsrc/\nsrc/app.ts\npackage.json\n</orientation>\n\nFix the failing test in src/app.ts." })
const toolOutput = JSON.stringify({ role: "tool", callId: "call_abc123", name: "read", output: "     1\tconst a = 1\n     2\tconst b = 2\n     3\texport { a, b }", isError: false })
const toolCall = JSON.stringify({ role: "assistant", content: "", toolCalls: [{ callId: "call_abc123", name: "read", args: { path: "src/app.ts" } }] })

test("the message dictionary never changes: every stored dictionary row was deflated against these exact bytes", () => {
  expect(new Bun.CryptoHasher("sha256").update(MESSAGE_DICTIONARY_V1).digest("hex")).toBe("264acdd6ec3175516d94d1e613df4bdb3a6e67fff4c2415b5b9cd4dadfd31bef")
})

test("small messages that deflate smaller against the dictionary are stored that way, and read back byte for byte", () => {
  for (const text of [orientation, toolOutput, toolCall]) {
    const packed = codec.packText(text)
    expect(packed).toBeInstanceOf(Uint8Array)
    expect([...(packed as Uint8Array).subarray(0, 5)]).toEqual([0x00, 0x4d, 0x5a, 0x31, 0x44])
    expect((packed as Uint8Array).byteLength).toBeLessThan(Buffer.byteLength(text) * 0.7)
    expect(codec.unpackText(packed)).toBe(text)
  }
})

test("a message that would not shrink, a lone surrogate, accents and emoji, and the size boundary all read back unchanged", () => {
  const tiny = JSON.stringify({ role: "user", content: "ok" })
  expect(typeof codec.packText(tiny)).toBe("string")
  const lone = JSON.stringify({ role: "user", content: "broken \ud800 pair" }).replace("\\ud800", "\ud800")
  expect(codec.packText(lone)).toBe(String.fromCharCode(3) + lone.slice('{"role":"user","content":'.length))
  expect(codec.unpackText(codec.packText(lone))).toBe(lone)
  for (const text of [
    JSON.stringify({ role: "assistant", content: "Listo: añadí la verificación — ✅ 👍🏽 中文 ".repeat(8), toolCalls: [] }),
    JSON.stringify({ role: "user", content: "y".repeat(COMPRESS_MIN_BYTES - 40) }),
    JSON.stringify({ role: "user", content: "z".repeat(COMPRESS_MIN_BYTES + 10) }),
    "not json at all, but text",
  ]) expect(codec.unpackText(codec.packText(text))).toBe(text)
})

test("the header records the original size, so storage stats need nine bytes of the row", () => {
  const packed = codec.packText(toolOutput) as Uint8Array
  expect(codec.textBytes(packed.subarray(0, 9))).toBe(Buffer.byteLength(toolOutput))
})

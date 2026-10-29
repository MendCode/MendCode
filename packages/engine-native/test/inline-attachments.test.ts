import { describe, expect, test } from "bun:test"
import type { BlobRef } from "@mendcode/protocol"
import { createNativeEngine, memoryHistory, toAnthropicMessages, toChatMessages, toResponsesInput, type ModelMessage } from "../src"
import { orderedParts } from "../src/history"
import { toGeminiContents } from "../src/google-gemini"
import { echoTool, ids, scriptedProvider, stop, turn } from "./harness"

/**
 * Inline attachment tokens, on the model side: a message whose text holds `[Image #1]` sends the picture right after that token,
 * in every provider format that can order its content. A message without tokens is the plain shape it has always been.
 */

const png = (seed: string): BlobRef & { label?: string; at?: number } => ({ sha256: seed.repeat(64).slice(0, 64), bytes: 4, mime: "image/png", name: `${seed}.png` })
const pdf: BlobRef = { sha256: "c".repeat(64), bytes: 4, mime: "application/pdf", name: "spec.pdf" }
const bytesOf = new Map<string, Uint8Array>([[png("a").sha256, new Uint8Array([1, 2, 3, 4])], [png("b").sha256, new Uint8Array([5, 6, 7, 8])], [pdf.sha256, new Uint8Array([9, 9, 9, 9])]])
const b64 = (sha: string) => Buffer.from(bytesOf.get(sha)!).toString("base64")

/** What the terminal composes for "mira [Image #1] y luego [codeconfig/] fin": the folder's block follows its token. */
const SENTENCE = "mira [Image #1] y luego [codeconfig/]\n\n[attached file: codeconfig]\n```\nAGENTS.md\nclaude/\n```\n\nfin"
const IMAGE_AT = "mira [Image #1]".length

function engineFor(history = memoryHistory()) {
  const script = scriptedProvider([stop("ok"), stop("ok")])
  const engine = createNativeEngine({ provider: script.provider, tools: [echoTool], history, cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "summarize", readBlob: async (ref: BlobRef) => {
    const bytes = bytesOf.get(ref.sha256)
    if (!bytes) throw new Error("[BLOB]: gone")
    return bytes
  } })
  return { engine, requests: script.requests, history }
}

async function requestFor(text: string, attachments: BlobRef[]) {
  const { engine, requests } = engineFor()
  const { input } = turn({ text })
  input.attachments = attachments
  await engine.runTurn(input)
  return requests[0]!.messages.find((message) => message.role === "user")! as Extract<ModelMessage, { role: "user" }>
}

describe("the request the native engine builds", () => {
  test("a placed image goes right after its token: text, image, text", async () => {
    const message = await requestFor(SENTENCE, [{ ...png("a"), label: "[Image #1]", at: IMAGE_AT }])
    expect(message.layout).toEqual([{ text: "mira [Image #1]" }, { image: 0 }, { text: SENTENCE.slice(IMAGE_AT) }])
    expect(message.images).toEqual([{ mime: "image/png", base64: b64(png("a").sha256) }])
  })

  test("an offset that drifted (text was added before the message) is found again by its label", async () => {
    const message = await requestFor(`PREFIX ${SENTENCE}`, [{ ...png("a"), label: "[Image #1]", at: IMAGE_AT }])
    expect(message.layout?.[0]).toEqual({ text: "PREFIX mira [Image #1]" })
  })

  test("images and a PDF follow the order of their tokens, not the order of the attachments", async () => {
    const text = "[PDF spec.pdf] antes de [Image #2] y de [Image #1]"
    const message = await requestFor(text, [
      { ...png("a"), label: "[Image #1]", at: text.length },
      { ...png("b"), label: "[Image #2]", at: "[PDF spec.pdf] antes de [Image #2]".length },
      { ...pdf, label: "[PDF spec.pdf]", at: "[PDF spec.pdf]".length },
    ])
    expect(message.layout).toEqual([{ text: "[PDF spec.pdf]" }, { document: 0 }, { text: " antes de [Image #2]" }, { image: 0 }, { text: " y de [Image #1]" }, { image: 1 }])
    expect(message.images?.map((image) => image.base64)).toEqual([b64(png("b").sha256), b64(png("a").sha256)])
  })

  test("an attachment with no token, or whose token is gone, is sent after the text as it always was", async () => {
    const message = await requestFor("hola [Image #1] fin", [{ ...png("a"), label: "[Image #1]", at: 11 }, png("b"), { ...pdf, label: "[PDF gone.pdf]", at: 20 }])
    expect(message.layout).toEqual([{ text: "hola [Image #1]" }, { image: 0 }, { text: " fin" }, { image: 1 }, { document: 0 }])
  })

  test("a message with attachments but no tokens has no layout: text, images, documents", async () => {
    const message = await requestFor("sin tokens", [png("a"), pdf])
    expect(message.layout).toBeUndefined()
    expect(message.images).toHaveLength(1)
    expect(message.documents).toHaveLength(1)
  })

  test("an attachment whose bytes are gone is left out of the layout and the note stays at the end", async () => {
    const lost: BlobRef = { ...png("z"), label: "[Image #1]", at: 8 }
    const message = await requestFor("antes [Image #1] fin", [lost])
    expect(message.layout).toEqual([{ text: "antes [Image #1]" }, { text: " fin" }, { text: "\n\n[1 attachment(s) no longer available]" }])
    expect(message.content.endsWith("[1 attachment(s) no longer available]")).toBe(true)
  })

  test("the history keeps the message as sent: refs with their tokens, no bytes, no layout", async () => {
    const history = memoryHistory()
    const { engine } = engineFor(history)
    const sessionId = ids("session")
    const { input } = turn({ text: SENTENCE, sessionId })
    input.attachments = [{ ...png("a"), label: "[Image #1]", at: IMAGE_AT }]
    await engine.runTurn(input)
    const saved = (await history.load(sessionId))!.find((message) => message.role === "user")!
    expect(saved).toMatchObject({ content: SENTENCE, attachments: [{ sha256: png("a").sha256, label: "[Image #1]", at: IMAGE_AT }] })
    expect(saved).not.toHaveProperty("layout")
    expect(saved).not.toHaveProperty("images")
  })
})

/** The message the engine hands an adapter for SENTENCE with one image placed after its token and the folder as text. */
const placed: Extract<ModelMessage, { role: "user" }> = {
  role: "user",
  content: SENTENCE,
  images: [{ mime: "image/png", base64: "QUJD" }],
  layout: [{ text: "mira [Image #1]" }, { image: 0 }, { text: SENTENCE.slice(IMAGE_AT) }],
}

describe("provider formats: text, image, text (the folder's block is part of the text after the image)", () => {
  test("OpenAI Responses", () => {
    expect(toResponsesInput([placed])).toEqual([
      { role: "user", content: [{ type: "input_text", text: "mira [Image #1]" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }, { type: "input_text", text: " y luego [codeconfig/]\n\n[attached file: codeconfig]\n```\nAGENTS.md\nclaude/\n```\n\nfin" }] },
    ])
  })

  test("OpenAI Chat Completions", () => {
    expect(toChatMessages("", [placed])).toEqual([
      { role: "user", content: [{ type: "text", text: "mira [Image #1]" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }, { type: "text", text: " y luego [codeconfig/]\n\n[attached file: codeconfig]\n```\nAGENTS.md\nclaude/\n```\n\nfin" }] },
    ])
  })

  test("Anthropic Messages", () => {
    expect(toAnthropicMessages([placed], "claude-test")).toEqual([
      { role: "user", content: [{ type: "text", text: "mira [Image #1]" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }, { type: "text", text: " y luego [codeconfig/]\n\n[attached file: codeconfig]\n```\nAGENTS.md\nclaude/\n```\n\nfin" }] },
    ])
  })

  test("Gemini", () => {
    const contents = toGeminiContents([placed], "gemini-test", "google")
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "mira [Image #1]" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }, { text: " y luego [codeconfig/]\n\n[attached file: codeconfig]\n```\nAGENTS.md\nclaude/\n```\n\nfin" }] })
  })

  test("a PDF is placed the same way: input_file / file / document in the middle of the text", () => {
    const withPdf: Extract<ModelMessage, { role: "user" }> = { role: "user", content: "ver [PDF a.pdf] ya", documents: [{ mime: "application/pdf", base64: "REVG", name: "a.pdf" }], layout: [{ text: "ver [PDF a.pdf]" }, { document: 0 }, { text: " ya" }] }
    expect(toResponsesInput([withPdf])[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "ver [PDF a.pdf]" }, { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,REVG" }, { type: "input_text", text: " ya" }] })
    expect(toChatMessages("", [withPdf])[0]).toEqual({ role: "user", content: [{ type: "text", text: "ver [PDF a.pdf]" }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,REVG" } }, { type: "text", text: " ya" }] })
    expect(toAnthropicMessages([withPdf], "claude-test")[0]!.content).toEqual([{ type: "text", text: "ver [PDF a.pdf]" }, { type: "document", title: "a.pdf", source: { type: "base64", media_type: "application/pdf", data: "REVG" } }, { type: "text", text: " ya" }])
  })

  test("Anthropic leaves out a text block of only spaces between two tokens (the API refuses it)", () => {
    const two: Extract<ModelMessage, { role: "user" }> = { role: "user", content: "[Image #1] [Image #2]", images: [{ mime: "image/png", base64: "QQ==" }, { mime: "image/png", base64: "Qg==" }], layout: [{ text: "[Image #1]" }, { image: 0 }, { text: " [Image #2]" }, { image: 1 }] }
    expect(toAnthropicMessages([two], "claude-test")[0]!.content.map((block) => block.type)).toEqual(["text", "image", "text", "image"])
    const spaced: Extract<ModelMessage, { role: "user" }> = { ...two, layout: [{ text: "[Image #1]" }, { image: 0 }, { text: " " }, { image: 1 }] }
    expect(toAnthropicMessages([spaced], "claude-test")[0]!.content.map((block) => block.type)).toEqual(["text", "image", "image"])
  })

  test("a model without images keeps the text, with the note, and no layout", async () => {
    const { withoutUnsupportedImages } = await import("../src/history")
    const [stripped] = withoutUnsupportedImages([placed], false) as [Extract<ModelMessage, { role: "user" }>]
    expect(stripped).not.toHaveProperty("layout")
    expect(stripped.content).toContain("mira [Image #1]")
    expect(orderedParts(stripped)).toBeUndefined()
  })
})

describe("a request without tokens is byte for byte what it was", () => {
  const plain: ModelMessage[] = [{ role: "user", content: "hola" }]
  const media: ModelMessage[] = [{ role: "user", content: "review", images: [{ mime: "image/png", base64: "QUJD" }], documents: [{ mime: "application/pdf", base64: "REVG", name: "design.pdf" }] }]

  test("no attachments", () => {
    expect(JSON.stringify(toResponsesInput(plain))).toBe('[{"role":"user","content":[{"type":"input_text","text":"hola"}]}]')
    expect(JSON.stringify(toChatMessages("sys", plain))).toBe('[{"role":"system","content":"sys"},{"role":"user","content":"hola"}]')
    expect(JSON.stringify(toAnthropicMessages(plain, "claude-test"))).toBe('[{"role":"user","content":[{"type":"text","text":"hola"}]}]')
  })

  test("attachments the user sent after the text (no layout): text, then images, then documents", () => {
    expect(JSON.stringify(toResponsesInput(media))).toBe('[{"role":"user","content":[{"type":"input_text","text":"review"},{"type":"input_image","image_url":"data:image/png;base64,QUJD"},{"type":"input_file","filename":"design.pdf","file_data":"data:application/pdf;base64,REVG"}]}]')
    expect(JSON.stringify(toChatMessages("", media))).toBe('[{"role":"user","content":[{"type":"text","text":"review"},{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}},{"type":"file","file":{"filename":"design.pdf","file_data":"data:application/pdf;base64,REVG"}}]}]')
    expect(JSON.stringify(toAnthropicMessages(media, "claude-test"))).toBe('[{"role":"user","content":[{"type":"text","text":"review"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}},{"type":"document","title":"design.pdf","source":{"type":"base64","media_type":"application/pdf","data":"REVG"}}]}]')
  })

  test("the engine adds nothing to a message without attachments", async () => {
    const message = await requestFor("hola", [])
    expect(message).toEqual({ role: "user", content: expect.stringContaining("hola") })
    expect(message).not.toHaveProperty("layout")
    expect(message).not.toHaveProperty("images")
  })
})

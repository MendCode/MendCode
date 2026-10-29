import { expect, test } from "bun:test"
import { toAnthropicMessages, toChatMessages, toResponsesInput, type ModelMessage } from "../src"
import { withoutUnsupportedImages } from "../src/history"

const messages: ModelMessage[] = [{ role: "user", content: "review", images: [{ mime: "image/png", base64: "QUJD" }], documents: [{ mime: "application/pdf", base64: "REVG", name: "design.pdf" }] }]

test("Responses maps PDF to input_file alongside input_image", () => {
  expect(toResponsesInput(messages)).toEqual([{ role: "user", content: [{ type: "input_text", text: "review" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }, { type: "input_file", filename: "design.pdf", file_data: "data:application/pdf;base64,REVG" }] }])
})

test("Anthropic maps PDF to document and leaves it after tool_result blocks", () => {
  const input: ModelMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [{ callId: "read-1", name: "read", args: {} }] }, { role: "tool", callId: "read-1", name: "read", output: "PDF read successfully", isError: false }, ...messages]
  expect(toAnthropicMessages(input, "test").at(-1)?.content).toEqual([{ type: "tool_result", tool_use_id: "read-1", content: "PDF read successfully" }, { type: "text", text: "review" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }, { type: "document", title: "design.pdf", source: { type: "base64", media_type: "application/pdf", data: "REVG" } }])
})

test("Chat Completions maps PDF as a file, never an image_url", () => {
  expect(toChatMessages("", messages)[0]).toEqual({ role: "user", content: [{ type: "text", text: "review" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }, { type: "file", file: { filename: "design.pdf", file_data: "data:application/pdf;base64,REVG" } }] })
})

test("disabling images leaves documents intact and emits only the image omission note", () => {
  const result = withoutUnsupportedImages(messages, false)
  expect(result[0]).toMatchObject({ content: expect.stringContaining("1 image omitted"), documents: [{ mime: "application/pdf", name: "design.pdf" }] })
  expect(result[0]).not.toHaveProperty("images")
})

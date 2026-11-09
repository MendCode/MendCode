import { expect, test } from "bun:test"
import { createNativeEngine, memoryHistory } from "../src"
import { scriptedProvider, stop, turn } from "./harness"

const LINE = "Reply in Español."
const userTexts = (request: { messages: ReadonlyArray<{ role: string; content?: unknown }> }) => request.messages.filter((message) => message.role === "user").map((message) => String(message.content))

test("each user message carries the reply-language line once, at its end, and the next turn's request starts with the previous one unchanged", async () => {
  const { provider, requests } = scriptedProvider([stop("a"), stop("b")])
  const asked: string[] = []
  const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [], cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", replyLanguage: (_sessionId, text) => (asked.push(text), LINE) })
  const first = turn({ text: "first task" })
  await engine.runTurn(first.input)
  await engine.runTurn(turn({ text: "second task", sessionId: first.input.sessionId }).input)
  expect(asked).toEqual(["first task", "second task"])
  expect(userTexts(requests[0]!)).toEqual([`first task\n\n(${LINE})`])
  expect(userTexts(requests[1]!)).toEqual([`first task\n\n(${LINE})`, `second task\n\n(${LINE})`])
  for (const request of requests) for (const text of userTexts(request)) expect(text.split(LINE).length - 1).toBe(1)
  // The cached prefix: system prompt, tools and every earlier message are byte for byte what the first request sent.
  expect(requests[1]!.system).toBe(requests[0]!.system)
  expect(JSON.stringify(requests[1]!.messages.slice(0, requests[0]!.messages.length))).toBe(JSON.stringify(requests[0]!.messages))
  expect(requests[0]!.system).not.toContain(LINE)
  // Only what the user typed is reported as the message.
  expect(JSON.stringify(first.events)).not.toContain(LINE)
})

test("no line without the option or when it answers nothing", async () => {
  for (const replyLanguage of [undefined, () => undefined]) {
    const { provider, requests } = scriptedProvider([stop("a")])
    const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [], cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", ...(replyLanguage ? { replyLanguage } : {}) })
    await engine.runTurn(turn({ text: "first task" }).input)
    expect(userTexts(requests[0]!)).toEqual(["first task"])
  }
})

test("a notice about the session's own work is not judged for the user's language: it keeps the user's", async () => {
  const { provider } = scriptedProvider([stop("a")])
  const asked: string[] = []
  const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [], cwdFor: () => "/tmp", system: () => "sys", compactionPrompt: "summarize", replyLanguage: (_sessionId, text) => (asked.push(text), LINE) })
  const wake = turn({ text: "The pull request has new commits. Check the review again." })
  await engine.runTurn({ ...wake.input, authority: { sourceId: "item-notice", text: wake.input.text, synthetic: true } })
  expect(asked).toEqual([""])
})

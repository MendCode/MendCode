import { afterEach, expect, test } from "bun:test"
import { b42Harness } from "./b42-harness"
import { cleanTemps, conversation } from "./session-ui-harness"
import { MODEL_PAGE_ROWS } from "../src/view/model-page"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("agent picker omits hidden and disabled agents and uses configured colors", async () => {
  const h = await b42Harness()
  await h.type("/agent\r")
  expect(h.app.page).toBe("agent")
  expect(h.text().join("\n")).not.toContain("hidden-agent")
  expect(h.text().join("\n")).not.toContain("disabled-agent")
  const names = h.frames.at(-1)!.flat().filter((span) => ["build", "plan", "reviewer"].includes(span.text))
  expect(names).toContainEqual(expect.objectContaining({ text: "reviewer", fgHex: "#60a5fa" }))
  await h.type("\x1b[B\x1b[B\r")
  expect(h.sentOf("session.agent.set")).toContainEqual({ type: "session.agent.set", sessionId: h.sessionId, agent: "reviewer" })
})

test("auxiliary title and summary rows update independent roles through the app factory", async () => {
  const h = await b42Harness(100, 40)
  await h.type("/model roles\r")
  expect(h.text().join("\n")).toContain("title")
  expect(h.text().join("\n")).toContain("summary")
  for (let i = 0; i < MODEL_PAGE_ROWS.indexOf("title"); i++) await h.app.onKey("\x1b[B")
  await h.app.onKey("\x1b[C")
  const sent = h.sentOf("settings.set").at(-1)
  expect(sent).toMatchObject({ patch: { models: { title: { model: "local:large" }, summary: { model: "local:large", effort: "low" }, memoryExtractor: { model: "local:fast" } } } })
})

test("agent picker, model roles and colored conversation fit all required terminal sizes", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = await b42Harness(width, height)
    const check = () => { expect(h.frames.at(-1)).toHaveLength(height); for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width) }
    await h.type("/agent\r")
    check()
    await h.type("\x1b")
    await h.type("/model roles\r")
    for (let i = 0; i < MODEL_PAGE_ROWS.length; i++) { check(); await h.app.onKey("\x1b[B") }
    await h.type("\x1b")
    conversation(h.sessionId, h.app.onEvent).exchange("Review the configuration", "The generation options now apply to the selected agent.")
    h.app.render()
    check()
  }
})

test("conversation footer uses the current agent color without adding a status row", async () => {
  const h = await b42Harness()
  conversation(h.sessionId, h.app.onEvent).exchange("Build", "Done.")
  h.app.render()
  const spans = h.frames.at(-1)!.flat()
  expect(spans.filter((span) => span.text === "Build")).toContainEqual(expect.objectContaining({ fgHex: "#22cc88" }))
  expect(h.text().filter((row) => row.includes("Build") && row.includes("Large") && !row.includes("local:large"))).toHaveLength(1)
})

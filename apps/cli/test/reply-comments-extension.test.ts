import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseCommentMessage } from "../src/view/reply-comments"
import { appHarness, extension, scratch } from "./extensions-harness"

const temporary: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })
const sandbox = () => { const temp = scratch(); temporary.push(temp); return temp }
const EXAMPLE = path.join(import.meta.dir, "../../../examples/extensions/comment-hunk.ts")

const submits = (harness: Awaited<ReturnType<typeof appHarness>>) => harness.sent.filter((command) => command.type === "user.submit").map((command) => command.text as string)

describe("the comments extension API", () => {
  test("the example extension adds a comment from code and reshapes the message before it is sent", async () => {
    const temp = sandbox()
    temp.write("data/extensions/comment-hunk.ts", readFileSync(EXAMPLE, "utf8"))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, width: 120, height: 40, mode: "full" })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "an answer")
      await harness.type("/hunk src/app.ts the null check is missing\r")
      expect(harness.text()).toContain("comment on src/app.ts added (1 pending)")
      expect(harness.text()).toContain("[1 “diff of src/app.ts”")
      await harness.type("ship it")
      await harness.key("\r")
      const [text] = submits(harness)
      expect(text).toBeDefined()
      expect(text).toEndWith("Reviewed 1 passage.")
      const parsed = parseCommentMessage(text!)
      expect(parsed?.comments).toHaveLength(1)
      // Not an answer: the wire says so instead of "earlier answer".
      expect(parsed?.comments[0]).toMatchObject({ quote: "diff of src/app.ts", text: "the null check is missing", of: "context" })
      expect(parsed?.note).toBe("ship it")
      expect(parsed?.tail).toBe("Reviewed 1 passage.")
    } finally { await harness.key("\x03") }
  })

  test("a transform that throws is disabled and the message goes as built", async () => {
    const temp = sandbox()
    temp.write("data/extensions/broken.ts", extension("broken", `
      api.command("c", "add", (args, actions) => { actions.comments.add({ quote: "q", text: "t" }) })
      api.comments.beforeSend(() => { throw new Error("boom") })
    `))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, mode: "full" })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "an answer")
      await harness.type("/c\r")
      await harness.key("\r")
      const [text] = submits(harness)
      expect(parseCommentMessage(text!)?.comments).toHaveLength(1)
      expect(text).not.toContain("boom")
    } finally { await harness.key("\x03") }
  })

  test("a transform returning something else than a string or nothing is ignored", async () => {
    const temp = sandbox()
    temp.write("data/extensions/odd.ts", extension("odd", `
      api.command("c", "add", (args, actions) => { actions.comments.add({ quote: "q", text: "t" }) })
      api.comments.beforeSend(() => 42)
    `))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, mode: "full" })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "an answer")
      await harness.type("/c\r")
      await harness.key("\r")
      expect(parseCommentMessage(submits(harness)[0]!)?.comments).toHaveLength(1)
    } finally { await harness.key("\x03") }
  })

  test("turning comments off while one is typed closes the mode and gives the prompt back", async () => {
    const temp = sandbox()
    temp.write("data/extensions/off.ts", extension("off", `api.key("ctrl+g", () => api.settings.set({ comments: "off" }))`))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, mode: "full" })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "an answer")
      await harness.type("kept words")
      await harness.key("\x1bq")
      await harness.key("c")
      expect(harness.text()).toContain("comment on")
      expect(harness.text()).not.toContain("kept words")
      await harness.key("\x07")
      expect(harness.text()).not.toContain("comment on")
      expect(harness.text()).toContain("kept words")
    } finally { await harness.key("\x03") }
  })

  test("the actions refuse an empty comment and the nineteenth: add says false", async () => {
    const temp = sandbox()
    temp.write("data/extensions/many.ts", extension("many", `
      api.command("fill", "add many", (args, actions) => {
        const results = [actions.comments.add({ quote: "q", text: "" })]
        for (let n = 0; n < 11; n++) results.push(actions.comments.add({ quote: "q" + n, text: "t" + n }))
        actions.toast(results.join(",") + ":" + actions.comments.list().length)
      })
    `))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, mode: "full", width: 160 })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "an answer")
      await harness.type("/fill\r")
      expect(harness.text()).toContain("false,true,true,true,true,true,true,true,true,true,false,false:9")
    } finally { await harness.key("\x03") }
  })
})

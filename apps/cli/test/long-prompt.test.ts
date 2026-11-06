import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import { MAX_INLINE_TEXT } from "@mendcode/protocol"
import { parseStartup, prepareRunSubmission } from "../src/startup"
import { composeLongText, LONG_TEXT_MAX_BYTES } from "../src/long-text"
import { boot, openSession, stop, until, type NativeHarness } from "../../../packages/daemon/test/native-harness"

let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const line = "una línea de la petición, con acentos y ñ\n"
const text = (bytes: number, end: string) => line.repeat(Math.ceil(bytes / Buffer.byteLength(line))).slice(0, bytes - end.length) + end

async function submitted(prompt: string, files: string[] = []) {
  const sessionId = await openSession(h!)
  for (const [index, content] of files.entries()) writeFileSync(path.join(h!.project, `request-${index}.md`), content)
  const names = files.map((_, index) => `request-${index}.md`)
  const submission = await prepareRunSubmission(h!.client, parseStartup(["run", ...(names.length ? ["--file", ...names] : [])]), sessionId, h!.project, prompt)
  return { sessionId, submission }
}

describe("a prompt or --file over the 64 KiB message limit", () => {
  test("a 96 KB positional prompt goes as one attachment and the model reads all of it", async () => {
    h = await boot({ steps: [stop("read")] })
    const prompt = text(96_645, "END-OF-PROMPT")
    const { sessionId, submission } = await submitted(prompt)
    expect(submission.type).toBe("user.submit")
    const sent = submission as Extract<CommandInput, { type: "user.submit" }>
    // The text is stored once: the message keeps only the label, the attachment holds the prompt.
    expect(sent.text).toBe("[prompt.txt]")
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0]).toMatchObject({ mime: "text/plain", bytes: Buffer.byteLength(prompt), label: "[prompt.txt]" })
    expect((await h.client.send(submission)).ok).toBe(true)
    await until(() => h!.requests.length === 1)
    const last = h.requests[0]!.messages.at(-1) as { content?: string }
    expect(last.content).toContain("END-OF-PROMPT")
    expect(last.content).toContain(prompt.slice(0, 200))
  })

  test("a 96 KB text --file with a short prompt is attached whole under its own name", async () => {
    h = await boot({ steps: [stop("read")] })
    const file = text(96_645, "END-OF-FILE")
    const { submission } = await submitted("summarize this", [file])
    const sent = submission as Extract<CommandInput, { type: "user.submit" }>
    expect(sent.text).toBe("summarize this\n\n[request-0.md]")
    expect(sent.attachments[0]).toMatchObject({ mime: "text/plain", label: "[request-0.md]", name: "request-0.md.txt" })
    expect((await h.client.send(submission)).ok).toBe(true)
    await until(() => h!.requests.length === 1)
    const content = (h.requests[0]!.messages.at(-1) as { content?: string }).content!
    expect(content).toContain("END-OF-FILE")
    expect(content.indexOf("[request-0.md]")).toBeLessThan(content.indexOf("END-OF-FILE"))
  })

  test("small text stays inline, as before, with nothing uploaded", async () => {
    const sent: string[] = []
    const composed = await composeLongText({ send: async (command) => { sent.push(command.type); return { ok: false, message: "unexpected" } }, prompt: "go", files: [{ name: "a.md", content: "notes" }] })
    expect(composed).toEqual({ ok: true, prompt: "go", fileText: "\n\n[a.md]\nnotes", attachments: [] })
    expect(sent).toEqual([])
  })

  test("only what does not fit moves: the larger file goes, the small one stays inline", async () => {
    const uploads: string[] = []
    const send = async (command: { name: string }) => { uploads.push(command.name); return { ok: true as const, attachment: { sha256: "a".repeat(64), bytes: 1, mime: "text/plain" } } }
    const composed = await composeLongText({ send, prompt: "go", files: [{ name: "big.md", content: "b".repeat(70_000) }, { name: "small.md", content: "tiny" }] })
    expect(composed).toMatchObject({ ok: true, prompt: "go", fileText: "\n\n[big.md]\n\n[small.md]\ntiny" })
    expect(uploads).toEqual(["big.md.txt"])
  })

  test("250 KB says which field, its size and the limit, and uploads nothing", async () => {
    h = await boot({ steps: [] })
    const sessionId = await openSession(h)
    writeFileSync(path.join(h.project, "huge.md"), text(250_000, "x"))
    const asFile = prepareRunSubmission(h.client, parseStartup(["run", "--file", "huge.md"]), sessionId, h.project, "read it")
    await expect(asFile).rejects.toThrow(/huge\.md is not a supported image and is larger than 200 KB \(250,0\d\d bytes; the limit is 204,800\)/)
    const asPrompt = prepareRunSubmission(h.client, parseStartup(["run"]), sessionId, h.project, text(250_000, "x"))
    await expect(asPrompt).rejects.toThrow(new RegExp(`the prompt is 250,0\\d\\d bytes; the limit is ${LONG_TEXT_MAX_BYTES.toLocaleString("en-US")} · put the text in --file files \\(up to 200 KiB each\\)`))
  })
})

describe("a text field the daemon refuses for length", () => {
  test("the client names the field, the size received and the limit", async () => {
    h = await boot({ steps: [] })
    const sessionId = await openSession(h)
    const reply = await h.client.send({ type: "user.submit", sessionId, text: "x".repeat(MAX_INLINE_TEXT + 1), attachments: [] })
    expect(reply.ok ? "" : reply.error.message).toBe("daemon rejected user.submit · text is 65,537 characters; the limit is 65,536")
  })
})

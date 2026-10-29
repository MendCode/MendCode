import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { read } from "../packages/tools/src"
import { resolvePastedPath } from "../packages/daemon/src/attachments"
import { appHarness, conversation, ids, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB50Frames(directory: string, sizes: string[]) {
  const project = tempDir("mendcode-b50-project-")
  mkdirSync(path.join(project, "assets"))
  const pdf = Buffer.from("%PDF-1.7\n%%EOF\n")
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0])
  writeFileSync(path.join(project, "design.pdf"), pdf)
  writeFileSync(path.join(project, "assets", "shot.png"), image)
  const ref = { sha256: createHash("sha256").update(pdf).digest("hex"), bytes: pdf.length, mime: "application/pdf", name: "design.pdf" }
  const cases = await Promise.all(["assets", "assets/shot.png", "design.pdf"].map(async (file) => ({ file, result: await read.execute({ path: file }, { cwd: project, signal: new AbortController().signal }) })))
  const pastedDirectory = await resolvePastedPath(path.join(project, "assets"), { directory: project })
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const scene = (draft = false) => {
      const h = appHarness({ width, height, mode: "full", dataDir: tempDir(), directory: "/work/project", reply: (command) => {
        if (command.type === "attachment.paste") return { ok: true, result: command.path.endsWith("assets") ? pastedDirectory : { kind: "document", attachment: ref, name: "design.pdf" } }
        if (command.type === "draft.get" && draft) return { ok: true, result: { draft: { text: "Review the design", attachments: [ref] } } }
        return { ok: true }
      } })
      h.app.applySettings({ onboarded: true })
      return h
    }
    const save = (h: ReturnType<typeof scene>, name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const pending = scene()
    await pending.type("/attach /work/project/design.pdf\r")
    save(pending, "prompt-pdf")
    await pending.type("\x7f/attach /work/project/assets\r")
    save(pending, "prompt-directory")
    const restored = scene(true)
    await Bun.sleep(5)
    save(restored, "prompt-pdf-restored")
    for (const { file, result } of cases) {
      const h = scene(), c = conversation(h.sessionId, h.app.onEvent), turnId = ids("turn"), itemId = ids("item")
      c.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      const userId = ids("item")
      c.emit({ type: "item.started", turnId, itemId: userId, kind: "user_message" })
      c.emit({ type: "item.completed", itemId: userId, status: "ok", text: `Read @${file}` })
      // Real tool output and metadata; normalize only the temporary fixture root in the saved frame.
      c.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "read", title: `Read ${file}`, input: JSON.stringify({ path: file }) } })
      c.emit({ type: "item.completed", itemId, status: result.isError ? "error" : "ok", text: result.output.replaceAll(project, "/work/project"), meta: { ...result.meta, path: `/work/project/${file}` } })
      c.emit({ type: "turn.completed", turnId })
      save(h, `chat-read-${file === "assets" ? "directory" : file.endsWith("png") ? "image" : "pdf"}`)
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
    for (const h of [pending, restored]) { await h.app.onKey("\x03"); await h.app.onKey("\x03") }
  }
}

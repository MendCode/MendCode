import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { AttachmentPasteResult, type BlobRef } from "@mendcode/protocol"
import { boot, callTool, openSession, put, say, stop, until, type NativeHarness } from "./native-harness"

let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe("multimedia read and attachments over the daemon wire", () => {
  test("PDF paste, typed client result, draft, submit and replay keep document MIME and bytes", async () => {
    h = await boot({ steps: [stop("reviewed"), stop("again")] })
    const id = await openSession(h)
    const file = path.join(h.project, "design.dat"), bytes = Buffer.from("%PDF-1.7\n")
    writeFileSync(file, bytes)
    const pasted = await h.client.pasteAttachment(file, h.project)
    expect(pasted.ok).toBe(true)
    if (!pasted.ok) throw new Error(pasted.error.message)
    expect(AttachmentPasteResult.safeParse(pasted.attachment).success).toBe(true)
    expect(pasted.attachment.kind).toBe("document")
    if (pasted.attachment.kind !== "document") throw new Error("expected a PDF")
    const ref = { ...pasted.attachment.attachment, name: pasted.attachment.name }
    expect(await h.client.send({ type: "draft.set", sessionId: id, text: "review", attachments: [ref] })).toMatchObject({ ok: true })
    expect(await h.client.send({ type: "draft.get", sessionId: id })).toMatchObject({ ok: true, result: { draft: { attachments: [ref] } } })
    expect(await h.client.send({ type: "user.submit", sessionId: id, text: "review", attachments: [ref] })).toMatchObject({ ok: true })
    await until(() => h!.store.turns.list(id).some((t) => t.status === "completed"))
    expect(h.requests[0]!.messages[0]).toMatchObject({ documents: [{ mime: "application/pdf", base64: bytes.toString("base64"), name: "design.dat" }], images: [] })
    const saved = h.store.engineMessages.load(id, "native")
    expect(JSON.stringify(saved)).not.toContain(bytes.toString("base64"))
    expect(h.events.find((e) => e.type === "item.completed" && e.attachments?.length)).toMatchObject({ attachments: [ref] })
    await say(h, id, "continue")
    expect(h.requests[1]!.messages[0]).toMatchObject({ documents: [{ mime: "application/pdf", name: "design.dat" }] })
  })

  test("read sends PDF and image after every tool result, and instructions load once across turns", async () => {
    h = await boot({ steps: [callTool("read", { path: "src/design.pdf" }), callTool("read", { path: "src/shot.png" }), stop("reviewed"), callTool("read", { path: "src/design.pdf" }), stop("done")] })
    put(path.join(h.project, "src/AGENTS.md"), "Use the scoped component contract.")
    put(path.join(h.project, "src/design.pdf"), "%PDF-1.7\n")
    writeFileSync(path.join(h.project, "src/shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))
    const id = await openSession(h)
    await say(h, id, "read these files")
    expect(h.requests[1]!.messages.at(-2)).toMatchObject({ role: "tool", name: "read", output: expect.stringContaining("scoped component contract") })
    expect(h.requests[1]!.messages.at(-1)).toMatchObject({ documents: [{ mime: "application/pdf", name: "design.pdf" }] })
    expect(h.requests[2]!.messages.at(-1)).toMatchObject({ images: [{ mime: "image/png" }] })
    await say(h, id, "read it again")
    const tool = h.requests.at(-1)!.messages.filter((m) => m.role === "tool").at(-1)!
    expect(tool).toMatchObject({ output: "PDF read successfully" })
    const saved = JSON.stringify(h.store.engineMessages.load(id, "native"))
    expect(saved).not.toContain(Buffer.from("%PDF-1.7\n").toString("base64"))
    expect(saved).toContain('"mime":"application/pdf"')
  })

  test("image/PDF/directory mentions resolve in one turn and preserve blob ownership for replay", async () => {
    h = await boot({ steps: [stop("done"), stop("again")] })
    put(path.join(h.project, "design notes/spec.pdf"), "%PDF-1.7\n")
    writeFileSync(path.join(h.project, "shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))
    const id = await openSession(h)
    await say(h, id, '@"design notes/spec.pdf" @shot.png @"design notes"')
    expect(h.requests[0]!.messages[0]).toMatchObject({ documents: [{ name: "spec.pdf" }], images: [{ mime: "image/png" }], content: expect.stringContaining("spec.pdf") })
    const message = h.store.engineMessages.load(id, "native")[0] as { attachments: BlobRef[] }
    expect(message.attachments).toHaveLength(2)
    for (const ref of message.attachments) expect(await Bun.file(h.store.blobPath(ref.sha256)).exists()).toBe(true)
    await say(h, id, "continue")
    expect(h.requests[1]!.messages[0]).toMatchObject({ documents: [{ name: "spec.pdf" }], images: [{ mime: "image/png" }] })
    const dir = await h.client.pasteAttachment(path.join(h.project, "design notes"), h.project)
    expect(dir).toMatchObject({ ok: true, attachment: { kind: "mention", path: "design notes" } })
  })
})

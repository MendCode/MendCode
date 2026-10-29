import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { isReadOnlyCommand } from "@mendcode/protocol"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { AttachmentError } from "../src/attachments"
import { startDaemon, type DaemonOptions } from "../src"
import { remoteTokens } from "../src/remote"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(extra: Partial<DaemonOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-attach-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...extra })
  const client = createClient({ socketPath: daemon.socketPath, name: "attach" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { client }
}

async function bootRemote(extra: Partial<DaemonOptions>) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-attach-remote-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...extra })
  cleanups.push(() => daemon.stop())
  return { dir, daemon }
}

describe("attachment.put", () => {
  test("R7 stores sent bytes by their real type, refuses other content, and is not a read-only command", async () => {
    const { client } = await boot()
    const stored = await client.send({ type: "attachment.put", name: "shot.png", data: Buffer.from(PNG).toString("base64") })
    expect(stored.ok ? stored.result?.attachment : undefined).toMatchObject({ mime: "image/png", bytes: PNG.byteLength })
    expect(stored.ok ? stored.result?.name : undefined).toBe("shot.png")
    expect(await client.send({ type: "attachment.put", name: "notes.png", data: Buffer.from("just text").toString("base64") })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(isReadOnlyCommand("attachment.put")).toBe(false)
  })

  test("a .txt name takes UTF-8 text, in ordered pieces when long; binary, broken UTF-8 and pieces out of order are refused", async () => {
    const { client } = await boot()
    const text = "línea de un log largo\n".repeat(20_000)
    const bytes = Buffer.from(text)
    const pieces = Array.from({ length: Math.ceil(bytes.length / 140_000) }, (_, index) => bytes.subarray(index * 140_000, (index + 1) * 140_000))
    const replies = []
    for (const [index, piece] of pieces.entries()) replies.push(await client.send({ type: "attachment.put", name: "paste-1.txt", data: piece.toString("base64"), part: { upload: "upload0001", index, last: index === pieces.length - 1 } }))
    expect(replies[0]).toMatchObject({ ok: true, result: { received: 140_000 } })
    expect(replies.at(-1)).toMatchObject({ ok: true, result: { attachment: { mime: "text/plain", bytes: bytes.length }, name: "paste-1.txt" } })
    expect(await client.send({ type: "attachment.put", name: "short.txt", data: Buffer.from("hola").toString("base64") })).toMatchObject({ ok: true, result: { attachment: { mime: "text/plain", bytes: 4 } } })
    expect(await client.send({ type: "attachment.put", name: "bin.txt", data: Buffer.from([0x61, 0, 0x62]).toString("base64") })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await client.send({ type: "attachment.put", name: "bad.txt", data: Buffer.from([0xc3, 0x28]).toString("base64") })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await client.send({ type: "attachment.put", name: "late.txt", data: Buffer.from("x").toString("base64"), part: { upload: "upload0002", index: 1, last: true } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})

describe("attachment.clipboard", () => {
  test("stores whatever the injected clipboard reader returns", async () => {
    const { client } = await boot({ clipboard: { read: async () => ({ bytes: PNG, mime: "image/png" }) } })
    const reply = await client.send({ type: "attachment.clipboard" })
    expect(reply.ok).toBe(true)
    expect(reply.ok ? reply.result?.name : undefined).toBe("clipboard.png")
    expect(reply.ok ? (reply.result?.attachment as { mime: string; bytes: number }) : undefined).toMatchObject({ mime: "image/png", bytes: PNG.byteLength })
  })

  test("a clipboard error is reported as invalid_command, not a crash", async () => {
    const { AttachmentError: Err } = (await import("../src/attachments")) as { AttachmentError: typeof AttachmentError }
    const { client } = await boot({
      clipboard: {
        read: async () => {
          throw new Err("no image in the clipboard")
        },
      },
    })
    const reply = await client.send({ type: "attachment.clipboard" })
    expect(reply.ok).toBe(false)
    expect(!reply.ok ? reply.error : undefined).toEqual({ code: "invalid_command", message: "[ATTACHMENT]: no image in the clipboard" })
  })
})

describe("clipboard images: locality, size and vision", () => {
  const sized = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x05, 0xa0, 0, 0, 0x03, 0x84])

  test("the ack carries the pixel size read from the image header", async () => {
    const { client } = await boot({ clipboard: { read: async () => ({ bytes: sized, mime: "image/png" }) } })
    const reply = await client.send({ type: "attachment.clipboard" })
    expect(reply.ok ? reply.result : undefined).toMatchObject({ name: "clipboard.png", width: 1440, height: 900 })
  })

  test("a remote client, even with a full-access token, never reads the daemon's clipboard", async () => {
    let reads = 0
    const { dir, daemon } = await bootRemote({ clipboard: { read: async () => { reads++; return { bytes: sized, mime: "image/png" } }, readText: async () => { reads++; return "secret" } } })
    const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await remote.connect()
    cleanups.push(() => remote.close())
    const reply = await remote.send({ type: "attachment.clipboard", text: true })
    expect(!reply.ok ? reply.error : undefined).toEqual({ code: "forbidden", message: "[DAEMON]: clipboard access is local only" })
    expect(reads).toBe(0)
  })

  test("the command is not in the read-only set", () => {
    expect(isReadOnlyCommand("attachment.clipboard")).toBe(false)
  })

  test("submitting an image to a model that does not take images fails with a clear error and sends nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-vision-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const daemon = await startDaemon({
      dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
      clipboard: { read: async () => ({ bytes: sized, mime: "image/png" }) },
      models: { selectable: true, list: () => [{ id: "text-only", name: "Text Only", efforts: [], modalities: { input: ["text"], output: ["text"] } }, { id: "vision", name: "Vision", efforts: [], modalities: { input: ["text", "image"], output: ["text"] } }, { id: "refuses", name: "Refuses", efforts: [], images: false }], defaults: { model: "text-only" } },
    })
    const client = createClient({ socketPath: daemon.socketPath, name: "vision" })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const project = path.join(dir, "project")
    mkdirSync(project)
    const created = await client.send({ type: "session.create", directory: project })
    const sessionId = created.ok ? (created.result!.sessionId as string) : ""
    const pasted = await client.send({ type: "attachment.clipboard" })
    const attachment = pasted.ok ? (pasted.result!.attachment as { sha256: string; bytes: number; mime: string }) : undefined
    expect(attachment).toBeDefined()
    const submit = (model?: string) => client.send({ type: "user.submit", sessionId, text: "what is this", attachments: [attachment!], ...(model ? { selection: { model: { model } } } : {}) } as never)
    const denied = await submit()
    expect(!denied.ok ? denied.error : undefined).toEqual({ code: "invalid_command", message: "[DAEMON]: Text Only does not accept images; pick a vision model or remove the image" })
    const refused = await submit("refuses")
    expect(!refused.ok ? refused.error.message : "").toContain("Refuses does not accept images")
    expect((await submit("vision")).ok).toBe(true)
  })
})

describe("attachment.paste", () => {
  test("an image path resolves to an image attachment", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-project-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = path.join(dir, "shot.png")
    writeFileSync(file, PNG)
    const { client } = await boot()
    const reply = await client.send({ type: "attachment.paste", path: file, directory: dir })
    expect(reply.ok).toBe(true)
    expect(reply.ok ? reply.result : undefined).toMatchObject({ kind: "image", name: "shot.png" })
  })

  test("a project file becomes a mention", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-project-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(path.join(dir, "src"))
    const file = path.join(dir, "src", "index.ts")
    writeFileSync(file, "export {}\n")
    const { client } = await boot()
    const reply = await client.send({ type: "attachment.paste", path: file, directory: dir })
    expect(reply.ok ? reply.result : undefined).toEqual({ kind: "mention", path: "src/index.ts" })
  })

  test("a small text file outside the project is inlined", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "attach-outside-"))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    const file = path.join(outside, "notes.txt")
    writeFileSync(file, "hola\n")
    const { client } = await boot()
    const reply = await client.send({ type: "attachment.paste", path: file })
    expect(reply.ok ? reply.result : undefined).toEqual({ kind: "text", name: "notes.txt", content: "hola\n" })
  })

  test("a missing path is invalid_command", async () => {
    const { client } = await boot()
    const reply = await client.send({ type: "attachment.paste", path: "/definitely/not/a/real/path.txt" })
    expect(reply.ok).toBe(false)
    expect(!reply.ok ? reply.error.code : undefined).toBe("invalid_command")
  })
})

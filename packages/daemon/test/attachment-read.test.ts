import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { ATTACHMENT_READ_CHUNK, Command, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A PNG-signed blob big enough for three chunks. */
const BIG = (() => {
  const bytes = new Uint8Array(ATTACHMENT_READ_CHUNK * 2 + 1234)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 31) & 255
  return bytes
})()

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-attread-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), clipboard: { read: async () => ({ bytes: BIG, mime: "image/png" }) } })
  const client = createClient({ socketPath: daemon.socketPath, name: "reader" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const project = path.join(dir, "project")
  mkdirSync(project)
  const session = async () => {
    const created = await client.send({ type: "session.create", directory: project })
    return created.ok ? (created.result!.sessionId as string) : ""
  }
  return { dir, daemon, client, session }
}

describe("attachment.read", () => {
  test("serves the blobs a session's own events reference, in chunks, by hash only", async () => {
    const { client, session } = await boot()
    const sessionId = await session()
    const pasted = await client.send({ type: "attachment.clipboard" })
    const attachment = pasted.ok ? (pasted.result!.attachment as { sha256: string; bytes: number; mime: string }) : undefined
    expect(attachment).toBeDefined()
    expect((await client.send({ type: "user.submit", sessionId, text: "look at this", attachments: [attachment!] } as never)).ok).toBe(true)
    const collected: Buffer[] = []
    let offset = 0
    for (let guard = 0; guard < 10; guard++) {
      const reply = await client.send({ type: "attachment.read", sessionId, sha256: attachment!.sha256, offset } as never)
      expect(reply.ok).toBe(true)
      const result = (reply.ok ? reply.result : undefined) as { sha256: string; mime: string; bytes: number; offset: number; data: string; done: boolean }
      expect(result).toMatchObject({ sha256: attachment!.sha256, mime: "image/png", bytes: BIG.length, offset })
      const part = Buffer.from(result.data, "base64")
      expect(part.length).toBeLessThanOrEqual(ATTACHMENT_READ_CHUNK)
      collected.push(part)
      offset += part.length
      if (result.done) break
    }
    expect(collected).toHaveLength(3)
    expect(createHash("sha256").update(Buffer.concat(collected)).digest("hex")).toBe(attachment!.sha256)
  })

  test("an unknown hash, another session's blob and a bad offset are refused", async () => {
    const { client, session } = await boot()
    const sessionId = await session()
    const other = await session()
    const pasted = await client.send({ type: "attachment.clipboard" })
    const attachment = (pasted.ok ? pasted.result!.attachment : undefined) as { sha256: string; bytes: number; mime: string }
    // Stored but never referenced by an event: nothing serves it.
    expect(await client.send({ type: "attachment.read", sessionId, sha256: attachment.sha256 } as never)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    await client.send({ type: "user.submit", sessionId, text: "mine", attachments: [attachment] } as never)
    expect(await client.send({ type: "attachment.read", sessionId: other, sha256: attachment.sha256 } as never)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await client.send({ type: "attachment.read", sessionId, sha256: "0".repeat(64) } as never)).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await client.send({ type: "attachment.read", sessionId, sha256: attachment.sha256, offset: BIG.length + 1 } as never)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })

  test("a remote client never reads session attachments, and the command is not read-only", async () => {
    const { dir, daemon, client, session } = await boot()
    const sessionId = await session()
    const pasted = await client.send({ type: "attachment.clipboard" })
    const attachment = (pasted.ok ? pasted.result!.attachment : undefined) as { sha256: string; bytes: number; mime: string }
    await client.send({ type: "user.submit", sessionId, text: "mine", attachments: [attachment] } as never)
    const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await remote.connect()
    cleanups.push(() => remote.close())
    const reply = await remote.send({ type: "attachment.read", sessionId, sha256: attachment.sha256 } as never)
    expect(!reply.ok ? reply.error.code : "").toBe("forbidden")
    expect(isReadOnlyCommand("attachment.read")).toBe(false)
  })

  test("the schema takes a session, a 64-hex hash and a non-negative offset only", () => {
    const ids = createIdFactory()
    const base = { id: ids("command"), clientId: ids("client"), type: "attachment.read", sessionId: ids("session"), sha256: "a".repeat(64) }
    expect(Command.safeParse(base).success).toBe(true)
    expect(Command.safeParse({ ...base, offset: 4096 }).success).toBe(true)
    expect(Command.safeParse({ ...base, offset: -1 }).success).toBe(false)
    expect(Command.safeParse({ ...base, sha256: "../etc/passwd" }).success).toBe(false)
    expect(Command.safeParse({ ...base, path: "/etc/passwd" }).success).toBe(false)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fake credential: distinct from any real one. */
const FAKE_KEY = "s" + "k-" + new Bun.CryptoHasher("sha256").update("fake:prompt-history").digest("hex").repeat(2).slice(0, 48)

async function boot() {
  const dir = temp("mendd-prompt-history-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "history" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const project = temp("mendd-prompt-history-project-")
  const created = await client.send({ type: "session.create", directory: project })
  if (!created.ok) throw new Error("session.create failed")
  const sessionId = created.result!.sessionId as SessionId
  return { client, daemon, dir, project, sessionId }
}

const entries = async (client: Awaited<ReturnType<typeof boot>>["client"], directory: string) => {
  const reply = await client.send({ type: "prompt.history", directory })
  if (!reply.ok) throw new Error(reply.error.message)
  return { prompts: reply.result!.prompts as string[], entries: reply.result!.entries as Array<{ id: number; kind: string; text: string }> }
}

describe("prompt history over the wire", () => {
  test("typed commands and discarded drafts join the sent messages in one list per project, kinds included", async () => {
    const { client, project, sessionId } = await boot()
    expect(await client.send({ type: "prompt.record", sessionId, text: "/panel next", kind: "command" })).toMatchObject({ ok: true, result: { kept: "command" } })
    expect(await client.send({ type: "prompt.record", sessionId, text: "a long draft that was cleared", kind: "draft" })).toMatchObject({ ok: true, result: { kept: "draft" } })
    const listed = await entries(client, project)
    expect(listed.entries.map(({ kind, text }) => [kind, text])).toEqual([["draft", "a long draft that was cleared"], ["command", "/panel next"]])
    expect(listed.prompts).toEqual(["a long draft that was cleared", "/panel next"])
  })

  test("a pasted secret is stored as its marker, and a line that is only a marker is not stored", async () => {
    const { client, project, sessionId } = await boot()
    expect(await client.send({ type: "prompt.record", sessionId, text: `export OPENAI_API_KEY=${FAKE_KEY} then run the build`, kind: "draft" })).toMatchObject({ ok: true, result: { kept: "draft" } })
    expect(await client.send({ type: "prompt.record", sessionId, text: FAKE_KEY, kind: "draft" })).toEqual(expect.objectContaining({ ok: true }))
    const listed = await entries(client, project)
    expect(listed.prompts).toHaveLength(1)
    expect(listed.prompts[0]).toContain("‹secret:1›")
    expect(JSON.stringify(listed)).not.toContain(FAKE_KEY)
  })

  test("an entry is deleted by id and the drafts are cleared; a malformed delete is refused", async () => {
    const { client, project, sessionId } = await boot()
    await client.send({ type: "prompt.record", sessionId, text: "/model", kind: "command" })
    await client.send({ type: "prompt.record", sessionId, text: "an unsent draft to clear", kind: "draft" })
    await client.send({ type: "prompt.record", sessionId, text: "/btw what changed here", kind: "command" })
    const [newest] = (await entries(client, project)).entries
    expect(await client.send({ type: "prompt.history.delete", directory: project, entryId: newest!.id })).toMatchObject({ ok: true, result: { removed: 1 } })
    expect(await client.send({ type: "prompt.history.delete", directory: project, drafts: true })).toMatchObject({ ok: true, result: { removed: 1 } })
    expect((await entries(client, project)).prompts).toEqual(["/model"])
    expect(await client.send({ type: "prompt.history.delete", directory: project })).toMatchObject({ ok: false })
  })

  test("recording for an unknown session is refused", async () => {
    const { client } = await boot()
    expect(await client.send({ type: "prompt.record", sessionId: createIdFactory()("session") as SessionId, text: "/model", kind: "command" })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("a remote client, read-only or not, can neither read nor change the local prompt history", async () => {
    const { client, daemon, dir, project, sessionId } = await boot()
    await client.send({ type: "prompt.record", sessionId, text: "/local only command", kind: "command" })
    for (const readOnly of [true, false]) {
      const token = remoteTokens(dir).create({ name: readOnly ? "viewer" : "full", readOnly }).token
      const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
      await remote.connect()
      cleanups.push(() => remote.close())
      expect(await remote.send({ type: "prompt.history", directory: project })).toMatchObject({ ok: false })
      if (!readOnly) {
        expect(await remote.send({ type: "prompt.history", directory: project })).toMatchObject({ ok: false, error: { code: "forbidden" } })
        expect(await remote.send({ type: "prompt.record", sessionId, text: "/from a remote client", kind: "command" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
        expect(await remote.send({ type: "prompt.history.delete", directory: project, drafts: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
      }
    }
    expect((await entries(client, project)).prompts).toEqual(["/local only command"])
  })
})

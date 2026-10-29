import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { createOrchestrationReceipts } from "../src/orchestration-receipts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
test("lost ACK replays after store restart; changed arguments and scope do not collide", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-receipts-")); dirs.push(dir)
  let store = openStore({ dir }), calls = 0
  const input = { project: dir, owner: "owner", operation: "thread_create", requestId: "r1", args: { title: "Child" }, execute: async () => { calls++; return { ok: true as const, output: "sessionId=child state=idle" } } }
  try {
    expect(await createOrchestrationReceipts(store.meta).run(input)).toMatchObject({ ok: true })
    store.close()
    store = openStore({ dir })
    const receipts = createOrchestrationReceipts(store.meta)
    expect(await receipts.run(input)).toEqual({ ok: true, output: "sessionId=child state=idle" })
    expect(calls).toBe(1)
    expect(await receipts.run({ ...input, args: { title: "Different" } })).toMatchObject({ ok: false, message: "Conflicting clientRequestId" })
    expect(await receipts.run({ ...input, owner: "other" })).toMatchObject({ ok: true })
    expect(calls).toBe(2)
  } finally { store.close() }
})
test("concurrent pending and restart after uncertain dispatch never repeat an effect", async () => {
  const values = new Map<string, string>()
  const meta = { get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value) } }
  let resolve!: () => void, calls = 0
  const input = { project: "/temp", owner: "owner", operation: "thread_message", requestId: "r1", args: { text: "hi" }, execute: async () => { calls++; await new Promise<void>((done) => { resolve = done }); throw new Error("lost after send") } }
  const pending = createOrchestrationReceipts(meta).run(input).catch(() => undefined)
  expect(await createOrchestrationReceipts(meta).run(input)).toMatchObject({ ok: false, message: expect.stringContaining("unknown") })
  resolve(); await pending
  expect(await createOrchestrationReceipts(meta).run(input)).toMatchObject({ ok: false })
  expect(calls).toBe(1)
  expect([...values.values()].join(" ")).not.toContain('"hi"')
})

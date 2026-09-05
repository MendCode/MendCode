import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { acquireWriterLease } from "../../src/storage/writer-lease"

test("one writer owns the canonical database path until release", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "sessions.db")
  const release = acquireWriterLease(file)
  try {
    expect(() => acquireWriterLease(path.join(tmp.path, "child", "..", "sessions.db"))).toThrow("already has a writer")
    expect(await Bun.file(file).exists()).toBe(false)
  } finally { release() }
  release()
  acquireWriterLease(file)()
})

test("a second process cannot acquire the same writer lease and dead owners recover without deleting evidence", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "sessions.db")
  const module = path.resolve(import.meta.dir, "../../src/storage/writer-lease.ts")
  const source = `import {acquireWriterLease} from ${JSON.stringify(module)}; acquireWriterLease(process.argv[1]);`
  const run = async () => {
    const child = Bun.spawn([process.execPath, "-e", source, file], { stdout: "pipe", stderr: "pipe" })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr }
  }
  const release = acquireWriterLease(file)
  try {
    const blocked = await run()
    expect(blocked.code).not.toBe(0)
    expect(blocked.stderr).toContain("already has a writer")
  } finally { release() }
  expect((await run()).code).toBe(0)
  acquireWriterLease(file)()
  expect((await fs.readdir(tmp.path)).some((entry) => entry.startsWith("sessions.db.writer-lock.recovered-"))).toBe(true)
})

test("missing or changed ownership fails closed", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "sessions.db")
  const release = acquireWriterLease(file)
  const metadata = path.join(`${file}.writer-lock`, "owner.json")
  const original = await fs.readFile(metadata, "utf8")
  await fs.writeFile(metadata, JSON.stringify({ pid: process.pid, token: "00000000-0000-0000-0000-000000000000" }))
  expect(release).toThrow("no longer owned")
  await fs.writeFile(metadata, original)
  release()
})

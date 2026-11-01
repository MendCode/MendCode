import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { previewPastedEnvironment } from "../src/environment-import"

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-envp-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

const PASTE = [
  "# service keys", "export FAKE_TOKEN=abc123", "QUOTED='has # hash'", 'MULTI="one\\ntwo"', "BLOCK='first", "second'",
  "DUP=old", "DUP=new", "PATH=/evil", "NODE_OPTIONS=--inspect", "EMPTY=", "LITERAL=${HOME}",
].join("\n")

test("pasted dotenv text lists every name with a status: literal values, last duplicate wins, runtime names refused, empty skipped", () => {
  const { items, values } = previewPastedEnvironment(PASTE, new Set(["FAKE_TOKEN"]))
  const status = Object.fromEntries(items.map((item) => [item.name, item.status]))
  expect(status).toEqual({ FAKE_TOKEN: "replace", QUOTED: "new", MULTI: "new", BLOCK: "new", DUP: "new", PATH: "refused", NODE_OPTIONS: "refused", EMPTY: "empty", LITERAL: "new" })
  expect(items.find((item) => item.name === "DUP")?.duplicates).toBe(1)
  expect(values).toEqual({ FAKE_TOKEN: "abc123", QUOTED: "has # hash", MULTI: "one\ntwo", BLOCK: "first\nsecond", DUP: "new", LITERAL: "${HOME}" })
  expect(JSON.stringify(items)).not.toContain("abc123")
  expect(() => previewPastedEnvironment("not an assignment", new Set())).toThrow()
})

test("env.import with pasted content previews names only and saves just the chosen subset, encrypted", async () => {
  const dir = temp(), project = temp()
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "d.sock"), info: { engine: "native" }, log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "env-paste-test" })
  await client.connect(); cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result?.sessionId : "") as SessionId
  await client.send({ type: "env.set", sessionId, name: "FAKE_TOKEN", value: "previous-fake", scope: "project" })
  const preview = await client.send({ type: "env.import", sessionId, content: PASTE, scope: "project" })
  expect(preview.ok).toBe(true)
  const result = preview.ok ? preview.result! : {}
  expect(result.names).toEqual(["BLOCK", "DUP", "FAKE_TOKEN", "LITERAL", "MULTI", "QUOTED"])
  for (const secret of ["abc123", "has # hash", "previous-fake", "/evil"]) expect(JSON.stringify(preview)).not.toContain(secret)
  expect((result.items as { name: string; status: string }[]).find((item) => item.name === "FAKE_TOKEN")?.status).toBe("replace")
  const digest = result.digest as string
  // A changed paste, or a name that was not detected or is refused, is not saved.
  expect((await client.send({ type: "env.import", sessionId, content: PASTE + "\nX=1", scope: "project", digest })).ok).toBe(false)
  expect((await client.send({ type: "env.import", sessionId, content: PASTE, scope: "project", digest, names: ["PATH"] })).ok).toBe(false)
  expect((await client.send({ type: "env.import", sessionId, content: PASTE, scope: "project", digest, names: ["QUOTED", "UNKNOWN"] })).ok).toBe(false)
  expect((await client.send({ type: "env.import", sessionId, content: PASTE, scope: "project", path: ".env" })).ok).toBe(false)
  const applied = await client.send({ type: "env.import", sessionId, content: PASTE, scope: "project", digest, names: ["FAKE_TOKEN", "QUOTED"] })
  expect(applied.ok).toBe(true)
  const entries = (applied.ok ? applied.result?.entries : []) as { name: string }[]
  expect(entries.map((entry) => entry.name)).toEqual(["FAKE_TOKEN", "QUOTED"])
  expect(JSON.stringify(applied)).not.toContain("abc123")
  const vault = readFileSync(path.join(dir, "environment.enc"))
  for (const secret of ["abc123", "has # hash", "FAKE_TOKEN"]) expect(vault.includes(Buffer.from(secret))).toBe(false)
})

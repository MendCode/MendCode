import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import { shell, read } from "@mendcode/tools"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { openStore } from "@mendcode/store"
import { parseEnvironmentFile, readEnvironmentImport } from "../src/environment-import"

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-env-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

test("privacy RPC reports incomplete files, warns through the daemon logger and retains typed attachment errors", async () => {
  const dir = temp()
  const store = openStore({ dir })
  const sessionId = "ses_01J00000000000000000000000" as SessionId
  store.createSession({ id: sessionId, directory: dir, title: "attachment" })
  const blob = store.putBlob(Buffer.from("attachment"), "text/plain")
  store.refBlob(blob, sessionId)
  store.privacy.set(true)
  const file = store.blobPath(blob.sha256)
  const damaged = readFileSync(file); damaged[damaged.length - 1]! ^= 1; writeFileSync(file, damaged)
  // A clean encrypted store opens on headers alone, so the damage is found by the full pass a pending conversion runs:
  // a blob left in plain form, as by an interrupted conversion, is what starts one.
  const plain = Buffer.from("left plain"), plainName = new Bun.CryptoHasher("sha256").update(plain).digest("hex")
  mkdirSync(path.dirname(store.blobPath(plainName)), { recursive: true })
  writeFileSync(store.blobPath(plainName), plain)
  store.close()
  const warnings: string[] = []
  const daemon = await startDaemon({ dir, defaultDirectory: dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock }) => createFauxEngine({ clock }), log: (level, message) => { if (level === "warn") warnings.push(message) } })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "privacy-test" })
  await client.connect(); cleanups.push(() => client.close())
  const status = await client.send({ type: "privacy.get" })
  expect(status.ok && status.result).toEqual({ enabled: false, target: true, pending: 1, unreadable: [file] })
  expect(warnings.filter((message) => message.startsWith("[PRIVACY]"))).toEqual([`[PRIVACY]: unreadable ${JSON.stringify(file)}`])
  const read = await client.send({ type: "attachment.read", sessionId, sha256: blob.sha256 })
  expect(read.ok).toBe(false)
  expect(!read.ok && read.error.code).toBe("internal")
  const disabled = await client.send({ type: "privacy.set", enabled: false })
  expect(disabled.ok && disabled.result).toEqual({ enabled: false, target: false, pending: 1, unreadable: [file] })
  expect(readFileSync(file)).toEqual(damaged)
})

test("dotenv parses literal quoted and multiline values, with no shell expansion", () => {
  expect(parseEnvironmentFile("export API_KEY='abc#123'\nURL=https://example.test # comment\nMULTI=\"one\\ntwo\"\nLITERAL=${HOME}\nEMPTY=\n")).toEqual({ API_KEY: "abc#123", URL: "https://example.test", MULTI: "one\ntwo", LITERAL: "${HOME}" })
  expect(parseEnvironmentFile("MULTI='first\nsecond'\n")).toEqual({ MULTI: "first\nsecond" })
  expect(() => parseEnvironmentFile("SECRET='unterminated")).toThrow()
  const root = temp(), outside = temp()
  writeFileSync(path.join(outside, ".env"), "API_KEY=outside-secret")
  expect(() => readEnvironmentImport(root, path.join(outside, ".env"))).toThrow("inside this project")
})

test("vault RPCs import atomically and native tools use env without values reaching the model, events or disk", async () => {
  const dir = temp(), project = temp()
  const value = "private-voice-fixture-321"
  const requests: ModelRequest[] = [], events: SessionEvent[] = []
  const transcript = path.join(dir, "session-transcripts", "session-g1.md")
  mkdirSync(path.dirname(transcript))
  writeFileSync(transcript, "private-transcript-sentinel")
  writeFileSync(path.join(project, "plain.txt"), "ordinary-file-sentinel")
  let call = 0
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "d.sock"), info: { engine: "native" }, log: () => {}, engine: ({ store, secrets }) => createNativeEngine({
    provider: { id: "fake", model: "fake", async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      if (call++ === 0) { yield { type: "tool_call", call: { callId: "voice", name: "shell", args: { command: "printf '%s' \"$ELEVENLABS_API_KEY\"" } } }; yield { type: "finish", reason: "tool_calls" } }
      else if (call === 2) { yield { type: "tool_call", call: { callId: "transcript", name: "read", args: { paths: [{ path: transcript }, { path: "plain.txt" }] } } }; yield { type: "finish", reason: "tool_calls" } }
      else { yield { type: "text", delta: "done" }; yield { type: "finish", reason: "stop" } }
    } }, tools: [shell, read], secrets, readStoredFile: store.readStoredFile, history: memoryHistory(), cwdFor: () => project, system: () => "BASE", compactionPrompt: "SUM", permissionPolicy: () => ({ permission: "allow" }),
  }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "env-test", onEvent: (event) => { events.push(event) } })
  await client.connect(); cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project })
  expect(created.ok).toBe(true)
  const sessionId = (created.ok ? created.result?.sessionId : "") as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "session.permission.set", sessionId, mode: "full" })
  expect((await client.send({ type: "env.set", sessionId, name: "ELEVENLABS_API_KEY", value, scope: "project" })).ok).toBe(true)
  expect((await client.send({ type: "env.set", sessionId, name: "BASH_ENV", value: "unsafe", scope: "project" })).ok).toBe(false)
  writeFileSync(path.join(project, ".env"), "SECOND_API_KEY='another-private-fixture'\n")
  const preview = await client.send({ type: "env.import", sessionId, path: ".env", scope: "project" })
  expect(preview.ok && preview.result?.names).toEqual(["SECOND_API_KEY"])
  expect(JSON.stringify(preview)).not.toContain("another-private-fixture")
  const digest = (preview.ok ? preview.result?.digest : "") as string
  writeFileSync(path.join(project, ".env"), "SECOND_API_KEY=changed\n")
  expect((await client.send({ type: "env.import", sessionId, path: ".env", scope: "project", digest })).ok).toBe(false)
  const latest = await client.send({ type: "env.import", sessionId, path: ".env", scope: "project" })
  expect((await client.send({ type: "env.import", sessionId, path: ".env", scope: "project", digest: (latest.ok ? latest.result?.digest : "") as string })).ok).toBe(true)
  expect((await client.send({ type: "privacy.set", enabled: true })).ok).toBe(true)
  expect((await client.send({ type: "user.submit", sessionId, text: "Use the configured voice service", attachments: [] })).ok).toBe(true)
  const deadline = Date.now() + 8000
  while (!events.some((event) => event.type === "turn.completed") && Date.now() < deadline) await Bun.sleep(10)
  expect(events.find((event) => event.type === "turn.failed")).toBeUndefined()
  expect(events.some((event) => event.type === "turn.completed")).toBe(true)
  expect(requests[0]?.system).toContain("env ELEVENLABS_API_KEY")
  expect(JSON.stringify(requests)).toContain("‹env:ELEVENLABS_API_KEY›")
  expect(JSON.stringify(requests)).toContain("private-transcript-sentinel")
  expect(JSON.stringify(requests)).toContain("ordinary-file-sentinel")
  expect(readFileSync(transcript).includes(Buffer.from("private-transcript-sentinel"))).toBe(false)
  expect(JSON.stringify([requests, events])).not.toContain(value)
  expect(readFileSync(path.join(dir, "mendd.db")).includes(Buffer.from("configured voice service"))).toBe(false)
  expect(readFileSync(path.join(dir, "environment.enc")).includes(Buffer.from(value))).toBe(false)
}, 20_000)

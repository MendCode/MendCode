import { afterEach, expect, test } from "bun:test"
import { renameSync, rmSync } from "node:fs"
import type { BlobRef, SessionId } from "@mendcode/protocol"
import { createComputerTools } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"
import { captureData, computerFixture, signal } from "../../daemon/test/b29-fixtures"

const fixtures: ReturnType<typeof computerFixture>[] = []
afterEach(() => { for (const f of fixtures.splice(0)) { f.control.stop(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }) } })
function fixture() { const f = computerFixture(); fixtures.push(f); return f }

test("native computer tools require execute authority and bind the current session after approval", async () => {
  const f = fixture()
  for (const mode of ["plan", "ask", "edits", "full"] as const) {
    const script = scriptedProvider([callTool("computer_capture", {}), stop("Captured")])
    const origins: SessionId[] = []
    const engine = createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: (id) => (origins.push(id), f.control.port(id)) })
    const current = turn({ text: "Capture the main display", sessionId: f.sessionId, mode: () => mode, answers: [{ kind: "approve", scope: "once" }] })
    await engine.runTurn(current.input)
    expect(origins).toEqual(mode === "plan" ? [] : [f.sessionId])
    expect(current.asked).toHaveLength(mode === "ask" || mode === "edits" ? 1 : 0)
    if (current.asked.length) expect(current.asked[0]).toMatchObject({ kind: "approval", tool: "computer_capture", permission: "execute" })
  }
})

test("denied computer capture and invalid keys never dispatch native effects", async () => {
  const f = fixture()
  const script = scriptedProvider([callTool("computer_capture", {}), stop("Denied")])
  const engine = createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port, permissionPolicy: () => ({ experimental: { continue_loop_on_deny: true } }) })
  await engine.runTurn(turn({ text: "Capture", sessionId: f.sessionId }).input)
  expect(f.os.calls).toEqual([])
  expect(script.requests.at(-1)!.messages.some((message) => message.role === "tool" && message.isError)).toBe(true)
  const bad = scriptedProvider([callTool("computer_key", { captureID: crypto.randomUUID(), key: "type", text: "secret" }), stop("Invalid")])
  await createNativeEngine({ provider: bad.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port }).runTurn(turn({ text: "Key", sessionId: f.sessionId, mode: () => "full" }).input)
  expect(f.os.calls).toEqual([])
})

test("a keyboard capture that expires during permission review cannot press a key", async () => {
  const f = fixture()
  const capture = captureData(await f.port.capture({}, signal()))
  const script = scriptedProvider([callTool("computer_key", { captureID: capture.captureID, key: "tab" }), stop("Expired")])
  const engine = createNativeEngine({ provider: script.provider, tools: createComputerTools(), history: memoryHistory(), cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port })
  const current = turn({ text: "Press Tab", sessionId: f.sessionId })
  current.input.ask = async () => { f.advance(30_001); return { kind: "approve", scope: "once" } }
  await engine.runTurn(current.input)
  expect(f.os.keys).toEqual([])
  expect(script.requests.at(-1)!.messages.some((message) => message.role === "tool" && message.output.includes("stale"))).toBe(true)
})

test("equal captures reuse model-visible image refs and reattach when compacted history has removed them", async () => {
  const f = fixture()
  const history = memoryHistory()
  const script = scriptedProvider([callTool("computer_capture", {}), callTool("computer_capture", {}), stop("Seen")])
  const saved: BlobRef[] = []
  const options = {
    tools: createComputerTools(), history, cwdFor: () => f.dir, system: () => "SYS", compactionPrompt: "C", computer: f.control.port,
    readBlob: async (ref: BlobRef) => new Uint8Array(await Bun.file(f.store.blobPath(ref.sha256)).arrayBuffer()),
    storeBlob: async (bytes: Uint8Array, mime: string, sessionId: SessionId) => {
      const ref = f.store.putBlob(bytes, mime)
      f.store.refBlob(ref, sessionId)
      saved.push(ref)
      return ref
    },
  }
  await createNativeEngine({ ...options, provider: script.provider }).runTurn(turn({ text: "Capture twice", sessionId: f.sessionId, mode: () => "full" }).input)
  expect(saved).toHaveLength(1)
  expect(script.requests.at(-1)!.messages.flatMap((message) => message.role === "user" ? message.attachments ?? [] : [])).toHaveLength(1)
  const results = script.requests.at(-1)!.messages.filter((message) => message.role === "tool")
  expect(JSON.parse(results[1]!.output).unchangedFrom).toBe(JSON.parse(results[0]!.output).captureID)
  const blobPath = f.store.blobPath(saved[0]!.sha256)
  renameSync(blobPath, `${blobPath}.missing`)
  const missing = scriptedProvider([callTool("computer_capture", {}), stop("Restored")])
  await createNativeEngine({ ...options, provider: missing.provider }).runTurn(turn({ text: "Capture after losing the blob", sessionId: f.sessionId, mode: () => "full" }).input)
  expect(saved).toHaveLength(2)
  expect(missing.requests.at(-1)!.messages.flatMap((message) => message.role === "user" ? message.images ?? [] : []).length).toBeGreaterThan(0)
  expect(missing.requests.at(-1)!.messages.flatMap((message) => message.role === "user" ? message.attachments ?? [] : [])).toHaveLength(1)
  await history.replace(f.sessionId, [{ role: "user", content: "Compacted summary" }])
  const compacted = scriptedProvider([callTool("computer_capture", {}), stop("Seen again")])
  await createNativeEngine({ ...options, provider: compacted.provider }).runTurn(turn({ text: "Capture after compaction", sessionId: f.sessionId, mode: () => "full" }).input)
  expect(saved).toHaveLength(3)
  expect(compacted.requests.at(-1)!.messages.flatMap((message) => message.role === "user" ? message.attachments ?? [] : [])).toHaveLength(1)
})

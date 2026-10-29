import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PermissionMode, Settings } from "@mendcode/protocol"
import type { ThreadPort } from "@mendcode/tools"
import { threadsTool } from "../../daemon/src/thread-tool"
import { createGrantStore, createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(actions: Array<{ action: "read" | "search" | "wait" | "merge_back"; sessionId?: string }>, extra: Partial<Parameters<typeof createNativeEngine>[0]> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "mend-thread-consent-"))
  dirs.push(cwd)
  const calls: string[] = []
  const mentioned = new Set<string>()
  const result = (target: string) => { calls.push(target); return { ok: true as const, output: "bounded history" } }
  const port: ThreadPort = {
    granted: (target) => mentioned.has(target), list: () => result("list"),
    read: (args) => result(args.sessionId), search: (args) => result(args.sessionId),
    wait: async (args) => result(args.sessionId), mergeBack: (args) => result(args.sessionId), stats: (args) => result(args.sessionId ?? "self"),
    message: async (args) => result(args.sessionId), interrupt: async (args) => result(args.sessionId),
  }
  const { provider, requests } = scriptedProvider([...actions.map((args) => callTool("threads", { sessionId: "thread_A", text: "query", ...args })), stop("done")])
  const grants = createGrantStore()
  const engine = createNativeEngine({ provider, tools: [threadsTool], history: memoryHistory(), grants, cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize", threads: () => port, permissionPolicy: () => ({ experimental: { thread_tools: true } }), ...extra })
  return { engine, calls, mentioned, grants, requests }
}

for (const mode of ["ask", "smart", "edits", "plan"] as PermissionMode[]) {
  for (const action of ["read", "search", "wait"] as const) {
    test(`${mode}: ${action} requires individual consent despite allow rules and saved grants`, async () => {
      const h = fixture([{ action }, { action }], { permissionPolicy: () => ({ experimental: { thread_tools: true }, permission: { threads: "allow" } }) })
      const t = turn({ text: "check", mode: () => mode, answers: [{ kind: "approve", scope: "session" }, { kind: "approve", scope: "once" }] })
      h.grants.add(t.input.sessionId, "threads", "read")
      await h.engine.runTurn(t.input)
      expect(t.asked).toHaveLength(2)
      expect(t.asked.every((request) => request.kind === "approval" && request.permissionContext?.always.length === 0)).toBe(true)
      expect(h.calls).toEqual(["thread_A", "thread_A"])
    })
  }
}

test("full access reads another session without asking: the user chose to run unattended", async () => {
  for (const action of ["read", "search", "wait", "merge_back"] as const) {
    const h = fixture([{ action }])
    const t = turn({ text: "check", mode: () => "full" })
    await h.engine.runTurn(t.input)
    expect(t.asked).toHaveLength(0)
    expect(h.calls).toEqual(["thread_A"])
  }
})

test("a session id the user wrote in the message is consent to read that session, and only that one", async () => {
  const h = fixture([{ action: "read" }, { action: "search", sessionId: "thread_B" }])
  const t = turn({ text: "how long did thread_A work?", mode: () => "ask", answers: [{ kind: "deny" }] })
  await h.engine.runTurn(t.input)
  expect(h.calls).toEqual(["thread_A"])
  expect(t.asked).toHaveLength(1)
})

test("mentions grant only their target; a denied read never executes", async () => {
  const h = fixture([{ action: "read" }, { action: "search", sessionId: "thread_B" }])
  h.mentioned.add("thread_A")
  const t = turn({ text: "@thread:thread_A", mode: () => "edits", answers: [{ kind: "deny" }] })
  await h.engine.runTurn(t.input)
  expect(h.calls).toEqual(["thread_A"])
  expect(t.asked).toHaveLength(1)
})

test("a hook redirect from a mentioned target asks again for the rewritten target", async () => {
  const h = fixture([{ action: "read" }], { hooks: { has: (event) => event === "tool.before", toolBefore: async () => ({ args: { action: "read", sessionId: "thread_B" } }) } })
  h.mentioned.add("thread_A")
  const t = turn({ text: "@thread:thread_A", mode: () => "edits", answers: [{ kind: "deny" }] })
  await h.engine.runTurn(t.input)
  expect(t.asked).toHaveLength(1)
  expect(h.calls).toEqual([])
})

test("deny rules win over mentions; a deny added during approval also wins", async () => {
  let permission: Settings["permission"] = { threads: "deny" }
  const h = fixture([{ action: "read" }], { permissionPolicy: () => ({ experimental: { thread_tools: true }, permission }) })
  h.mentioned.add("thread_A")
  const t = turn({ text: "@thread:thread_A", mode: () => "full" })
  await h.engine.runTurn(t.input)
  expect(t.asked).toHaveLength(0)
  expect(h.calls).toEqual([])
  permission = { threads: "allow" }
  const pending = fixture([{ action: "read" }], { permissionPolicy: () => ({ experimental: { thread_tools: true }, permission }) })
  const next = turn({ text: "read", mode: () => "ask" })
  next.input.ask = async () => { permission = { threads: "deny" }; return { kind: "approve", scope: "once" } }
  await pending.engine.runTurn(next.input)
  expect(pending.calls).toEqual([])
})

test("merge-back also requires consent because it reads a fork's transcript", async () => {
  const h = fixture([{ action: "merge_back" }])
  const t = turn({ text: "merge", mode: () => "ask", answers: [{ kind: "approve", scope: "once" }] })
  await h.engine.runTurn(t.input)
  expect(t.asked).toHaveLength(1)
  expect(h.calls).toEqual(["thread_A"])
})

test("disabling thread tools during approval prevents the local read", async () => {
  let enabled = true
  const h = fixture([{ action: "read" }], { permissionPolicy: () => ({ experimental: { thread_tools: enabled } }) })
  const t = turn({ text: "read", mode: () => "ask" })
  t.input.ask = async () => { enabled = false; return { kind: "approve", scope: "once" } }
  await h.engine.runTurn(t.input)
  expect(h.calls).toEqual([])
})

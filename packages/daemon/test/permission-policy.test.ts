import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createNativeEngine, memoryHistory, type ModelProvider } from "@mendcode/engine-native"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test("permissions control plane persists aliases, reviewer role and ordered settings across restarts", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b32-daemon-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    const client = createClient({ socketPath: daemon.socketPath, name: "b32" })
    cleanups.push(() => daemon.stop(), () => client.close())
    await client.connect()
    return { daemon, client }
  }
  const first = await boot()
  expect(await first.client.permissionsStatus()).toMatchObject({ ok: true, report: { mode: "approval", defaultPermission: "ask", reviewerRole: "permissionReviewer", continueLoopOnDeny: false } })
  expect(await first.client.permissionsSetDefault("full_access")).toMatchObject({ ok: true, result: { mode: "full_access", defaultPermission: "full" } })
  expect(await first.client.permissionsSetDefault("approval")).toMatchObject({ ok: true, result: { defaultPermission: "ask" } })
  expect(await first.client.permissionsSetDefault("smart")).toMatchObject({ ok: true })
  expect(await first.client.permissionsSetReviewerRole("small")).toMatchObject({ ok: true, result: { reviewerRole: "small" } })
  const permission = { "*": "ask", read: { "*": "allow", "*/private/*": "deny" } }
  expect(await first.client.send({ type: "settings.set", patch: { permission, tools: { webfetch: false }, experimental: { primary_tools: ["loop"], continue_loop_on_deny: true } } })).toMatchObject({ ok: true })
  expect(await first.client.send({ type: "settings.set", patch: { permission: { read: "maybe" } } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await first.client.send({ type: "permissions.set-reviewer-role", role: "unknown" as never })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  first.client.close()
  await first.daemon.stop()
  const second = await boot()
  const status = await second.client.permissionsStatus()
  expect(status).toMatchObject({ ok: true, report: { mode: "smart", reviewerRole: "small", permission, tools: { webfetch: false }, primaryTools: ["loop"], continueLoopOnDeny: true } })
  if (status.ok) expect(Object.keys(status.report.permission)).toEqual(["*", "read"])
  const session = await second.client.send({ type: "session.create", directory: dir })
  if (!session.ok) throw new Error("session failed")
  expect(second.daemon.store.permissionModeOf(session.result!.sessionId as never)).toBe("smart")
  expect(isReadOnlyCommand("permissions.status")).toBe(false)
  expect(isReadOnlyCommand("permissions.set-default")).toBe(false)
  expect(isReadOnlyCommand("permissions.set-reviewer-role")).toBe(false)
})

test("daemon settings enforce a native path deny in full mode without invoking the tool or asking", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b32-native-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let calls = 0, requests = 0
  const events: Array<{ type: string }> = []
  const provider: ModelProvider = {
    id: "local-fake", model: "local-fake",
    async *stream() {
      if (++requests === 1) yield { type: "tool_call", call: { callId: "read-private", name: "read", args: { path: "private.ts" } } }
      else yield { type: "text", delta: "denied; skipped" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "native.sock"), engine: ({ store }) => createNativeEngine({
    provider, history: memoryHistory(), system: () => "sys", compactionPrompt: "summarize", cwdFor: () => dir,
    permissionPolicy: () => store.settings.get(),
    tools: [defineTool({ name: "read", description: "read", permission: "read", args: z.object({ path: z.string() }), execute: async () => { calls++; return { output: "must not run", title: "read", isError: false, truncated: false } } })],
  }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "b32-native", onEvent: (event) => { events.push(event) } })
  cleanups.push(() => daemon.stop(), () => client.close())
  await client.connect()
  expect(await client.send({ type: "settings.set", patch: { defaultPermission: "full", permission: { read: { "*/private.ts": "deny" } } } })).toMatchObject({ ok: true })
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as import("@mendcode/protocol").SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "user.submit", sessionId, text: "read private.ts", attachments: [] })
  const deadline = Date.now() + 2_000
  while (!events.some((event) => event.type === "turn.completed")) {
    if (Date.now() > deadline) throw new Error("turn did not finish")
    await Bun.sleep(5)
  }
  expect(calls).toBe(0)
  expect(requests).toBe(2)
  expect(events.some((event) => event.type === "server.request")).toBe(false)
})

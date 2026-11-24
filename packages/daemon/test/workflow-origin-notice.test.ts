import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createWorkflowsHost } from "../src/workflows"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function host(exitCode: number) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-notice-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ids = createIdFactory()
  const store = openStore({ dir })
  cleanups.push(() => store.close())
  const notices: Array<{ sessionId: SessionId; text: string }> = []
  const workflows = createWorkflowsHost({
    store: store.workflows, definitions: store.workflowDefinitions,
    clock: { now: () => Date.now(), setTimer: (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) } } },
    ids, layersFor: () => [], defaultPermission: () => "full",
    createSession(input) { const id = ids("session"); store.createSession({ ...input, id }); return id },
    submit: async () => ({ queueId: ids("queue") }), cancelTurn: () => {}, deleteSession: () => true,
    runCheck: async () => ({ exitCode, output: "device not found" }), fingerprint: async () => "x", emit: () => {},
    notifyOrigin: (sessionId, text) => void notices.push({ sessionId, text }),
  })
  cleanups.push(() => workflows.dispose())
  const origin = ids("session")
  store.createSession({ id: origin, directory: dir, title: "origin" })
  return { workflows, notices, origin, dir }
}

const plan = { name: "probe", objective: "run one check", tasks: [{ kind: "check" as const, id: "probe-check", title: "Probe", command: "bun test", needs: [] }] }

describe("the session that started a workflow hears how it ended", () => {
  test("a failed run tells its origin the failed task", async () => {
    const { workflows, notices, origin, dir } = host(1)
    const started = await workflows.handle({ type: "workflow.start", directory: dir, plan, originSessionId: origin })
    expect(started).toMatchObject({ ok: true })
    await until(() => notices.length > 0)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.sessionId).toBe(origin)
    expect(notices[0]!.text).toContain("failed")
    expect(notices[0]!.text).toContain("probe-check")
  })

  test("a completed run tells its origin once", async () => {
    const { workflows, notices, origin, dir } = host(0)
    await workflows.handle({ type: "workflow.start", directory: dir, plan, originSessionId: origin })
    await until(() => notices.length > 0)
    await new Promise((r) => setTimeout(r, 100))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain("completed")
  })

  test("a run the user started has no origin to tell", async () => {
    const { workflows, notices, dir } = host(1)
    await workflows.handle({ type: "workflow.start", directory: dir, plan })
    await new Promise((r) => setTimeout(r, 300))
    expect(notices).toHaveLength(0)
  })
})

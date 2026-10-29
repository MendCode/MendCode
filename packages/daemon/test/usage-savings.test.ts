import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, UsageReport } from "@mendcode/protocol"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const ids = createIdFactory()

test("usage.query carries the tokens output filters saved, globally and per project", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-savings-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, "repo"), other = path.join(dir, "other")
  for (const folder of [path.join(repo, ".git"), path.join(other, ".git")]) mkdirSync(folder, { recursive: true })
  const now = Date.UTC(2026, 8, 30, 12)
  const daemon = await startDaemon({ dir: path.join(dir, "data"), socketPath: path.join(dir, "u.sock"), defaultDirectory: repo, clock: { now: () => now, setTimer: (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) } } },
    engine: ({ store, clock }) => {
      for (const [directory, meta] of [[repo, { savedTokens: 900, filter: "tests" }], [repo, { savedTokens: 100, filter: "git" }], [other, { savedTokens: 4000, filter: "search" }]] as const) {
        const sessionId = ids("session"), turnId = ids("turn"), itemId = ids("item")
        store.createSession({ id: sessionId, directory, title: directory })
        store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: "shell: run" } })
        store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", meta })
      }
      return createFauxEngine({ clock, deltaMs: 1 })
    },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "usage-savings", reconnect: false })
  cleanups.push(() => client.close())
  await client.connect()
  const range = { from: "2026-09-30", to: "2026-09-30" }
  const query = async (extra: Record<string, unknown>) => {
    const reply = await client.send({ type: "usage.query", ...range, ...extra } as never)
    expect(reply.ok).toBe(true)
    const parsed = UsageReport.safeParse(reply.ok ? reply.result : undefined)
    expect(parsed.success).toBe(true)
    return parsed.success ? parsed.data : undefined
  }
  expect((await query({ scope: "global" }))?.savings).toEqual([{ source: "search", calls: 1, tokens: 4000 }, { source: "tests", calls: 1, tokens: 900 }, { source: "git", calls: 1, tokens: 100 }])
  expect((await query({ scope: "project", directory: repo }))?.savings).toEqual([{ source: "tests", calls: 1, tokens: 900 }, { source: "git", calls: 1, tokens: 100 }])
})

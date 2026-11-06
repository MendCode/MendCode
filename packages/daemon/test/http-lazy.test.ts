import { afterEach, expect, test } from "bun:test"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { readRestArchives } from "../src/session-rest-archives"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); cleanTemps() })
const loaded = (name: string) => Object.keys(require.cache).some((file) => file.endsWith(`/packages/daemon/src/${name}.ts`))

test("idle daemon and worktree port construction leave HTTP/REST unloaded; concurrent first commands share state", async () => {
  // Other test files import HTTP directly; inspect a fresh process even in a grouped test run.
  if (process.env.MENDCODE_TEST_HTTP_LAZY_CHILD !== "1") {
    const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "--test-name-pattern", "idle daemon and worktree port"], {
      env: { ...process.env, MENDCODE_TEST_HTTP_LAZY_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    return
  }
  const dir = realpathSync(tempDir()), project = realpathSync(tempDir())
  const ids = createIdFactory(), first = ids("session"), second = ids("session")
  const archives = path.join(dir, "session-rest.json")
  writeFileSync(archives, JSON.stringify({ [first]: 7 }))
  const daemon = await startDaemon({ dir, defaultDirectory: project, socketPath: path.join(dir, "mendd.sock"), extensionsEnabled: false, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanup.push(() => daemon.stop())
  daemon.store.createSession({ id: first, directory: project, title: "First" })
  daemon.store.createSession({ id: second, directory: project, title: "Second" })
  const client = createClient({ socketPath: daemon.socketPath, name: "http-lazy" })
  await client.connect()
  cleanup.push(() => client.close())
  expect(daemon.httpAdapter).toBeUndefined()
  expect(daemon.worktreePort(first).status()).toContain(project)
  const deferred = ["http", "http-sessions", "http-web", "http-web-editor", "http-web-terminal", "http-web-workspaces", "project-rest", "session-rest", "session-rest-diff", "session-rest-usage", "session-rest-mutate"]
  expect(deferred.filter(loaded)).toEqual([])

  // First use must keep the validated startup snapshot, not reread an outside edit.
  writeFileSync(archives, "{}")
  const initial = await Promise.all([
    client.restSessions(project, { operation: "get", sessionId: first }),
    client.updateRestSession(second, { time: { archived: 9 } }),
  ])
  expect(initial[0]).toMatchObject({ ok: true, result: { value: { time: { archived: 7 } } } })
  expect(initial[1]).toMatchObject({ ok: true, result: { value: { time: { archived: 9 } } } })
  expect(JSON.parse(readFileSync(archives, "utf8"))).toEqual({ [first]: 7, [second]: 9 })
  expect(loaded("session-rest")).toBe(true)
  expect(loaded("session-rest-mutate")).toBe(false)
  expect(await client.send({ type: "session.rest.mutate", sessionId: first, operation: "delete-message", messageId: ids("item") })).toMatchObject({ ok: false })
  expect(loaded("session-rest-mutate")).toBe(true)
  expect(await client.send({ type: "session.cd", sessionId: first, path: project })).toMatchObject({ ok: true })
  expect(loaded("project-rest")).toBe(true)
  expect(deferred.filter((name) => name.startsWith("http")).filter(loaded)).toEqual([])
})

test("archive validation remains eager and rejects the same invalid persisted values", () => {
  const dir = tempDir(), file = path.join(dir, "session-rest.json")
  expect(readRestArchives(dir)).toEqual({})
  for (const value of [null, [], { session: -1 }, { session: 1.5 }, { session: "1" }]) {
    writeFileSync(file, JSON.stringify(value))
    expect(() => readRestArchives(dir)).toThrow("invalid session-rest.json")
  }
  writeFileSync(file, JSON.stringify({ session: 1 }))
  expect(readRestArchives(dir)).toEqual({ session: 1 })
})

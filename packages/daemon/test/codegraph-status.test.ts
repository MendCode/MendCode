import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { CODEGRAPH_STATUS_LIMIT, createCodegraphStatus } from "../src/codegraph-status"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const counts = { files: 2594, symbols: 17641, edges: 40_000, partial: false }
const flush = () => new Promise((resolve) => setTimeout(resolve, 30))

describe("the code graph status hub", () => {
  test("it keeps the last counts per directory, drops a build that ended without a graph, and bounds its memory", () => {
    const hub = createCodegraphStatus()
    hub.publish({ cwd: "/a", state: "indexing", ...counts })
    hub.publish({ cwd: "/a", state: "indexed", ...counts })
    hub.publish({ cwd: "/b", state: "indexing", ...counts })
    hub.publish({ cwd: "/b", state: "none", files: 0, symbols: 0, edges: 0, partial: false })
    expect(hub.snapshot()).toEqual([{ directory: "/a", state: "indexed", ...counts }])
    for (let i = 0; i < CODEGRAPH_STATUS_LIMIT + 10; i++) hub.publish({ cwd: `/p${i}`, state: "indexed", ...counts })
    expect(hub.snapshot()).toHaveLength(CODEGRAPH_STATUS_LIMIT)
    expect(hub.snapshot().some((status) => status.directory === "/a")).toBe(false)
  })
})

describe("codegraph.status reaches the footer's terminal", () => {
  async function boot() {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-cgstatus-")))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const hub = createCodegraphStatus()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", codegraphStatus: hub, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const connect = async (name: string, remote?: string) => {
      const events: any[] = []
      const client = createClient({ ...(remote ? { name, remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token: remote } } : { socketPath: daemon.socketPath, name }), onGlobal: (event) => { if ((event as { type: string }).type === "codegraph.status") events.push(event) } })
      await client.connect()
      cleanups.push(() => client.close())
      return events
    }
    return { dir, hub, daemon, connect }
  }

  test("a connected terminal gets the counts when the index changes, and a terminal that connects later gets the last ones", async () => {
    const h = await boot()
    const early = await h.connect("early")
    h.hub.publish({ cwd: "/work/app", state: "indexing", files: 0, symbols: 0, edges: 0, partial: false })
    h.hub.publish({ cwd: "/work/app", state: "indexed", ...counts })
    await flush()
    expect(early.map((event) => event.state)).toEqual(["indexing", "indexed"])
    expect(early[1]).toMatchObject({ type: "codegraph.status", gseq: 0, directory: "/work/app", ...counts })
    const late = await h.connect("late")
    await flush()
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({ directory: "/work/app", state: "indexed", files: 2594 })
  })

  test("nothing is sent to a remote peer", async () => {
    const h = await boot()
    const token = remoteTokens(h.dir).create({ name: "phone", readOnly: false }).token
    const remote = await h.connect("phone", token)
    h.hub.publish({ cwd: "/work/app", state: "indexed", ...counts })
    await flush()
    expect(remote).toEqual([])
  })
})

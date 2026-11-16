import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { EnginePort } from "@mendcode/kernel"
import type { ModelInfo, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const NATIVE: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: [] }]
const LOCAL_ONLY: ModelInfo[] = [{ id: "acp:fake", name: "fake · ACP", efforts: [] }, { id: "pi:local", name: "pi", efforts: [], engine: "pi" } as ModelInfo]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

test("a remote peer cannot reach a local-only engine through an agent whose model is one", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-agent-remote-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-agent-remote-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "agents"))
  writeFileSync(path.join(dir, "agents", "viaacp.md"), "---\ndescription: Runs on an ACP agent\nmode: primary\nmodel: acp:fake\n---\nWork.")
  writeFileSync(path.join(dir, "agents", "viapi.md"), "---\ndescription: Runs on pi\nmode: primary\nmodel: pi:local\n---\nWork.")
  let ran = 0
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    listen: "127.0.0.1:0",
    log: () => {},
    info: { engine: "native", model: "gpt-6-luna" },
    models: { selectable: true, defaults: { model: "gpt-6-luna" }, list: () => [...NATIVE, ...LOCAL_ONLY] },
    engine: () => ({ async runTurn() { ran += 1; return { status: "ok" } }, needsCompaction: () => false, compact: async () => ({ status: "ok" }) }) as EnginePort,
  })
  cleanups.push(() => daemon.stop())
  const local = createClient({ socketPath: daemon.socketPath, name: "local", reconnect: false })
  await local.connect()
  cleanups.push(() => local.close())
  const token = remoteTokens(dir).create({ name: "peer" }).token
  const remote = createClient({ name: "peer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token }, reconnect: false })
  await remote.connect()
  cleanups.push(() => remote.close())
  const created = await local.send({ type: "session.create", directory: project, choice: { model: "gpt-6-luna" } })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  for (const agent of ["viaacp", "viapi"]) {
    const refused = await remote.send({ type: "user.submit", sessionId, text: "go", attachments: [], selection: { agent } })
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } })
  }
  expect(ran).toBe(0)
})

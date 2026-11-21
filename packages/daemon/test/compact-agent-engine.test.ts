import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { EnginePort } from "@mendcode/kernel"
import type { ModelInfo, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"

const MODELS: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: [] }, { id: "claude:opus", name: "Opus", efforts: [], engine: "claude" } as ModelInfo]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

test("compacting a session whose agent runs on another engine names the agent's model, so the router picks that engine", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-compact-agent-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-compact-agent-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "agents"))
  writeFileSync(path.join(dir, "agents", "helper.md"), "---\ndescription: Runs on the other engine\nmode: primary\nmodel: claude:opus\n---\nWork.")
  const compacted: Array<string | undefined> = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    info: { engine: "native", model: "gpt-6-luna" },
    models: { selectable: true, defaults: { model: "gpt-6-luna" }, list: () => MODELS },
    engine: () => ({ async runTurn() { return { status: "ok" } }, needsCompaction: () => false, compact: async (input) => { compacted.push(input.selection?.model?.model); return { status: "ok" } } }) as EnginePort,
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "local", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: project, agent: "helper", choice: { model: "gpt-6-luna" } })
  if (!created.ok) throw new Error("session failed")
  const sessionId = created.result!.sessionId as SessionId
  await client.send({ type: "session.compact", sessionId })
  const deadline = Date.now() + 5000
  while (!compacted.length && Date.now() < deadline) await Bun.sleep(20)
  expect(compacted).toEqual(["claude:opus"])
})

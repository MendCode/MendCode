import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, LedgerPage, LedgerExport, type WorkflowId } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"

const ids = createIdFactory()
const commands = ["workflow.events", "workflow.artifacts", "workflow.receipt", "workflow.export", "loop.events", "loop.artifacts", "loop.receipt", "loop.export"] as const

test("ledger commands validate cursor, run and limit; content never gets read-only remote access", () => {
  for (const type of commands) {
    const target = type.startsWith("workflow") ? { workflowId: ids("workflow") } : { loopId: ids("loop") }
    const command = { id: ids("command"), clientId: ids("client"), type, ...target }
    expect(Command.safeParse({ ...command, before: 10, run: 0, limit: 100 }).success).toBe(true)
    for (const patch of [{ before: 0 }, { run: -1 }, { limit: 101 }, { limit: 1.5 }, { format: "html" }]) expect(Command.safeParse({ ...command, ...patch }).success).toBe(false)
    expect(isReadOnlyCommand(type)).toBe(false)
  }
})

test("local daemon records actual workflow transitions and typed client queries/export are bounded", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "b69-daemon-"))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "b69-test" })
  try {
    await client.connect()
    const start = await client.send({ type: "workflow.start", directory: dir, plan: { name: "Evidence", objective: "Record a local fake completion", tasks: [{ kind: "agent", id: "local", title: "Local task", prompt: "say hi", mode: "read", needs: [] }] } })
    expect(start.ok).toBe(true)
    if (!start.ok) throw new Error(start.error.message)
    const workflowId = (start.result?.workflow as { workflowId: WorkflowId }).workflowId
    let ledger = await client.automationLedger("workflow", workflowId, "receipt")
    const deadline = Date.now() + 2_000
    while (ledger.ok && ledger.ledger.entries[0]?.data.state !== "completed" && Date.now() < deadline) {
      await Bun.sleep(5)
      ledger = await client.automationLedger("workflow", workflowId, "receipt")
    }
    expect(ledger.ok && ledger.ledger.entries[0]?.data.state).toBe("completed")
    expect(ledger.ok && ledger.ledger.entries[0]?.data.verified).toBe(false)
    const events = await client.automationLedger("workflow", workflowId, "events", { limit: 2 })
    expect(events.ok && LedgerPage.safeParse(events.ledger).success).toBe(true)
    expect(events.ok && events.ledger.entries.length).toBe(2)
    if (!events.ok || !events.ledger.nextBefore) throw new Error("missing page cursor")
    const older = await client.automationLedger("workflow", workflowId, "events", { before: events.ledger.nextBefore })
    expect(older.ok && older.ledger.entries[0]!.sequence).toBeLessThan(events.ledger.entries.at(-1)!.sequence)
    const artifacts = await client.automationLedger("workflow", workflowId, "artifacts")
    expect(artifacts.ok && artifacts.ledger.entries.some((entry) => entry.kind === "task-result")).toBe(true)
    const json = await client.exportAutomation("workflow", workflowId)
    expect(json.ok && LedgerExport.safeParse(json.export).success).toBe(true)
    expect(json.ok && JSON.parse(json.export.text).schema).toBe("mendcode.automation-ledger.v1")
    const markdown = await client.exportAutomation("workflow", workflowId, "markdown")
    expect(markdown.ok && markdown.export.text).toContain("# workflow")
    const unknown = await client.automationLedger("workflow", ids("workflow"), "events")
    expect(unknown).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  } finally {
    client.close()
    await daemon.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type DreamRun, type MemoryEntry } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { consolidateMemory } from "../src/memory-consolidation"
import { createSemanticConsolidator, parseConsolidatorOutput, type ConsolidatorDecision } from "../src/memory-consolidator"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const ids = createIdFactory()
const memory = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", category: "commands", source: "agent", status: "pending", createdAt: 0, updatedAt: 0, text, details: { confidence: .95, durability: .9, changeRisk: .1 }, ...patch })

function harness(initial: MemoryEntry[]) {
  let entries = initial
  const applied: string[] = []
  return { entries: () => entries, applied,
    archive: (item: MemoryEntry) => { entries = entries.map((entry) => entry.memoryId === item.memoryId ? { ...entry, status: "archived" } : entry) },
    apply: async (item: MemoryEntry) => { applied.push(item.text); entries = entries.map((entry) => entry.memoryId === item.memoryId ? { ...entry, status: "saved" } : entry) },
  }
}
const advice = (...decisions: ConsolidatorDecision[]) => ({ decide: async () => ({ decisions: new Map(decisions.map((decision) => [decision.memoryId, decision])) }) })

describe("R4 semantic consolidator", () => {
  test("the parser keeps only well-formed decisions for ids of its own batch and redacts reasons", () => {
    const out = parseConsolidatorOutput('```json\n{"decisions":[{"memoryId":"a","resolution":"apply","reason":"ok sk-abcdEFGH1234ijklMNOP5678","confidence":7},{"memoryId":"a","resolution":"archive","reason":"repeat"},{"memoryId":"zzz","resolution":"apply","reason":"foreign"},{"memoryId":"b","resolution":"delete-all","reason":"bad"},{"memoryId":"b","resolution":"keep"}]}\n```', new Set(["a", "b"]))
    expect([...out.keys()]).toEqual(["a"])
    expect(out.get("a")).toMatchObject({ resolution: "apply", confidence: 1 })
    expect(out.get("a")?.reason).not.toContain("sk-abcd")
    expect(parseConsolidatorOutput("not json", new Set(["a"])).size).toBe(0)
  })
  test("a refused call, a provider error and an empty reply each fall back to the host gates", async () => {
    const one = [memory("x")]
    expect(await createSemanticConsolidator({ call: async () => ({ refused: "budget gone" }) }).decide({ proposals: one, saved: [], batchIndex: 0, batchCount: 1 })).toEqual({ fallback: "budget gone" })
    expect(await createSemanticConsolidator({ call: async () => { throw new Error("provider down") } }).decide({ proposals: one, saved: [], batchIndex: 0, batchCount: 1 })).toEqual({ fallback: "provider down" })
    expect(await createSemanticConsolidator({ call: async () => ({ text: "{}" }) }).decide({ proposals: one, saved: [], batchIndex: 0, batchCount: 1 })).toEqual({ fallback: "Consolidator returned no usable decisions" })
  })
  test("the model can archive, keep and merge, while its scores only tighten the host gates", async () => {
    const saved = memory("Stored command", { status: "saved" })
    const noisy = memory("Run the noisy thing")
    const doubt = memory("Ask someone first")
    const first = memory("Deploy with pnpm release")
    const second = memory("Deploy using pnpm release script")
    const cautious = memory("Lint before commit")
    const loosened = memory("Low durability", { details: { confidence: .95, durability: .2, changeRisk: .1 } })
    const h = harness([saved, noisy, doubt, first, second, cautious, loosened])
    const semantic = advice(
      { memoryId: noisy.memoryId, resolution: "archive", reason: "transient" },
      { memoryId: doubt.memoryId, resolution: "keep", reason: "needs a person" },
      { memoryId: first.memoryId, resolution: "apply", reason: "durable" },
      { memoryId: second.memoryId, resolution: "merge", canonicalId: first.memoryId, reason: "same as the first" },
      { memoryId: cautious.memoryId, resolution: "apply", reason: "fine", changeRisk: .8 },
      { memoryId: loosened.memoryId, resolution: "apply", reason: "model says durable", durability: 1 },
    )
    const report = await consolidateMemory({ ...h, policy: "auto-consolidate", limit: 50, semantic })
    expect(report).toMatchObject({ mode: "semantic", applied: 1, archived: 4, pendingAfter: 1 })
    const by = (id: string) => report.decisions.find((decision) => decision.memoryId === id)
    expect(by(noisy.memoryId)).toMatchObject({ outcome: "archived", by: "model", reason: "Model: transient" })
    expect(by(doubt.memoryId)).toMatchObject({ outcome: "kept", by: "model" })
    expect(by(first.memoryId)).toMatchObject({ outcome: "applied" })
    expect(by(second.memoryId)).toMatchObject({ outcome: "archived", canonicalId: first.memoryId })
    expect(by(cautious.memoryId)).toMatchObject({ outcome: "archived", by: "host", reason: "Change risk above .2" })
    expect(by(loosened.memoryId)).toMatchObject({ outcome: "archived", by: "host", reason: "Durability below .85" })
    expect(h.applied).toEqual(["Deploy with pnpm release"])
    expect(h.entries().find((entry) => entry.memoryId === doubt.memoryId)?.status).toBe("pending")
  })
  test("a merge into an unknown or rejected canonical stays pending; preview changes nothing", async () => {
    const a = memory("Alpha procedure for builds")
    const b = memory("Beta procedure for tests")
    const c = memory("Gamma convention names", { category: "conventions" })
    const h = harness([a, b, c])
    const semantic = advice(
      { memoryId: a.memoryId, resolution: "merge", canonicalId: "made-up", reason: "dup" },
      { memoryId: b.memoryId, resolution: "reject", reason: "noise" },
      { memoryId: c.memoryId, resolution: "supersede", canonicalId: b.memoryId, reason: "same as noise" },
    )
    const preview = await consolidateMemory({ ...h, policy: "preview", limit: 50, semantic })
    expect(preview).toMatchObject({ applied: 0, archived: 0, pendingAfter: 3 })
    expect(preview.decisions.every((decision) => decision.outcome === "preview")).toBe(true)
    const run = await consolidateMemory({ ...h, policy: "auto-consolidate", limit: 50, semantic })
    expect(run.decisions.find((decision) => decision.memoryId === a.memoryId)).toMatchObject({ outcome: "kept" })
    expect(run.decisions.find((decision) => decision.memoryId === c.memoryId)).toMatchObject({ outcome: "kept" })
    expect(run).toMatchObject({ archived: 1, applied: 0, pendingAfter: 2 })
  })
  test("a fallback batch is decided by the host gates alone and reported", async () => {
    const h = harness([memory("Use pnpm to install")])
    const report = await consolidateMemory({ ...h, policy: "auto-consolidate", limit: 50, semantic: { decide: async () => ({ fallback: "budget gone" }) } })
    expect(report).toMatchObject({ mode: "semantic", fallback: "budget gone", applied: 1 })
    expect(report.decisions[0]).toMatchObject({ outcome: "applied", by: "host" })
  })
})

describe("R4 Dream consolidator role", () => {
  async function boot(calls: Array<{ prompt: string; model?: string }>, reply: (prompt: string) => string, roles: boolean) {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-r4-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
      models: { selectable: true, defaults: { model: "main-fake" }, list: () => ["main-fake", "judge-fake"].map((id) => ({ id, name: id, provider: "local", efforts: [] })) },
      dream: { complete: async (prompt, _signal, model) => { calls.push({ prompt, ...(model ? { model: model.model } : {}) }); return reply(prompt) } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "R4" })
    await client.connect()
    cleanup.push(() => client.close())
    if (roles) await client.send({ type: "settings.set", patch: { models: { memoryConsolidator: { model: "judge-fake" } } } })
    return { daemon, client }
  }
  const seed = (daemon: Awaited<ReturnType<typeof boot>>["daemon"], text: string) => {
    const memoryId = ids("memory")
    daemon.store.memories.add({ memoryId, scope: "project", directory: "/repo", text, source: "agent", status: "pending", category: "commands", details: { confidence: .95, durability: .95, changeRisk: .1 } })
    return memoryId
  }
  test("with the role configured the configured model decides and usage is reported; without it no call is made", async () => {
    const calls: Array<{ prompt: string; model?: string }> = []
    const h = await boot(calls, (prompt) => prompt.includes("<dream_consolidation_context>") ? JSON.stringify({ decisions: [...prompt.matchAll(/"memoryId":"([^"]+)","scope":"project","category"/g)].map((match) => ({ memoryId: match[1], resolution: "archive", reason: "stale" })) }) : "{}", true)
    const id = seed(h.daemon, "Release with pnpm release")
    const status = await h.client.dreamControl("/repo", { operation: "status" })
    expect(status.ok && status.result).toMatchObject({ consolidator: { mode: "semantic", model: "judge-fake" } })
    const denied = await h.client.dreamControl("/repo", { operation: "consolidate", policy: "auto-consolidate", deterministic: true })
    expect(denied.ok && denied.result).toMatchObject({ consolidation: { mode: "deterministic", applied: 1 } })
    expect(calls).toHaveLength(0)
    const again = seed(h.daemon, "Another command to run")
    const run = await h.client.dreamControl("/repo", { operation: "consolidate", policy: "auto-consolidate" })
    if (!run.ok) throw new Error(run.error.message)
    expect(run.result).toMatchObject({ callsProviders: true, consolidation: { mode: "semantic", archived: 1, semantic: { model: "judge-fake", calls: 1 } } })
    expect(calls).toEqual([{ prompt: expect.stringContaining(again), model: "judge-fake" }])
    expect(h.daemon.store.memories.get(id)?.status).toBe("saved")
    expect(h.daemon.store.memories.get(again)?.status).toBe("archived")
    expect((h.daemon.store.dreamRuns.list("/repo")[0] as DreamRun).notes).toContain("(semantic)")
  })
  test("an unconfigured role keeps v1's deterministic default and never calls a model", async () => {
    const calls: Array<{ prompt: string }> = []
    const h = await boot(calls, () => "{}", false)
    const id = seed(h.daemon, "Release with pnpm release")
    const run = await h.client.dreamControl("/repo", { operation: "consolidate", policy: "auto-consolidate" })
    expect(run.ok && run.result).toMatchObject({ callsProviders: false, consolidation: { mode: "deterministic", applied: 1 } })
    expect(calls).toHaveLength(0)
    expect(h.daemon.store.memories.get(id)?.status).toBe("saved")
  })
})

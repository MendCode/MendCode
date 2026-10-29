import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { openStore } from "@mendcode/store"
import { Command, createIdFactory, type EvolutionSuggestion } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { createEvolutionPromotions } from "../src/evolution-promotion"
import { readWorkflowPlans } from "../src/workflow-files"
import { startDaemon } from "../src"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "b46-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const plan = {
  name: "Survey tests", objective: "Report the checks used by this project", permission: "ask",
  tasks: [{ kind: "agent", id: "survey", title: "Survey", prompt: "Read test scripts and report gaps", mode: "read", needs: [] }],
  contract: { criteria: [{ id: "evidence", text: "Report cites inspected scripts", owners: ["survey"] }], checks: [], audit: "independent" },
}

function fixture() {
  const dir = temp(), project = temp()
  const store = openStore({ dir })
  let closed = false
  const close = () => { if (!closed) { store.close(); closed = true } }
  cleanups.push(close)
  store.settings.set({ evolution: "suggest", evolutionWorkflows: true })
  const promotion = createEvolutionPromotions({ store, dir, now: () => 1_800_000_000_000 })
  const candidate = (kind: "skill" | "workflow" = "workflow", name = "survey-tests", content = kind === "workflow" ? JSON.stringify(plan) : "Read tests before changing code.") => store.evolution.suggest({ directory: project, kind, name, description: "Read tests before edits", content, evidence: 1 })!
  const promote = (suggestion: EvolutionSuggestion) => promotion.promote(suggestion.suggestionId, suggestion.hash!, store.evolution.policyRevision())
  return { dir, project, store, promotion, candidate, promote, close }
}

describe("reversible Evolution promotions", () => {
  test("skill and workflow receipts persist; rollback retires exact bytes even after off", () => {
    const h = fixture()
    for (const kind of ["skill", "workflow"] as const) {
      const candidate = h.candidate(kind)
      const promoted = h.promote(candidate)
      expect(promoted.suggestion).toMatchObject({ status: "accepted", hash: candidate.hash, receipt: { kind, target: promoted.path, revision: 1 } })
      const content = readFileSync(promoted.path, "utf8")
      if (kind === "workflow") {
        const loaded = readWorkflowPlans([{ source: "project", dir: path.join(h.project, ".mendcode") }])
        expect(loaded).toMatchObject([{ name: "evo-survey-tests-" + candidate.suggestionId, plan: { permission: "ask", tasks: [{ mode: "read" }], contract: { audit: "independent" } } }])
      } else expect(content).toBe("---\nname: survey-tests\ndescription: Read tests before edits\n---\n\nRead tests before changing code.\n")
      h.store.settings.set({ evolution: "off" })
      const rolled = h.promotion.rollback(candidate.suggestionId, candidate.hash!, 1).suggestion
      expect(rolled).toMatchObject({ status: "rolled_back", receipt: { revision: 2, rolledBackAt: 1_800_000_000_000 } })
      expect(existsSync(promoted.path)).toBe(false)
      expect(readFileSync(rolled.receipt!.archive!, "utf8")).toBe(content)
      expect(() => h.promotion.rollback(candidate.suggestionId, candidate.hash!, 1)).toThrow("revision")
      h.store.settings.set({ evolution: "suggest" })
    }
    h.close()
    const reopened = openStore({ dir: h.dir })
    expect(reopened.evolution.suggestions(h.project).map((item) => [item.status, item.receipt?.revision])).toEqual([["rolled_back", 2], ["rolled_back", 2]])
    reopened.close()
  })

  test("no overwrite, symlink escape, path traversal, unapproved workflow or changed artifact", () => {
    const h = fixture()
    const skill = h.candidate("skill")
    const file = path.join(h.project, ".mendcode", "skills", skill.name, "SKILL.md")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "User's skill")
    expect(() => h.promote(skill)).toThrow("exists")
    expect(h.store.evolution.suggestion(skill.suggestionId)?.status).toBe("pending")
    expect(readFileSync(file, "utf8")).toBe("User's skill")
    expect(() => h.promote(h.candidate("skill", "../escape"))).toThrow()
    const outside = temp()
    symlinkSync(outside, path.join(h.project, ".mendcode", "workflows"))
    expect(() => h.promote(h.candidate())).toThrow("symlink")
    expect(readdirSync(outside)).toEqual([])
    const unsafe = h.candidate("workflow", "unsafe-plan", JSON.stringify({ ...plan, permission: "full" }))
    expect(() => h.promote(unsafe)).toThrow("read tasks")
    h.store.settings.set({ evolutionWorkflows: false })
    const disabled = h.candidate("workflow", "disabled-plan")
    expect(() => h.promote(disabled)).toThrow("disabled")
    const changed = h.promote(h.candidate("skill", "change-check"))
    writeFileSync(changed.path, "A manual revision")
    expect(() => h.promotion.rollback(changed.suggestion.suggestionId, changed.suggestion.hash!, 1)).toThrow("changed")
    expect(readFileSync(changed.path, "utf8")).toBe("A manual revision")
    expect(h.store.evolution.suggestion(changed.suggestion.suggestionId)?.receipt?.revision).toBe(1)
  })

  test("review hashes and policy revisions reject stale work, including off/on and restart", () => {
    const h = fixture(), candidate = h.candidate()
    const revision = h.store.evolution.policyRevision()
    expect(() => h.promotion.promote(candidate.suggestionId, "0".repeat(64), revision)).toThrow("Candidate changed")
    h.store.settings.set({ evolution: "off" })
    expect(() => h.promote(candidate)).toThrow("requires")
    h.store.settings.set({ evolution: "suggest" })
    expect(h.store.evolution.policyRevision()).not.toBe(revision)
    expect(() => h.promote(candidate)).toThrow("policy changed")
    expect(existsSync(path.join(h.project, ".mendcode"))).toBe(false)
    const current = h.store.evolution.policyRevision()
    h.store.settings.set({ dreamMaxTokens: 80_000 })
    expect(h.store.evolution.policyRevision()).toBe(current)
    h.close()
    const reopened = openStore({ dir: h.dir })
    expect(reopened.evolution.policyRevision()).toBe(current)
    reopened.close()
  })

  test("write-ahead receipts recover before publication and after an interrupted retirement", () => {
    const h = fixture(), candidate = h.candidate("skill")
    const promoted = h.promote(candidate)
    h.store.evolution.promotion(candidate.suggestionId, "blocked", promoted.suggestion.receipt!)
    const archive = path.join(h.dir, "evolution", "retired", candidate.suggestionId + "-" + promoted.suggestion.receipt!.hash.slice(0, 16), "SKILL.md")
    mkdirSync(path.dirname(archive), { recursive: true })
    renameSync(promoted.path, archive)
    expect(h.promotion.rollback(candidate.suggestionId, candidate.hash!, 1).suggestion).toMatchObject({ status: "rolled_back", receipt: { archive, revision: 2 } })
    const unwritten = h.candidate("skill", "unwritten")
    const target = path.join(h.project, ".mendcode", "skills", "unwritten", "SKILL.md")
    mkdirSync(path.dirname(target), { recursive: true })
    h.store.evolution.promotion(unwritten.suggestionId, "blocked", { kind: "skill", target, hash: "a".repeat(64), revision: 1, promotedAt: 0 })
    expect(h.promotion.rollback(unwritten.suggestionId, unwritten.hash!, 1).suggestion).toMatchObject({ status: "rolled_back", receipt: { revision: 2 } })
    expect(existsSync(target)).toBe(false)
  })

  test("receipts stay bounded without dropping old active promotions", () => {
    const h = fixture()
    for (let i = 0; i < 200; i++) {
      const candidate = h.candidate("skill", "candidate-" + i)
      expect(candidate).toBeDefined()
      h.store.evolution.resolve(candidate.suggestionId, "rejected")
    }
    expect(h.candidate("skill", "over-capacity")).toBeUndefined()
  })

  test("commands validate hashes/revisions and stay unavailable to read-only remote tokens", () => {
    const ids = createIdFactory(), base = { id: ids("command"), clientId: ids("client"), suggestionId: 1, expectedHash: "a".repeat(64) }
    expect(Command.safeParse({ ...base, type: "evolution.promote", policyRevision: "revision" }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "evolution.rollback", expectedRevision: 1 }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "evolution.promote" }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "evolution.rollback", expectedRevision: 0 }).success).toBe(false)
    expect(isReadOnlyCommand("evolution.promote")).toBe(false)
    expect(isReadOnlyCommand("evolution.rollback")).toBe(false)
  })

  test("Dream → protocol/client → project definition → rollback with local fakes", async () => {
    const dir = temp(), project = temp()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), dream: { complete: async (prompt) => prompt.includes("## Evidence") ? JSON.stringify({ candidates: [{ kind: "workflow", name: "survey-tests", description: "Review checks", content: JSON.stringify(plan), evidence: ["e1"] }] }) : '{"proposals":[]}' } })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "B46", reconnect: false })
    cleanups.push(() => client.close())
    await client.connect()
    expect(await client.send({ type: "settings.set", patch: { evolution: "suggest", evolutionWorkflows: true } })).toMatchObject({ ok: true })
    const ids = createIdFactory()
    for (let i = 0; i < 2; i++) {
      const sessionId = ids("session")
      daemon.store.createSession({ id: sessionId, directory: project, title: "Test survey" })
      daemon.store.sessionSink.append({ type: "item.started", sessionId, turnId: ids("turn"), itemId: ids("item"), kind: "user_message" })
      const item = daemon.store.readAfter(sessionId, 0).find((event) => event.type === "item.started")!
      if (item.type !== "item.started") throw new Error("Missing item")
      daemon.store.sessionSink.append({ type: "item.completed", sessionId, itemId: item.itemId, status: "ok", text: "Actually read the test scripts before editing the code" })
    }
    expect(await client.send({ type: "dream.run", directory: project })).toMatchObject({ ok: true })
    const started = Date.now()
    while (daemon.store.dreamRuns.list(project)[0]?.status === "running") {
      if (Date.now() - started > 2_000) throw new Error("Dream fake did not complete")
      await Bun.sleep(5)
    }
    expect(daemon.store.dreamRuns.list(project)[0]?.report?.evolution?.suggested.workflows).toBe(1)
    const listed = await client.send({ type: "evolution.list", directory: project })
    if (!listed.ok) throw new Error(listed.error.message)
    const candidate = (listed.result?.suggestions as EvolutionSuggestion[])[0]!
    const promoted = await client.promoteEvolution({ suggestionId: candidate.suggestionId, expectedHash: candidate.hash!, policyRevision: String(listed.result?.policyRevision) })
    expect(promoted).toMatchObject({ ok: true, suggestion: { status: "accepted", receipt: { revision: 1 } } })
    expect(daemon.store.workflows.all()).toHaveLength(0)
    await client.send({ type: "settings.set", patch: { evolution: "off" } })
    expect(await client.rollbackEvolution({ suggestionId: candidate.suggestionId, expectedHash: candidate.hash!, expectedRevision: 1 })).toMatchObject({ ok: true, suggestion: { status: "rolled_back", receipt: { revision: 2 } } })
  }, 10_000)
})

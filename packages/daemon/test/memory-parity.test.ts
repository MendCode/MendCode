import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createMemorySelector } from "@mendcode/engine-native"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createVirtualClock } from "@mendcode/kernel"
import type { DreamRun, EvolutionSuggestion, MemoryCategoryInfo, MemoryEntry, SessionId, Settings } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { dateKey, windows } from "../src/dream-schedule"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

type Complete = (prompt: string) => string | { text: string; usage?: { input: number; output: number } }

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(input: { dir?: string; clock?: ReturnType<typeof createVirtualClock>; complete?: Complete; noDream?: boolean } = {}) {
  const dir = input.dir ?? tempDir("mendd-parity-")
  const calls: string[] = []
  const runs: DreamRun[] = []
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    ...(input.clock ? { clock: input.clock } : {}),
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
    ...(input.noDream ? {} : { dream: { complete: async (prompt) => (calls.push(prompt), (input.complete ?? (() => '{"proposals":[]}'))(prompt)) } }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "parity", onGlobal: (e) => void (e.type === "dream.changed" && runs.push(e.run)) })
  await client.connect()
  cleanups.push(() => client.close())
  const ok = async <T>(command: Parameters<typeof client.send>[0]): Promise<T> => {
    const reply = await client.send(command)
    if (!reply.ok) throw new Error(JSON.stringify(reply))
    return reply.result as T
  }
  const session = async (directory: string, text?: string) => {
    const { sessionId } = await ok<{ sessionId: SessionId }>({ type: "session.create", directory, title: "" })
    if (text) {
      await client.subscribe(sessionId, 0)
      await client.send({ type: "user.submit", sessionId, text, attachments: [] })
      await until(() => daemon.store.readAfter(sessionId, 0).some((e) => e.type === "turn.completed"))
    }
    return sessionId
  }
  const dream = async (directory: string) => {
    const before = runs.filter((r) => r.status !== "running").length
    await ok({ type: "dream.run", directory })
    await until(() => runs.filter((r) => r.status !== "running").length > before)
    return runs.filter((r) => r.status !== "running").at(-1)!
  }
  return { dir, daemon, client, ok, session, dream, calls, runs }
}

describe("Dream report and budget", () => {
  test("a run stores its safety report; dream.list carries it and a runId returns one run", async () => {
    const h = await boot({ complete: () => ({ text: JSON.stringify({ proposals: [{ text: "Releases are cut with bun run release", category: "commands" }] }), usage: { input: 500, output: 50 } }) })
    await h.session("/repo", "how do we release?")
    const finished = await h.dream("/repo")
    expect(finished).toMatchObject({ status: "done", proposed: 1, trigger: "manual" })
    expect(finished.report).toMatchObject({
      read: { sessions: [{ digest: "built", messages: 2 }], memories: 0 },
      proposed: [{ kind: "new", category: "commands", outcome: "pending" }],
      model: { calls: 1, inputTokens: 500, outputTokens: 50, estimated: false },
      budget: { limit: 60_000, used: 550, stopped: false },
    })
    const listed = await h.ok<{ runs: DreamRun[] }>({ type: "dream.list", directory: "/repo" })
    expect(listed.runs[0]!.report).toEqual(finished.report)
    const one = await h.ok<{ runs: DreamRun[] }>({ type: "dream.list", runId: finished.runId })
    expect(one.runs).toHaveLength(1)
    expect(one.runs[0]!.report).toEqual(finished.report)
    expect((await h.ok<{ runs: DreamRun[] }>({ type: "dream.list", runId: finished.runId, directory: "/elsewhere" })).runs).toEqual([])
  })

  test("a second run reuses the digest of a session that did not change", async () => {
    const h = await boot()
    await h.session("/repo", "how do we release?")
    await h.dream("/repo")
    const second = await h.dream("/repo")
    expect(second.report?.read.sessions.map((s) => s.digest)).toEqual(["reused"])
    await h.session("/repo", "and how do we test?")
    const third = await h.dream("/repo")
    expect(third.report?.read.sessions.map((s) => s.digest)).toEqual(["built", "reused"])
  })

  test("dreamMaxTokens bounds the run: a prompt that does not fit is never sent and the report says so", async () => {
    const h = await boot()
    await h.session("/repo", "how do we release? ".repeat(40))
    await h.ok({ type: "settings.set", patch: { dreamMaxTokens: 1_000 } })
    const finished = await h.dream("/repo")
    expect(h.calls).toEqual([])
    expect(finished).toMatchObject({ status: "skipped" })
    expect(finished.report?.budget).toMatchObject({ limit: 1_000, used: 0, stopped: true })
    expect(finished.notes).toContain("token budget")
    expect(await h.ok<{ settings: Settings }>({ type: "settings.get" })).toMatchObject({ settings: { dreamMaxTokens: 1_000 } })
  })

  test("a run that blows up is closed as failed, so later runs are not refused as busy", async () => {
    const h = await boot({
      complete: () => {
        throw new Error("provider exploded")
      },
    })
    await h.session("/repo", "how do we release?")
    expect(await h.dream("/repo")).toMatchObject({ status: "failed", error: "provider exploded" })
    expect(await h.dream("/repo")).toMatchObject({ status: "failed" })
  })
})

describe("missed Dream windows", () => {
  /** The daemon was down across a window: its `HH:MM` and the moment the daemon starts again (20 h after `seed`). */
  async function downAcrossWindow() {
    const dir = tempDir("mendd-window-")
    const seed = Date.now()
    const window = new Date(seed + 10 * 3_600_000)
    const hhmm = `${String(window.getHours()).padStart(2, "0")}:${String(window.getMinutes()).padStart(2, "0")}`
    const first = await boot({ dir, noDream: true })
    await first.session("/repo", "we release with bun run release")
    first.daemon.store.settings.set({ dreamAt: hhmm })
    // The last window this daemon handled is long ago, as if it had been off for days.
    first.daemon.store.meta.set("dream.window", "2000-01-01")
    await first.client.close()
    await first.daemon.stop()
    return { dir, hhmm, restartAt: seed + 20 * 3_600_000 }
  }

  test("a window that passed while the daemon was down runs once at the next start, as `recovered`, and never again", async () => {
    const { dir, restartAt } = await downAcrossWindow()
    const clock = createVirtualClock(restartAt)
    const second = await boot({ dir, clock })
    // The run starts while the daemon starts, before any terminal is connected: read the ledger, not events.
    await until(() => second.daemon.store.dreamRuns.list("/repo").some((run) => run.status === "done"))
    const ledger = second.daemon.store.dreamRuns.list("/repo")
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ trigger: "recovered", status: "done" })
    // Two more hours of checks do not repeat it.
    for (let i = 0; i < 8; i++) {
      clock.advance(15 * 60_000)
      await settle(10)
    }
    expect(second.daemon.store.dreamRuns.list("/repo")).toHaveLength(1)
    await second.client.close()
    await second.daemon.stop()
    // A restart in the same day finds the window handled.
    const third = await boot({ dir, clock: createVirtualClock(restartAt + 3 * 3_600_000) })
    await settle()
    expect(third.daemon.store.dreamRuns.list("/repo")).toHaveLength(1)
  })

  test("a window missed while no project was active is marked handled without any run", async () => {
    const { dir, hhmm, restartAt } = await downAcrossWindow()
    // 50 h after the last conversation: nothing was active in the last 24 h.
    const now = restartAt + 30 * 3_600_000
    const second = await boot({ dir, clock: createVirtualClock(now) })
    await settle()
    expect(second.daemon.store.dreamRuns.list("/repo")).toEqual([])
    expect(second.daemon.store.meta.get("dream.window")).toBe(dateKey(windows(now, hhmm).last))
  })

  test("turning the schedule on after today's window never recovers it retroactively", async () => {
    const h = await boot()
    await h.session("/repo", "we release with bun run release")
    const earlier = new Date(Date.now() - 3_600_000)
    await h.ok({ type: "settings.set", patch: { dreamAt: `${String(earlier.getHours()).padStart(2, "0")}:${String(earlier.getMinutes()).padStart(2, "0")}` } })
    await settle(250)
    expect(h.daemon.store.dreamRuns.list("/repo")).toEqual([])
  })

  test("a window that arrives on time is `scheduled`", async () => {
    const start = new Date(2026, 8, 27, 2, 58, 0).getTime()
    const clock = createVirtualClock(start)
    const h = await boot({ clock })
    await h.session("/active")
    await h.ok({ type: "settings.set", patch: { dreamAt: "03:10" } })
    expect(h.daemon.store.dreamRuns.list("/active")).toEqual([])
    clock.advance(20 * 60_000)
    await settle()
    // No conversation was readable, so the run is skipped; it is still a scheduled run.
    await until(() => h.daemon.store.dreamRuns.list("/active").length === 1)
    expect(h.daemon.store.dreamRuns.list("/active")[0]).toMatchObject({ trigger: "scheduled", status: "skipped" })
  })
})

describe("category policies", () => {
  test("auto saves an agent proposal, review leaves it pending, never drops it; the report says which", async () => {
    const h = await boot({
      complete: () =>
        JSON.stringify({
          proposals: [
            { text: "Releases are cut with bun run release", category: "commands" },
            { text: "The user prefers terse answers", scope: "user", category: "preferences" },
            { text: "Secrets live in the vault", category: "security" },
            { text: "The CI token is sk-abcdEFGH1234ijklMNOP5678 today", category: "commands" },
          ],
        }),
    })
    await h.session("/repo", "how do we release?")
    const before = await h.ok<{ categories: MemoryCategoryInfo[] }>({ type: "memory.categories" })
    expect(before.categories.find((c) => c.id === "commands")).toMatchObject({ defaultPolicy: "review", policy: "review" })
    expect(before.categories.map((c) => c.id)).toContain("volatile")
    await h.ok({ type: "memory.policy", category: "commands", policy: "auto" })
    const after = await h.ok<{ categories: MemoryCategoryInfo[] }>({ type: "memory.policy", category: "security", policy: "never" })
    expect(after.categories.filter((c) => c.policy !== c.defaultPolicy).map((c) => [c.id, c.policy])).toEqual([["commands", "auto"], ["security", "never"]])
    const finished = await h.dream("/repo")
    expect(finished.report?.proposed.map((p) => [p.category, p.outcome])).toEqual([["commands", "saved"], ["preferences", "pending"], ["security", "dropped"], ["commands", "pending"]])
    const saved = (await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", directory: "/repo", status: "saved" })).memories
    expect(saved).toMatchObject([{ text: "Releases are cut with bun run release", source: "agent", status: "saved" }])
    const pending = (await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", directory: "/repo", status: "pending" })).memories
    // The proposal that carried a secret waits for a person even though commands saves automatically, and the secret is gone.
    expect(pending.map((m) => m.text).sort()).toEqual(["The CI token is [redacted:openai-key] today", "The user prefers terse answers"])
    expect(finished.report?.redactions.proposals).toBe(1)
    expect(JSON.stringify(finished.report)).not.toContain("sk-abcd")
    // Putting a category back to its default clears the override.
    await h.ok({ type: "memory.policy", category: "commands", policy: "review" })
    await h.ok({ type: "memory.policy", category: "security", policy: "review" })
    expect((await h.ok<{ settings: Settings }>({ type: "settings.get" })).settings.memoryPolicies).toBeUndefined()
  })

  test("the agent's own remember path follows the same policy", async () => {
    let propose!: (entry: { scope: "project" | "user"; directory: string; text: string; category: string }) => { outcome: string }
    const dir = tempDir("mendd-remember-")
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      engine: ({ clock, memory }) => ((propose = (entry) => memory.propose(entry)), createFauxEngine({ clock, deltaMs: 1 })),
    })
    cleanups.push(() => daemon.stop())
    daemon.store.settings.set({ memoryPolicies: { commands: "auto", volatile: "never", security: "review" } })
    expect(propose({ scope: "project", directory: "/repo", text: "Deploy with fly deploy", category: "commands" }).outcome).toBe("saved")
    expect(propose({ scope: "project", directory: "/repo", text: "Scratch detail", category: "volatile" }).outcome).toBe("dropped")
    expect(propose({ scope: "project", directory: "/repo", text: "Vault is used", category: "Security" }).outcome).toBe("pending")
    expect(propose({ scope: "project", directory: "/repo", text: "Unknown category note", category: "whatever" }).outcome).toBe("pending")
    expect(daemon.store.memories.list({ directory: "/repo" }).map((m) => [m.text, m.status]).sort()).toEqual([["Deploy with fly deploy", "saved"], ["Unknown category note", "pending"], ["Vault is used", "pending"]])
  })
})

describe("session scope and pins", () => {
  test("a session memory is listed and injected for its own session only, and goes with the session", async () => {
    const h = await boot()
    const a = await h.session("/repo")
    const b = await h.session("/repo")
    const mine = (await h.ok<{ memoryId: string }>({ type: "memory.add", scope: "session", sessionId: a, text: "Plan for session a: migrate the tables", category: "other" })).memoryId
    await h.ok({ type: "memory.add", scope: "project", directory: "/repo", text: "Project rule: tests first", category: "conventions" })
    const list = async (session?: SessionId | "all") => (await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", directory: "/repo", ...(session ? { session } : {}) })).memories.map((m) => m.text)
    expect(await list()).toEqual(["Project rule: tests first"])
    expect(await list(a)).toEqual(expect.arrayContaining(["Plan for session a: migrate the tables", "Project rule: tests first"]))
    expect(await list(b)).toEqual(["Project rule: tests first"])
    expect(await list("all")).toHaveLength(2)
    const found = async (session?: SessionId) => (await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.search", query: "migrate tables", directory: "/repo", ...(session ? { session } : {}) })).memories.length
    expect([await found(), await found(b), await found(a)]).toEqual([0, 0, 1])
    expect((await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", session: "all" })).memories.find((m) => m.memoryId === mine)).toMatchObject({ scope: "session", sessionId: a, directory: "/repo" })
    // Dream does not see session memories, and only a known session can own one.
    expect(await h.client.send({ type: "memory.add", scope: "session", text: "No session given here", category: "other" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "memory.add", scope: "session", sessionId: "session_nope" as SessionId, text: "Unknown session here", category: "other" })).toMatchObject({ ok: false })
    await h.ok({ type: "session.delete", sessionId: a })
    expect(await list("all")).toEqual(["Project rule: tests first"])
  })

  test("pins: only saved memories, at most 20 per place, and unpinning frees a slot", async () => {
    const h = await boot()
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await h.ok<{ memoryId: string }>({ type: "memory.add", scope: "project", directory: "/repo", text: `Pinned rule number ${i}`, category: "conventions", pinned: true })).memoryId)
    expect(await h.client.send({ type: "memory.add", scope: "project", directory: "/repo", text: "One pin too many", category: "conventions", pinned: true })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    // Another project has its own allowance.
    await h.ok({ type: "memory.add", scope: "project", directory: "/other", text: "Pinned elsewhere", category: "conventions", pinned: true })
    const extra = (await h.ok<{ memoryId: string }>({ type: "memory.add", scope: "project", directory: "/repo", text: "Unpinned rule", category: "conventions" })).memoryId
    expect(await h.client.send({ type: "memory.update", memoryId: extra as never, pinned: true })).toMatchObject({ ok: false })
    await h.ok({ type: "memory.update", memoryId: ids[0] as never, pinned: false })
    await h.ok({ type: "memory.update", memoryId: extra as never, pinned: true })
    expect((await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", directory: "/repo", status: "saved" })).memories.filter((m) => m.pinned)).toHaveLength(20)
  })

  test("a pending memory cannot be pinned", async () => {
    const h = await boot()
    const id = "memory_pending_one" as never
    h.daemon.store.memories.add({ memoryId: id, scope: "project", directory: "/repo", text: "Waiting for review", category: "other", status: "pending", source: "agent" })
    expect(await h.client.send({ type: "memory.update", memoryId: id, pinned: true })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})

describe("Evolution", () => {
  const correction = "Actually use pnpm instead of npm for installs in this repo."
  const answer = (candidates: unknown[]) => JSON.stringify({ candidates })
  const skill = { kind: "skill", name: "use-pnpm", description: "Install dependencies with pnpm", content: "Run pnpm install. Never run npm install.", evidence: ["e1"] }

  async function project(complete: Complete, mode?: "observe" | "suggest" | "auto-safe") {
    const repo = tempDir("mendd-evo-project-")
    const h = await boot({ complete })
    if (mode) await h.ok({ type: "settings.set", patch: { evolution: mode } })
    await h.session(repo, correction)
    await h.session(repo, correction)
    return { ...h, repo }
  }
  const dreamOnly = (prompt: string, evolution: string) => (prompt.includes("## Evidence") ? evolution : '{"proposals":[]}')

  test("off (the default) learns nothing: no evidence, no suggestions, the list says so", async () => {
    const h = await project((prompt) => dreamOnly(prompt, answer([skill])))
    const finished = await h.dream(h.repo)
    expect(finished.report?.evolution).toBeUndefined()
    expect(h.calls.some((p) => p.includes("## Evidence"))).toBe(false)
    expect(await h.ok<unknown>({ type: "evolution.list", directory: h.repo })).toEqual({ mode: "off", suggestions: [], observed: { corrections: 0, preferences: 0, recurring: 0 } })
  })

  test("observe records that a correction recurs, keeps no text and calls no model for it", async () => {
    const h = await project((prompt) => dreamOnly(prompt, answer([skill])), "observe")
    const finished = await h.dream(h.repo)
    expect(finished.report?.evolution).toMatchObject({ mode: "observe", observed: { corrections: 1, recurring: 1 }, suggested: { skills: 0 } })
    expect(h.calls).toHaveLength(1)
    expect(await h.ok({ type: "evolution.list", directory: h.repo })).toMatchObject({ mode: "observe", suggestions: [], observed: { corrections: 1, recurring: 1 } })
    expect(h.daemon.store.evolution.recurring(h.repo)[0]?.text).toBeUndefined()
  })

  test("suggest files a skill suggestion and a memory for review; accepting writes the skill, never over an existing one", async () => {
    const h = await project((prompt) => dreamOnly(prompt, answer([skill, { kind: "memory", content: "Installs in this repo use pnpm, not npm", category: "commands", evidence: ["e1"] }])), "suggest")
    await h.ok({ type: "memory.policy", category: "commands", policy: "auto" })
    const finished = await h.dream(h.repo)
    expect(finished.report?.evolution).toMatchObject({ mode: "suggest", suggested: { memories: 1, skills: 1 }, applied: 0 })
    // suggest never saves: the memory waits even though its category is auto.
    const memories = (await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", directory: h.repo })).memories
    expect(memories.map((m) => [m.text, m.status])).toEqual([["Installs in this repo use pnpm, not npm", "pending"]])
    const listed = await h.ok<{ mode: string; suggestions: EvolutionSuggestion[] }>({ type: "evolution.list", directory: h.repo })
    expect(listed).toMatchObject({ mode: "suggest", suggestions: [{ kind: "skill", name: "use-pnpm", status: "pending", evidence: 1, runId: finished.runId }] })
    const { suggestionId } = listed.suggestions[0]!
    const accepted = await h.ok<{ suggestion: EvolutionSuggestion; path: string }>({ type: "evolution.resolve", suggestionId, decision: "accept" })
    expect(accepted.suggestion.status).toBe("accepted")
    expect(accepted.path).toBe(path.join(h.repo, ".mendcode", "skills", "use-pnpm", "SKILL.md"))
    expect(readFileSync(accepted.path, "utf8")).toBe("---\nname: use-pnpm\ndescription: Install dependencies with pnpm\n---\n\nRun pnpm install. Never run npm install.\n")
    expect(await h.client.send({ type: "evolution.resolve", suggestionId, decision: "reject" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.client.send({ type: "evolution.resolve", suggestionId: 999, decision: "accept" })).toMatchObject({ ok: false })
  })

  test("accepting refuses to overwrite a skill that exists or to write through a symlink; rejecting writes nothing", async () => {
    const h = await project((prompt) => dreamOnly(prompt, answer([skill, { ...skill, kind: "instruction", name: "pnpm-rule", content: "Use pnpm for every install." }])), "suggest")
    await h.dream(h.repo)
    const listed = (await h.ok<{ suggestions: EvolutionSuggestion[] }>({ type: "evolution.list", directory: h.repo })).suggestions
    const bySkill = listed.find((s) => s.kind === "skill")!
    const instruction = listed.find((s) => s.kind === "instruction")!
    mkdirSync(path.join(h.repo, ".mendcode", "skills", "use-pnpm"), { recursive: true })
    await Bun.write(path.join(h.repo, ".mendcode", "skills", "use-pnpm", "SKILL.md"), "mine")
    expect(await h.client.send({ type: "evolution.resolve", suggestionId: bySkill.suggestionId, decision: "accept" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(readFileSync(path.join(h.repo, ".mendcode", "skills", "use-pnpm", "SKILL.md"), "utf8")).toBe("mine")
    // Still pending after a refused write.
    expect((await h.ok<{ suggestion: EvolutionSuggestion }>({ type: "evolution.resolve", suggestionId: bySkill.suggestionId, decision: "reject" })).suggestion.status).toBe("rejected")
    // An instruction is only marked accepted; its text is in the suggestion.
    const accepted = await h.ok<{ suggestion: EvolutionSuggestion; path?: string }>({ type: "evolution.resolve", suggestionId: instruction.suggestionId, decision: "accept" })
    expect(accepted.suggestion).toMatchObject({ status: "accepted", content: "Use pnpm for every install." })
    expect(accepted.path).toBeUndefined()
    // A skills folder that is a symlink leads out of the project: refused.
    const outside = tempDir("mendd-evo-outside-")
    rmSync(path.join(h.repo, ".mendcode", "skills"), { recursive: true })
    symlinkSync(outside, path.join(h.repo, ".mendcode", "skills"))
    h.daemon.store.evolution.suggest({ directory: h.repo, kind: "skill", name: "other-skill", description: "Other", content: "Body", evidence: 1 })
    const other = h.daemon.store.evolution.suggestions(h.repo, "pending")[0]!
    expect(await h.client.send({ type: "evolution.resolve", suggestionId: other.suggestionId, decision: "accept" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(existsSync(path.join(outside, "other-skill"))).toBe(false)
  })

  test("auto-safe saves memory proposals only where the category policy is auto; skills still wait for the user", async () => {
    const h = await project(
      (prompt) =>
        dreamOnly(
          prompt,
          answer([
            skill,
            { kind: "memory", content: "Installs in this repo use pnpm, not npm", category: "commands", evidence: ["e1"] },
            { kind: "memory", content: "The user wants replies in Spanish always", category: "preferences", evidence: ["e1"] },
          ]),
        ),
      "auto-safe",
    )
    await h.ok({ type: "memory.policy", category: "commands", policy: "auto" })
    const finished = await h.dream(h.repo)
    expect(finished.report?.evolution).toMatchObject({ mode: "auto-safe", suggested: { memories: 2, skills: 1 }, applied: 1 })
    const memories = (await h.ok<{ memories: MemoryEntry[] }>({ type: "memory.list", directory: h.repo })).memories
    expect(memories.map((m) => [m.category, m.status]).sort()).toEqual([["commands", "saved"], ["preferences", "pending"]])
    expect(existsSync(path.join(h.repo, ".mendcode"))).toBe(false)
    expect((await h.ok<{ suggestions: EvolutionSuggestion[] }>({ type: "evolution.list", directory: h.repo })).suggestions.map((s) => s.status)).toEqual(["pending"])
  })
})

describe("relevance retrieval through the daemon's memory port", () => {
  test("ranks the memories a session sees for its prompt with the store's full-text search: pinned first, matches before the rest, own session only", async () => {
    let port!: Parameters<typeof createMemorySelector>[0]
    const dir = tempDir("mendd-retrieval-")
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      engine: ({ clock, memory }) => ((port = memory), createFauxEngine({ clock, deltaMs: 1 })),
    })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "retrieval" })
    await client.connect()
    cleanups.push(() => client.close())
    const add = async (command: Record<string, unknown>) => {
      const reply = await client.send({ type: "memory.add", category: "other", ...command } as never)
      if (!reply.ok) throw new Error(JSON.stringify(reply))
    }
    const a = ((await client.send({ type: "session.create", directory: "/repo", title: "" })) as { result?: { sessionId?: SessionId } }).result!.sessionId!
    const b = ((await client.send({ type: "session.create", directory: "/repo", title: "" })) as { result?: { sessionId?: SessionId } }).result!.sessionId!
    await add({ scope: "project", directory: "/repo", text: "Deploy with fly deploy after tagging the release" })
    await add({ scope: "project", directory: "/repo", text: "Never force push to main", pinned: true, category: "security" })
    await add({ scope: "project", directory: "/repo", text: "Lunch is at noon in the kitchen" })
    await add({ scope: "session", sessionId: a, text: "Session a is migrating the deploy scripts" })
    const selector = createMemorySelector(port)
    const texts = (sessionId: SessionId, prompt: string) => selector.select({ directory: "/repo", sessionId, prompt }).memories.map((m) => m.text)
    const forA = texts(a, "how do I deploy this?")
    expect(forA[0]).toBe("Never force push to main")
    expect(forA.slice(1, 3).sort()).toEqual(["Deploy with fly deploy after tagging the release", "Session a is migrating the deploy scripts"])
    expect(forA).toContain("Lunch is at noon in the kitchen")
    const forB = texts(b, "how do I deploy this?")
    expect(forB).not.toContain("Session a is migrating the deploy scripts")
    expect(forB.slice(0, 2)).toEqual(["Never force push to main", "Deploy with fly deploy after tagging the release"])
    expect(selector.block({ directory: "/repo", sessionId: b, prompt: "how do I deploy this?" })).toContain("<mendcode_memory>")
  })
})

describe("settings fields", () => {
  test("dreamMaxTokens, evolution and memoryPolicies are validated; unknown values are refused", async () => {
    const h = await boot()
    expect(await h.client.send({ type: "settings.set", patch: { dreamMaxTokens: 10 } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "settings.set", patch: { evolution: "yolo" } })).toMatchObject({ ok: false })
    expect(await h.client.send({ type: "settings.set", patch: { memoryPolicies: { commands: "sometimes" } } })).toMatchObject({ ok: false })
    await h.ok({ type: "settings.set", patch: { dreamMaxTokens: 80_000, evolution: "observe", memoryPolicies: { stack: "auto" } } })
    expect((await h.ok<{ settings: Settings }>({ type: "settings.get" })).settings).toMatchObject({ dreamMaxTokens: 80_000, evolution: "observe", memoryPolicies: { stack: "auto" } })
  })
})

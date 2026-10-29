import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry, type MemoryId } from "@mendcode/protocol"
import { DREAM_LIMITS, dreamPrompt, parseDreamOutput, runDream } from "../src"

const ids = createIdFactory()

function memory(text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return { memoryId: ids("memory"), scope: "project", directory: "/repo", text, category: "commands", status: "saved", source: "user", createdAt: 0, updatedAt: 0, ...patch }
}

const pnpm = memory("Package manager is npm for this repo")
const tests = memory("Tests run with bun test")
const style = memory("UI copy is English and terse")

const parse = (output: unknown, existing: MemoryEntry[]) => {
  const parsed = parseDreamOutput(typeof output === "string" ? output : JSON.stringify(output), existing)
  if ("error" in parsed) throw new Error(parsed.error)
  return parsed
}

describe("dream prompt with revisions", () => {
  const prompt = dreamPrompt({ directory: "/repo", evidence: [{ sessionId: "s", title: "t", lines: ["user: hi"] }], memories: [pnpm, memory("Pending one", { status: "pending", source: "agent" }), memory("Old", { status: "archived" })] })
  test("saved memories are listed with their ids, pending ones without, archived ones not at all", () => {
    expect(prompt).toContain(`- ${pnpm.memoryId} [project/commands] Package manager is npm for this repo`)
    expect(prompt).toContain("(pending, no id) [project/commands, pending] Pending one")
    expect(prompt).not.toContain("Old")
  })
  test("asks for updates and archives and documents the JSON shape", () => {
    expect(prompt).toContain("UPDATE")
    expect(prompt).toContain("ARCHIVE")
    expect(prompt).toContain('"updates"')
    expect(prompt).toContain('"archives"')
    expect(prompt).toContain(`At most ${DREAM_LIMITS.revisions}`)
  })
  test("the memories shown are bounded by count and characters", () => {
    const many = Array.from({ length: 200 }, (_, i) => memory(`memory number ${i} `.padEnd(200, "x")))
    const shown = dreamPrompt({ directory: "/repo", evidence: [], memories: many }).split("\n").filter((line) => line.startsWith("- memory_"))
    expect(shown.length).toBeLessThanOrEqual(DREAM_LIMITS.memories)
    expect(shown.join("").length).toBeLessThan(DREAM_LIMITS.memoryChars + shown.length * 120)
    expect(shown.length).toBeLessThan(60)
  })
})

describe("parseDreamOutput revisions", () => {
  test("accepts updates and archives of saved memories", () => {
    const parsed = parse(
      { proposals: [], updates: [{ id: pnpm.memoryId, text: "Package manager is pnpm for this repo", why: "user corrected it" }], archives: [{ id: style.memoryId, why: "superseded" }], notes: "" },
      [pnpm, tests, style],
    )
    expect(parsed.revisions).toEqual([
      { kind: "update", targetId: pnpm.memoryId, text: "Package manager is pnpm for this repo", reason: "user corrected it" },
      { kind: "archive", targetId: style.memoryId, text: style.text, reason: "superseded" },
    ])
  })
  test("drops unknown ids, pending and archived targets and non-string ids", () => {
    const pending = memory("Some pending memory here", { status: "pending" })
    const archived = memory("An archived memory here", { status: "archived" })
    const parsed = parse(
      {
        updates: [{ id: "memory_nope", text: "Does not exist at all" }, { id: pending.memoryId, text: "Pending target text here" }, { id: archived.memoryId, text: "Archived target text here" }, { id: 7, text: "Numeric id is invalid" }],
        archives: [{ id: "memory_nope" }, { id: pending.memoryId }, {}, null],
      },
      [pnpm, pending, archived],
    )
    expect(parsed.revisions).toEqual([])
  })
  test("drops malformed items but keeps the valid ones next to them", () => {
    const parsed = parse({ updates: [{ id: pnpm.memoryId, text: "short" }, "nonsense", { id: tests.memoryId, text: "Tests run with bun test packages apps" }], archives: "not an array" }, [pnpm, tests])
    expect(parsed.revisions.map((r) => r.targetId)).toEqual([tests.memoryId])
  })
  test("an update must change the text and must not copy another memory", () => {
    const parsed = parse({ updates: [{ id: pnpm.memoryId, text: "package manager is NPM for this repo!" }, { id: tests.memoryId, text: "UI copy is English and terse." }] }, [pnpm, tests, style])
    expect(parsed.revisions).toEqual([])
  })
  test("each memory gets one revision, update winning over archive", () => {
    const parsed = parse({ updates: [{ id: pnpm.memoryId, text: "Package manager is pnpm for this repo" }, { id: pnpm.memoryId, text: "Package manager is pnpm, never npm here" }], archives: [{ id: pnpm.memoryId }] }, [pnpm])
    expect(parsed.revisions).toHaveLength(1)
    expect(parsed.revisions[0]).toMatchObject({ kind: "update", text: "Package manager is pnpm for this repo" })
  })
  test("a memory that already has a pending revision is skipped", () => {
    const waiting = memory("Package manager is pnpm for this repo", { status: "pending", kind: "update", targetId: pnpm.memoryId as MemoryId })
    expect(parse({ updates: [{ id: pnpm.memoryId, text: "Package manager is pnpm, always" }], archives: [{ id: pnpm.memoryId }] }, [pnpm, waiting]).revisions).toEqual([])
  })
  test("updates and archives together are capped", () => {
    const many = Array.from({ length: 12 }, (_, i) => memory(`Saved memory number ${i}`))
    const parsed = parse({ updates: many.slice(0, 8).map((m) => ({ id: m.memoryId, text: `${m.text} revised` })), archives: many.slice(8).map((m) => ({ id: m.memoryId })) }, many)
    expect(parsed.revisions).toHaveLength(DREAM_LIMITS.revisions)
  })
  test("a memory outside the bounded list cannot be revised", () => {
    const many = Array.from({ length: DREAM_LIMITS.memories + 5 }, (_, i) => memory(`Saved memory number ${i}`))
    const hidden = many[DREAM_LIMITS.memories + 2]!
    expect(parse({ archives: [{ id: hidden.memoryId }] }, many).revisions).toEqual([])
  })
  test("outputs without the new keys still parse (old model answers)", () => {
    const parsed = parse('{"proposals":[{"text":"Deploy with fly deploy","scope":"project"}],"notes":"x"}', [])
    expect(parsed.revisions).toEqual([])
    expect(parsed.proposals).toHaveLength(1)
    expect(parsed.notes).toBe("x")
  })
  test("garbage in updates does not fail the whole parse", () => {
    expect(parse({ proposals: [{ text: "Deploy with fly deploy", scope: "project" }], updates: 5, archives: { a: 1 } }, []).proposals).toHaveLength(1)
  })
  test("reason defaults to empty and is capped", () => {
    expect(parse({ archives: [{ id: style.memoryId, why: 12 }] }, [style]).revisions[0]!.reason).toBe("")
  })
})

describe("runDream revisions", () => {
  const base = {
    directory: "/repo",
    sessions: () => [{ sessionId: "s1", title: "t", events: [] as never[] }],
    signal: new AbortController().signal,
  }
  const evidence = () => [
    {
      sessionId: "s1",
      title: "t",
      events: [
        { sessionId: "s1", seq: 1, at: 0, type: "item.started", turnId: "t", itemId: "i", kind: "user_message" },
        { sessionId: "s1", seq: 2, at: 0, type: "item.completed", itemId: "i", status: "ok", text: "we switched to pnpm" },
      ] as never[],
    },
  ]
  const complete = async () => JSON.stringify({ proposals: [], updates: [{ id: pnpm.memoryId, text: "Package manager is pnpm for this repo", why: "switched" }], archives: [{ id: style.memoryId, why: "old" }] })

  test("revisions go to revise and count as proposed, never to propose", async () => {
    const revised: unknown[] = []
    const proposed: unknown[] = []
    const result = await runDream({ ...base, sessions: evidence, memories: () => [pnpm, style], complete, propose: (e) => void proposed.push(e), revise: (e) => void revised.push(e) })
    expect(result).toMatchObject({ status: "done", proposed: 2 })
    expect(proposed).toEqual([])
    expect(revised).toEqual([
      { kind: "update", targetId: pnpm.memoryId, text: "Package manager is pnpm for this repo", reason: "switched" },
      { kind: "archive", targetId: style.memoryId, text: style.text, reason: "old" },
    ])
  })
  test("without a revise hook nothing is revised and nothing is counted", async () => {
    const result = await runDream({ ...base, sessions: evidence, memories: () => [pnpm, style], complete, propose: () => {} })
    expect(result).toMatchObject({ status: "done", proposed: 0, revisions: [] })
  })
})

describe("new proposals that duplicate an update", () => {
  test("a new memory restating an update is dropped, an unrelated one stays", () => {
    const parsed = parseDreamOutput(
      JSON.stringify({
        proposals: [
          { text: "Use `pnpm install` and `pnpm test` in this repository; do not use npm.", scope: "project" },
          { text: "Releases are cut with bun run release after tagging", scope: "project" },
        ],
        updates: [{ id: pnpm.memoryId, text: "Use pnpm in this repository: `pnpm install` and `pnpm test`; do not use npm.", why: "switched" }],
      }),
      [pnpm],
    )
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.revisions).toHaveLength(1)
    expect(parsed.proposals.map((p) => p.text)).toEqual(["Releases are cut with bun run release after tagging"])
  })
  test("archives do not suppress new proposals", () => {
    const parsed = parseDreamOutput(JSON.stringify({ proposals: [{ text: "Package manager is pnpm for this repo now", scope: "project" }], archives: [{ id: pnpm.memoryId, why: "old" }] }), [pnpm])
    if ("error" in parsed) throw new Error(parsed.error)
    expect(parsed.proposals).toHaveLength(1)
  })
  test("the prompt tells the model to prefer an update over a restated new memory", () => {
    expect(dreamPrompt({ directory: "/repo", evidence: [], memories: [] })).toContain("use an update")
  })
})

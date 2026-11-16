import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BOT_MEMORY_FILE_MAX, addBotMemory, appendBotNotes, botMemoryFile, botMemoryPrompt, readBotMemory, searchBotNotes } from "../src/bot-memory"
import { DIGEST_MAX_CHARS, botDigest, summaryAsker, type DigestSession } from "../src/bot-recall"

const now = 1_800_000_000_000
const HOUR = 3_600_000
const session = (over: Partial<DigestSession> & { sessionId: string }): DigestSession => ({ title: "A chat", directory: "/work/app", updatedAt: now - HOUR, status: "idle", ...over })

describe("the recent-activity digest", () => {
  test("lists the bot's sessions of the last day across folders, newest first, one line each with the gist", () => {
    const text = botDigest({
      now, excludeSessionId: "ses_current",
      sessions: [
        session({ sessionId: "ses_aaaaaaaa1111", title: "Fix the parser", directory: "/work/app", updatedAt: now - 2 * HOUR, summary: "Parser now handles nested quotes; tests added." }),
        session({ sessionId: "ses_bbbbbbbb2222", title: "Plan release", directory: "/work/site", updatedAt: now - 5 * HOUR, status: "failed" }),
        session({ sessionId: "ses_current", title: "This very chat", directory: "/work/app" }),
      ],
    })
    expect(text).toContain("# What you have been doing")
    expect(text).toContain('- app · "Fix the parser" · idle · 2h ago · aaaa1111 — Parser now handles nested quotes; tests added.')
    expect(text).toContain('- site · "Plan release" · failed · 5h ago · bbbb2222')
    expect(text.indexOf("Fix the parser")).toBeLessThan(text.indexOf("Plan release"))
    expect(text).not.toContain("This very chat")
  })

  test("sessions older than a day and an empty list give no block", () => {
    expect(botDigest({ now, excludeSessionId: "x", sessions: [session({ sessionId: "ses_old", updatedAt: now - 25 * HOUR })] })).toBe("")
    expect(botDigest({ now, excludeSessionId: "x", sessions: [] })).toBe("")
  })

  test("the block never passes its cap: older sessions are counted, not listed", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => session({ sessionId: `ses_${String(index).padStart(12, "0")}`, title: `Chat number ${index} ${"x".repeat(60)}`, directory: `/work/project-${index}`, updatedAt: now - index * 60_000, summary: "g".repeat(400) }))
    const text = botDigest({ now, excludeSessionId: "x", sessions })
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(text).toContain("Chat number 0")
    expect(text).not.toContain("Chat number 29")
    expect(text).toMatch(/- … and \d+ more/)
  })

  test("a finished session without a fresh summary asks for one in the background, never a working one, and at most three a turn", () => {
    const asked: string[] = []
    botDigest({
      now, excludeSessionId: "x", wantSummary: (id) => asked.push(id),
      sessions: [
        session({ sessionId: "ses_running", status: "running" }),
        session({ sessionId: "ses_fresh", summary: "done", stale: false }),
        session({ sessionId: "ses_stale", summary: "old", stale: true }),
        session({ sessionId: "ses_none1" }), session({ sessionId: "ses_none2" }), session({ sessionId: "ses_none3" }),
      ],
    })
    expect(asked).toEqual(["ses_stale", "ses_none1", "ses_none2"])
  })

  test("a summary asked for lately is not asked for again on the next turn", () => {
    let clock = 0
    const asks: string[] = []
    const ask = summaryAsker({ now: () => clock, ask: (id) => asks.push(id) })
    ask("ses_a"); ask("ses_a"); ask("ses_b")
    expect(asks).toEqual(["ses_a", "ses_b"])
    clock += 11 * 60_000
    ask("ses_a")
    expect(asks).toEqual(["ses_a", "ses_b", "ses_a"])
  })
})

describe("the notes a bot keeps by itself", () => {
  const dirs: string[] = []
  const place = () => { const dir = mkdtempSync(path.join(tmpdir(), "bot-notes-")); dirs.push(dir); return { dir, name: "calm" } }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  test("appends notes once: the same fact in other words of case or punctuation, or contained in a known one, is skipped", () => {
    const where = place()
    expect(appendBotNotes(where, ["Prefers pnpm over npm.", "Deploys go through the staging branch"])).toBe(2)
    expect(appendBotNotes(where, ["prefers PNPM over npm", "Deploys go through the staging branch first, then main", "Uses tabs"])).toBe(1)
    expect(readBotMemory(where).split("\n")).toEqual(["- Prefers pnpm over npm.", "- Deploys go through the staging branch", "- Uses tabs"])
  })

  test("a project's file names its folder and stays apart from the global one", () => {
    const where = place()
    appendBotNotes({ ...where, directory: "/work/app" }, ["The API lives in packages/api"])
    appendBotNotes(where, ["Answers in Spanish"])
    expect(readFileSync(botMemoryFile({ ...where, directory: "/work/app" }), "utf8")).toBe("# /work/app\n- The API lives in packages/api\n")
    expect(botMemoryPrompt({ ...where, directory: "/work/app" })).toContain("- The API lives in packages/api")
    expect(botMemoryPrompt({ ...where, directory: "/work/app" })).not.toContain("# /work/app\n")
    expect(botMemoryPrompt({ ...where, directory: "/work/other" })).not.toContain("packages/api")
  })

  test("when the file is full the oldest notes go, a hand-added note is refused instead, and the prompt carries only the newest lines", () => {
    const where = place()
    for (let index = 0; index < 120; index++) appendBotNotes(where, [`Note number ${index} ${"w".repeat(380)}`])
    const kept = readBotMemory(where)
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(BOT_MEMORY_FILE_MAX)
    expect(kept).toContain("Note number 119")
    expect(kept).not.toContain("Note number 0 ")
    expect(addBotMemory(where, "z".repeat(600))).toContain("full")
    const prompt = botMemoryPrompt({ ...where, directory: "/work/app" })
    expect(prompt).toContain("Note number 119")
    expect(prompt.length).toBeLessThan(3_000)
  })

  test("a search finds notes everywhere and in every project, labelled with the folder", () => {
    const where = place()
    appendBotNotes(where, ["Answers in Spanish"])
    appendBotNotes({ ...where, directory: "/work/app" }, ["Run bun test before a release"])
    appendBotNotes({ ...where, directory: "/work/site" }, ["Release notes go in CHANGELOG"])
    const found = searchBotNotes({ ...where, query: "release" })
    expect(found).toContain("[/work/app] - Run bun test before a release")
    expect(found).toContain("[/work/site] - Release notes go in CHANGELOG")
    expect(found).not.toContain("Spanish")
    expect(searchBotNotes({ ...where, query: "nothing" })).toContain("no note mentions")
    expect(searchBotNotes(where)).toContain("[everywhere] - Answers in Spanish")
  })
})

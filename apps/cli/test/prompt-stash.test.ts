import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createPromptStash, readStash, STASH_LIMIT, stashPath } from "../src/ui/prompt-stash"
import { scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
const dir = () => {
  const next = scratch()
  made.push(next)
  return next.dataDir
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

describe("prompt stash file", () => {
  test("PDF refs survive a terminal restart in the stash", () => {
    const dataDir = dir()
    const attachment = { kind: "document" as const, name: "design.pdf", ref: { sha256: "a".repeat(64), bytes: 2048, mime: "application/pdf" } }
    expect(createPromptStash({ dataDir }).push("review", [attachment])).toMatchObject({ saved: true })
    expect(createPromptStash({ dataDir }).pop().entry).toMatchObject({ text: "review", attachments: [attachment] })
  })
  test("lives at <dataDir>/tui/stash.json and reading a missing file creates nothing", () => {
    const dataDir = dir()
    expect(stashPath(dataDir)).toBe(path.join(dataDir, "tui", "stash.json"))
    expect(readStash(dataDir)).toEqual([])
    expect(createPromptStash({ dataDir }).list()).toEqual([])
    expect(existsSync(path.join(dataDir, "tui"))).toBe(false)
  })

  test("a push is saved at once and a new stash (another terminal, a restart) reads it back", () => {
    const dataDir = dir()
    const first = createPromptStash({ dataDir, now: () => 1_000 })
    expect(first.push("fix the login bug")).toMatchObject({ ok: true, saved: true })
    first.push("second idea\nover two lines")
    const reloaded = createPromptStash({ dataDir })
    expect(reloaded.list()).toEqual([
      { text: "fix the login bug", at: 1_000 },
      { text: "second idea\nover two lines", at: 1_000 },
    ])
    expect(JSON.parse(readFileSync(stashPath(dataDir), "utf8")).entries).toHaveLength(2)
    // Written whole and renamed into place: no temporary file stays, and the file is private.
    expect(readdirSync(path.join(dataDir, "tui"))).toEqual(["stash.json"])
    expect(statSync(stashPath(dataDir)).mode & 0o777).toBe(0o600)
  })

  test("pop takes the newest, or the numbered one of the newest-first list, and saves the rest", () => {
    const dataDir = dir()
    const stash = createPromptStash({ dataDir })
    for (const text of ["one", "two", "three"]) stash.push(text)
    expect(stash.pop().entry?.text).toBe("three")
    expect(stash.pop(2).entry?.text).toBe("one")
    expect(readStash(dataDir).map((entry) => entry.text)).toEqual(["two"])
    expect(stash.pop(5).entry).toBeUndefined()
    expect(stash.pop().entry?.text).toBe("two")
    expect(stash.pop().entry).toBeUndefined()
    expect(readStash(dataDir)).toEqual([])
  })

  test("a blank prompt is not stashed", () => {
    const stash = createPromptStash({ dataDir: dir() })
    expect(stash.push("  \n ")).toMatchObject({ saved: false })
    expect(stash.size).toBe(0)
  })

  test("the list is bounded: the oldest entries go", () => {
    const stash = createPromptStash({ dataDir: dir() })
    for (let i = 0; i < STASH_LIMIT + 5; i++) stash.push(`prompt ${i}`)
    expect(stash.size).toBe(STASH_LIMIT)
    expect(stash.list()[0]!.text).toBe("prompt 5")
    expect(stash.list().at(-1)!.text).toBe(`prompt ${STASH_LIMIT + 4}`)
  })

  test("clear empties the file", () => {
    const dataDir = dir()
    const stash = createPromptStash({ dataDir })
    stash.push("x")
    expect(stash.clear()).toEqual({ ok: true })
    expect(readStash(dataDir)).toEqual([])
  })

  test("a broken or foreign file is an empty stash, and bad rows are skipped", () => {
    const dataDir = dir()
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    for (const text of ["{ not json", "[1]", "42", "", '{"entries":"no"}']) {
      writeFileSync(stashPath(dataDir), text)
      expect(readStash(dataDir)).toEqual([])
    }
    writeFileSync(stashPath(dataDir), JSON.stringify({ entries: [{ text: "good", at: 5 }, { text: 7 }, null, { text: "  " }, { text: "no time" }] }))
    expect(readStash(dataDir)).toEqual([{ text: "good", at: 5 }, { text: "no time", at: 0 }])
  })

  test("without a data dir the stash lives in memory only", () => {
    const stash = createPromptStash({})
    expect(stash.push("kept for the session")).toMatchObject({ ok: true, saved: true })
    expect(stash.pop().entry?.text).toBe("kept for the session")
  })

  test("a folder that cannot be written is reported, not thrown", () => {
    const dataDir = dir()
    writeFileSync(path.join(dataDir, "tui"), "a file where the folder should be")
    const result = createPromptStash({ dataDir }).push("x")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("could not save")
  })
})

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSessionTranscripts } from "../src/session-transcripts"

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-transcripts-")); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("a transcript is saved owner-only under a sanitized name and overwritten per generation", async () => {
  const dir = temp()
  const transcripts = createSessionTranscripts(dir)
  const file = await transcripts.save({ sessionId: "ses/../evil", generation: 2, markdown: "first" })
  expect(path.dirname(file)).toBe(path.join(dir, "session-transcripts"))
  expect(path.basename(file)).toBe("ses____evil-g2.md")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  await transcripts.save({ sessionId: "ses/../evil", generation: 2, markdown: "second" })
  expect(readFileSync(file, "utf8")).toBe("second")
  expect(readdirSync(path.join(dir, "session-transcripts"))).toEqual(["ses____evil-g2.md"])
})

test("oversized transcripts keep head and tail within the cap", async () => {
  const transcripts = createSessionTranscripts(temp())
  const file = await transcripts.save({ sessionId: "s", generation: 1, markdown: `HEAD${"é".repeat(5_000_000)}TAIL` })
  const text = readFileSync(file, "utf8")
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(text.startsWith("HEAD")).toBe(true)
  expect(text.endsWith("TAIL")).toBe(true)
  expect(text).toContain("[Transcript capped for disk safety]")
})

test("old transcripts are removed after the retention period", async () => {
  const dir = temp()
  const transcripts = createSessionTranscripts(dir)
  const old = await transcripts.save({ sessionId: "old", generation: 1, markdown: "x" })
  const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  utimesSync(old, aged, aged)
  const fresh = await transcripts.save({ sessionId: "new", generation: 1, markdown: "y" })
  expect(existsSync(old)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
})

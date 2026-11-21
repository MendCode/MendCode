import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logCommentEvent } from "../src/ui/app/comment-log"

const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "comment-log-")); dirs.push(dir); return dir }

describe("the comment log", () => {
  test("a send and a restore each write one line with the time, the path, the session and the count, never any text", () => {
    const dir = temp()
    logCommentEvent(dir, { kind: "sent", sessionId: "ses_a", count: 2 })
    logCommentEvent(dir, { kind: "draft", sessionId: "ses_a", count: 1, parked: true })
    logCommentEvent(dir, { kind: "queue", sessionId: "ses_b", count: 1 })
    const lines = readFileSync(join(dir, "logs", "comments.log"), "utf8").trim().split("\n")
    expect(lines.map((line) => line.split(" ").slice(1).join(" "))).toEqual(["sent ses_a 2", "restored-from-draft ses_a 1 parked", "restored-from-queue ses_b 1"])
    expect(Number.isNaN(Date.parse(lines[0]!.split(" ")[0]!))).toBe(false)
  })

  test("without a data dir nothing is written, and a log past its size starts over", () => {
    logCommentEvent(undefined, { kind: "sent", sessionId: "ses_a", count: 1 })
    const dir = temp()
    mkdirSync(join(dir, "logs"))
    writeFileSync(join(dir, "logs", "comments.log"), "x".repeat(70 * 1024))
    logCommentEvent(dir, { kind: "stash", sessionId: "ses_c", count: 3 })
    const text = readFileSync(join(dir, "logs", "comments.log"), "utf8")
    expect(text.startsWith("x")).toBe(false)
    expect(text.trim().endsWith("restored-from-stash ses_c 3")).toBe(true)
  })
})

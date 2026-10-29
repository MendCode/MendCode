import { afterEach, expect, test } from "bun:test"
import type { ChangesReport, ReviewSnapshot } from "@mendcode/protocol"
import { createComment, parseDiffRows, reviewTarget } from "@mendcode/protocol/wire"
import { appHarness, cleanTemps, NOW, tempDir, ids } from "./session-ui-harness"

afterEach(cleanTemps)
const report: ChangesReport = { root: "/work/app", branch: "main", omittedFiles: 0, files: ["a.ts", "b.ts"].map((path) => ({ path, status: "modified", binary: false, truncated: false, additions: 2, deletions: 1, diff: "@@ -1 +1,2 @@\n-old\n+one\n+two\n" })) }
export function comment(body: string, file = "a.ts", author: "user" | "assistant" = "assistant") {
  const rows = parseDiffRows(report.files[0]!.diff.trimEnd().split("\n"))
  return { ...createComment({ target: reviewTarget({ path: file, rows, from: 2, to: 2 }), body, now: NOW }), author }
}
function setup(failSend = false, addDuringSend = false) {
  let shared: ReviewSnapshot = { revision: 0, comments: [], selection: { filePath: "a.ts", blockIndex: 0, row: 0 } }
  const h = appHarness({ width: 100, height: 30, mode: "full", directory: report.root, dataDir: tempDir(), reply: (cmd) => {
    if (cmd.type === "changes.query") return { ok: true, result: report }
    if (cmd.type === "review.query") return { ok: true, result: { review: structuredClone(shared), report } }
    if (cmd.type === "review.update") {
      const c = cmd.change
      if (c.action === "sync") {
        const comments = new Map(shared.comments.filter((cmt) => !c.remove?.includes(cmt.id)).map((cmt) => [cmt.id, cmt]))
        for (const cmt of c.upsert ?? []) comments.set(cmt.id, cmt)
        shared = { revision: shared.revision + 1, selection: c.selection ?? shared.selection, comments: [...comments.values()] }
      } else shared = { ...shared, revision: shared.revision + 1 }
      return { ok: true, result: { review: structuredClone(shared) } }
    }
    if (cmd.type === "user.submit") {
      if (failSend) return { ok: false, error: { code: "busy", message: "busy" } }
      if (addDuringSend) {
        shared = { ...shared, revision: shared.revision + 1, comments: [...shared.comments, comment("Arrived during send")] }
        h.app.onGlobal({ type: "review.changed", gseq: 0, at: NOW, sessionId: h.sessionId, review: structuredClone(shared) })
      }
    }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true })
  const remote = (patch: Partial<ReviewSnapshot>, sessionId = h.sessionId) => {
    shared = { ...shared, ...patch, revision: shared.revision + 1 }
    h.app.onGlobal({ type: "review.changed", gseq: 0, at: NOW, sessionId, review: structuredClone(shared) })
  }
  return { ...h, remote, shared: () => shared }
}

test("model navigation and comments update the real Changes page; old revisions and other sessions are ignored", async () => {
  const h = setup()
  await h.type("/changes\r")
  h.remote({ selection: { filePath: "b.ts", blockIndex: 0, row: 2 }, comments: [comment("Agent finding", "b.ts")] })
  h.app.render()
  expect(h.text().join("\n")).toContain("assistant: Agent finding")
  expect(h.frames.at(-1)!.some((row) => row.some((s) => s.bg === "element" && s.text === "one"))).toBe(true)
  h.app.onGlobal({ type: "review.changed", gseq: 0, at: NOW, sessionId: h.sessionId, review: { revision: 0, selection: {}, comments: [] } })
  h.remote({ comments: [] }, ids("session"))
  h.app.render()
  expect(h.text().join("\n")).toContain("Agent finding")
})

test("remote comments/navigation keep a compose draft; saving sends only the local addition", async () => {
  const h = setup()
  await h.type("/changes\r")
  for (const key of ["\r", "j", "j", "c"]) await h.app.onKey(key)
  await h.type("Local draft")
  h.remote({ comments: [comment("Remote finding")], selection: { filePath: "b.ts", row: 3, blockIndex: 0 } })
  h.app.render()
  expect(h.text().join("\n")).toContain("Local draft█")
  expect(h.text().join("\n")).toContain("Comment · a.ts:1")
  await h.type("\r")
  expect(h.shared().comments.map((c) => c.body)).toEqual(["Remote finding", "Local draft"])
  const sent = h.sentOf("review.update").at(-1)!
  expect(sent.type === "review.update" && sent.change.upsert?.map((c) => [c.body, c.author])).toEqual([["Local draft", "user"]])
  expect(h.text().join("\n")).toContain("◆2")
})

test("send includes shared authors once, clears only sent ids and keeps new comments", async () => {
  const h = setup(false, true)
  await h.type("/changes\r")
  h.remote({ comments: [comment("Agent finding"), comment("User finding", "b.ts", "user")] })
  await h.type("s")
  const submit = h.sentOf("user.submit")
  expect(submit).toHaveLength(1)
  expect(submit[0]!.type === "user.submit" && submit[0]!.text).toContain("1. assistant comment a.ts:1")
  expect(submit[0]!.type === "user.submit" && submit[0]!.text).toContain("2. user comment b.ts:1")
  expect(h.shared().comments.map((c) => c.body)).toEqual(["Arrived during send"])
  expect(h.app.page).toBe("chat")
  await h.type("/changes\r")
  expect(h.text().join("\n")).toContain("Arrived during send")
})

test("failed send preserves daemon and page comments", async () => {
  const h = setup(true)
  await h.type("/changes\r")
  h.remote({ comments: [comment("Keep me")] })
  await h.type("s")
  expect(h.app.page).toBe("changes")
  expect(h.shared().comments.map((c) => c.body)).toEqual(["Keep me"])
  expect(h.text().join("\n")).toContain("Keep me")
})

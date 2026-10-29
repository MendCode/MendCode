import { writeFileSync } from "node:fs"
import path from "node:path"
import type { ChangesReport, ReviewSnapshot } from "@mendcode/protocol"
import { createComment, parseDiffRows, reviewTarget } from "@mendcode/protocol/wire"
import { appHarness, NOW, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB54Frames(directory: string, sizes: string[]) {
  const report: ChangesReport = { root: "/work/mendcode", branch: "main", omittedFiles: 0, files: [
    { path: "src/retry.ts", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, diff: "@@ -10,3 +10,4 @@ async function retry() {\n const retryable = status >= 500\n-return retryable\n+const delayed = await backoff(attempt)\n+return retryable && delayed\n }\n@@ -30 +31 @@\n-maxAttempts = 3\n+maxAttempts = 5\n" },
    { path: "test/retry.test.ts", status: "untracked", additions: 3, deletions: 0, binary: false, truncated: false, diff: "@@ -0,0 +1,3 @@\n+test(\"backs off before retrying\", () => {\n+  expect(delayed).toBe(true)\n+})\n" },
  ] }
  const rows = parseDiffRows(report.files[0]!.diff.trimEnd().split("\n"))
  const finding = { ...createComment({ target: reviewTarget({ path: "src/retry.ts", rows, from: 3, to: 3 }), body: "Bound the retry delay and preserve cancellation.", now: NOW }), author: "assistant" as const }
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    let review: ReviewSnapshot = { revision: 0, selection: { filePath: report.files[0]!.path, blockIndex: 0, row: 0 }, comments: [] }
    let current = report
    const h = appHarness({ width, height, directory: report.root, dataDir: tempDir(), mode: "full", reply: (cmd) => {
      if (cmd.type === "changes.query") return { ok: true, result: current }
      if (cmd.type === "review.query") return { ok: true, result: { review, report: current } }
      if (cmd.type === "review.update") {
        const c = cmd.change
        const comments = new Map(review.comments.filter((entry) => !c.remove?.includes(entry.id)).map((entry) => [entry.id, entry]))
        for (const entry of c.upsert ?? []) comments.set(entry.id, entry)
        review = { ...review, revision: review.revision + 1, comments: [...comments.values()], ...(c.selection ? { selection: c.selection } : {}) }
        return { ok: true, result: { review } }
      }
      return { ok: true }
    } })
    h.app.applySettings({ onboarded: true })
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const plain = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (plain.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`ANSI: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), plain.join("\n") + "\n")
    }
    const remote = () => h.app.onGlobal({ type: "review.changed", gseq: 0, at: NOW, sessionId: h.sessionId, review })
    await h.type("/changes\r")
    save("changes-files")
    review = { revision: review.revision + 1, selection: { filePath: "src/retry.ts", blockIndex: 0, row: 3 }, comments: [finding] }
    remote()
    save("changes-agent-comment")
    await h.app.onKey("c")
    await h.type("Add a cancellation test")
    save("changes-compose")
    await h.app.onKey("\r")
    save("changes-user-comment")
    await h.app.onKey("L")
    save("changes-comments")
    await h.app.onKey("\x1b")
    await h.app.onKey("l")
    await h.type("31")
    save("changes-jump")
    await h.app.onKey("\r")
    save("changes-hunk-selected")
    review = { ...review, revision: review.revision + 1, selection: { filePath: "test/retry.test.ts", blockIndex: 0, row: 1 } }
    remote()
    save("changes-agent-navigation")
    current = { ...report, files: [report.files[1]!] }
    review = { ...review, revision: review.revision + 1, comments: review.comments.map((c) => ({ ...c, stale: true })) }
    await h.app.onKey("r")
    await h.app.onKey("L")
    save("changes-outdated-comments")
    await h.app.onKey("s")
    await h.type("/changes\r")
    current = { ...report, files: [] }
    await h.app.onKey("r")
    save("changes-empty")
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
}

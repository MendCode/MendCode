import { createIdFactory, type BlobRef, type SessionEvent, type TurnId } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createTranscript, type PresentationMode } from "../../apps/cli/src/view/transcript"
import { textWidth } from "../../apps/cli/src/view/wrap"

/**
 * A realistic event stream for the chat transcript: an attached image, reasoning, markdown with a code
 * block and a table, a run of read/grep rows, an edit, a shell, a two-file patch, a todo list, a failed
 * turn, a cancelled turn, a compaction and a live turn. Prints the transcript as ANSI.
 *
 * usage: bun benchmarks/fixtures/chat-transcript-fixture.ts [width=120] [height=45] [mode=balanced] [offset=0|all]
 */
const ids = createIdFactory()
const sessionId = ids("session")
const hour = 3_600_000
/** "Now" for the fixture: 2026-09-28 15:50 local time, so today's messages show a bare time and older ones a date. */
export const NOW = new Date(2026, 8, 28, 15, 50, 0).getTime()

export function chatEvents(): SessionEvent[] {
  let seq = 0
  let clock = NOW - 26 * hour
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>, advance = 400) => {
    clock += advance
    events.push({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const item = (turnId: TurnId, kind: string, options: { meta?: Record<string, string | number | boolean>; text?: string; deltas?: string[]; status?: string; attachments?: BlobRef[]; advance?: number } = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind, ...(options.meta ? { meta: options.meta } : {}) }, 200)
    for (const text of options.deltas ?? []) emit({ type: "item.delta", itemId, text }, 60)
    if (options.status !== "running") emit({ type: "item.completed", itemId, status: options.status ?? "ok", ...(options.text !== undefined ? { text: options.text } : {}), ...(options.attachments ? { attachments: options.attachments } : {}) }, options.advance ?? 300)
    return itemId
  }
  const usage = (turnId: TurnId, input: number, output: number) => emit({ type: "usage.recorded", turnId, provider: "codex", model: "gpt-5.6", input, output, reasoning: 0, cacheRead: input * 3, cacheWrite: 0 })
  const start = (advance = 900) => {
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") }, advance)
    return turnId
  }

  // Turn 1 (yesterday): the big one.
  const image: BlobRef = { sha256: "a".repeat(64), bytes: 48_000, mime: "image/png", name: "footer-crop.png" }
  let turn = start(0)
  item(turn, "user_message", { text: "The footer clips the ctx segment at 100 columns, see the screenshot.\nCan you find why and fix it, then add a test for it?", attachments: [image, { ...image, sha256: "b".repeat(64), mime: "application/pdf", name: "footer-spec.pdf" }] })
  item(turn, "reasoning", { deltas: ["**Locating the footer layout**\n", "The footer joins segments with a fixed gap.\n", "I should check how width is distributed before changing anything.\n", "Then the failing case is 100 columns with a long branch name."] })
  const reads = ["src/view/footer.ts", "src/ui/app.ts", "src/view/wrap.ts", "test/footer.test.ts", "src/view/format.ts"]
  for (const file of reads) item(turn, "tool_call", { meta: { tool: `read: ${file}` }, text: "line\n".repeat(40), advance: 700 })
  for (const pattern of ["segments", "ellipsis"]) item(turn, "tool_call", { meta: { tool: `grep: ${pattern}` }, text: "src/view/footer.ts:41\nsrc/view/footer.ts:77\nsrc/ui/app.ts:230", advance: 500 })
  item(turn, "reasoning", { deltas: ["**Choosing the fix**\n", "Drop the least important segment first, keep the model."] })
  item(turn, "tool_call", {
    meta: { tool: "edit: src/view/footer.ts" },
    text: ["@@ -38,7 +38,9 @@", " function fit(segments: Segment[], width: number) {", "-  return segments.join(GAP)", "+  const kept = [...segments]", "+  while (widthOf(kept) > width && kept.length > 1) kept.splice(dropIndex(kept), 1)", "+  return kept.join(GAP)", " }", " ", " export function renderFooter(input: FooterInput) {"].join("\n"),
    advance: 900,
  })
  item(turn, "tool_call", {
    meta: { tool: "shell: bun test apps/cli/test/footer.test.ts" },
    text: ["bun test v1.3.13", "", "apps/cli/test/footer.test.ts:", "(pass) footer > joins segments [0.4ms]", "(pass) footer > drops ctx first at 100 columns [0.3ms]", "(pass) footer > keeps the model [0.2ms]", "", " 3 pass", " 0 fail", "Ran 3 tests across 1 file. [24.00ms]"].join("\n"),
    advance: 4_200,
  })
  item(turn, "tool_call", {
    meta: { tool: "apply_patch" },
    text: [
      "*** Add File: test/footer-fit.test.ts",
      "+import { expect, test } from \"bun:test\"",
      "+import { renderFooter } from \"../src/view/footer\"",
      "+",
      "+test(\"ctx is dropped before the model at 100 columns\", () => {",
      "+  expect(renderFooter({ width: 100 })).toContain(\"gpt-5.6\")",
      "+})",
      "*** Update File: src/view/footer.ts",
      "@@ -12,3 +12,4 @@",
      " const GAP = \"  \"",
      "-const ORDER = [\"state\", \"ctx\", \"model\"]",
      "+const ORDER = [\"model\", \"state\", \"ctx\"]",
      "+const DROP_ORDER = [\"ctx\", \"state\"]",
    ].join("\n"),
    advance: 800,
  })
  item(turn, "tool_call", { meta: { tool: "todo" }, text: ["[x] Reproduce the clipped footer at 100 columns", "[x] Drop segments by priority", "[~] Add a regression test", "[ ] Check 60 columns", "[ ] Update the docs"].join("\n"), advance: 300 })
  item(turn, "agent_message", {
    text: [
      "Found it: `fit()` joined every segment with a fixed gap, so at 100 columns the ctx segment ran past the edge.",
      "",
      "```ts",
      "// src/view/footer.ts",
      "export function fit(segments: Segment[], width: number): string {",
      "  const kept = [...segments]",
      "  while (widthOf(kept) > width && kept.length > 1) kept.splice(dropIndex(kept), 1)",
      '  return kept.join(GAP) // "ok" at 100 cols: 3 segments',
      "}",
      "```",
      "",
      "| Width | Before | After |",
      "|---|---|---|",
      "| 100 | clipped ctx | ctx dropped, model kept |",
      "| 60 | clipped model | model + state |",
      "",
      "I added a regression test and ran the footer suite: **3 passed**.",
    ].join("\n"),
    advance: 1_500,
  })
  usage(turn, 8_200, 1_140)
  emit({ type: "turn.completed", turnId: turn }, 300)

  // Turn 2: the provider failed.
  turn = start(60_000)
  item(turn, "user_message", { text: "Now check 60 columns too." })
  item(turn, "tool_call", { meta: { tool: "read: src/view/footer.ts" }, text: "line\n".repeat(60), advance: 500 })
  usage(turn, 9_000, 20)
  emit({ type: "turn.failed", turnId: turn, error: { code: "rate_limit", message: "Rate limit reached for gpt-5.6 in organization org-mend on tokens per min (TPM): Limit 30000, Used 29876, Requested 4112. Please try again in 8.2s. Visit the usage page to see limits and request an increase." } }, 2_100)

  // Turn 3: cancelled by the user.
  turn = start(30_000)
  item(turn, "user_message", { text: "retry" })
  item(turn, "tool_call", { meta: { tool: "shell: bun run build" }, deltas: ["building…\n"], status: "cancelled", text: "building…" })
  emit({ type: "turn.cancelled", turnId: turn, by: "user" }, 400)

  // Compaction between turns.
  turn = start(20_000)
  item(turn, "compaction", { deltas: ["The session fixed the clipped ctx segment in the footer by dropping low-priority segments first. Tests were added; 60-column behavior is still open."], text: "The session fixed the clipped ctx segment in the footer by dropping low-priority segments first. Tests were added; 60-column behavior is still open.", advance: 2_000 })
  usage(turn, 60_000, 700)
  emit({ type: "turn.completed", turnId: turn }, 100)

  // Turn 4 (live, today): reasoning streaming and a running shell.
  clock = NOW - 40_000
  turn = start(0)
  item(turn, "user_message", { text: "Run the whole suite and tell me what fails." })
  item(turn, "reasoning", { deltas: ["**Running the suite**\n", "Start with the full apps/cli run, then read any failure output before touching code.\n"], status: "running" })
  item(turn, "tool_call", { meta: { tool: "shell: bun test apps/cli" }, deltas: ["bun test v1.3.13\n", "\n", "apps/cli/test/footer.test.ts:\n", "(pass) footer > joins segments [0.4ms]\n"], status: "running" })
  return events
}

export function renderChat(input: { width: number; height: number; mode: PresentationMode; offset?: number | "all" }) {
  const transcript = createTranscript({ mode: input.mode, now: () => NOW, frame: () => 3 })
  for (const event of chatEvents()) transcript.apply(event)
  transcript.viewport(input.width, input.height)
  const rows = input.offset === "all" ? transcript.totalLines(input.width) : input.height
  return transcript.viewport(input.width, rows, input.offset === "all" ? 0 : (input.offset ?? 0))
}

if (import.meta.main) {
  const width = Number(process.argv[2] ?? 120)
  const height = Number(process.argv[3] ?? 45)
  const mode = (process.argv[4] ?? "balanced") as PresentationMode
  const offset = process.argv[5] === "all" ? "all" : Number(process.argv[5] ?? 0)
  const depth = colorDepth({ COLORTERM: "truecolor" })
  for (const line of renderChat({ width, height, mode, offset })) {
    let out = ""
    let used = 0
    for (const span of line.spans) {
      const style = sgr(span, depth)
      out += style ? `${style}${span.text}\x1b[0m` : span.text
      used += textWidth(span.text)
    }
    if (used > width) throw new RangeError(`[FIXTURE]: a row is ${used} wide, over ${width}`)
    process.stdout.write(`${out}\n`)
  }
}

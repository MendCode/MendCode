import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, plain } from "../apps/cli/test/session-ui-harness"
import { scene, type Scene } from "../apps/cli/test/reply-comments-helpers"
import { sgr, type Line } from "../apps/cli/src/ui/theme"
import { buildCommentMessage, type ReplyComment } from "../apps/cli/src/view/reply-comments"
import { textWidth } from "../apps/cli/src/view/wrap"
import type { TuiProfile } from "../apps/cli/src/view/tui-profile"

/**
 * Reply comments, the SENT message: every frame is a screen of the real wired app (appHarness: createApp, the real transcript and the
 * real renderer of the sent block) after the daemon's echo of a message built by the real envelope builder. Nothing is composed by hand.
 * Usage: `bun scripts/render-comment-sent-frames.ts <directory> <layout>...`; a layout is `before` (the setting is not set, which is the
 * look before the setting existed when run on that commit) or a `commentSentLayout` value. With all of `before stack rail inline`
 * written in the directory, `PREVIEW.txt` stacks the owner's case at 80 columns. Each frame ends with `-- style:` lines (plain text loses
 * weight and colour).
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/comments-sent")
const layouts = process.argv.slice(3)
if (!layouts.length) throw new Error("name at least one layout: before, stack, rail, inline")
mkdirSync(path.join(target, "ansi"), { recursive: true })

const comment = (id: number, quote: string, text: string): ReplyComment => ({ id, quote, text, itemId: "a" })
const message = (comments: ReplyComment[], note = "") => buildCommentMessage({ comments, general: note, lastItemId: "a" })

const MAIN = message([comment(1, "I help you", "testing"), comment(2, "you with?", "test2"), comment(3, "at can I help y", "test")], "vez los comentarios?")
const ONE = message([comment(1, "you with?", "test2")])
const NINE_QUOTES = ["Use Opus 5 for the planner", "keep the executor on codex", "the plan is checked once", "before anything runs", "the schema change cannot be undone", "await migrate({ dryRun: true })", "Pick one and I will start.", "Use codex for both.", "Faster, but never reviewed"]
const NINE_WORDS = ["too slow", "yes", "why once?", "add a dry run", "put it in the PR text", "keep dryRun on in CI", "go", "this one", "no"]
const NINE = message(NINE_QUOTES.map((quote, index) => comment(index + 1, quote, NINE_WORDS[index]!)), "start with the first two and tell me what breaks")
const LONG_QUOTE = "Use Opus 5 for the planner and keep the executor on codex. It starts slower, but the plan is checked once before anything runs, and a failed check stops the batch instead of leaving half of it applied."
const CODE_QUOTE = "const plan = await migrate({\n  dryRun: true,\n  batch: 200,\n})\nif (!plan.ok) throw new Error(plan.reason)"
const LONG = message(
  [comment(1, LONG_QUOTE, "This is the part I do not follow: who checks the plan, and what happens to the rows that already moved when the check fails halfway through the batch?"), comment(2, CODE_QUOTE, "batch 200 is too big for prod")],
  "answer the first one before touching the second, the code can wait until we agree on the plan",
)

type Case = { name: string; text: string; width: number; height: number; expanded?: boolean }
const CASES: readonly Case[] = [
  { name: "main", text: MAIN, width: 80, height: 24 },
  { name: "main", text: MAIN, width: 60, height: 24 },
  { name: "main", text: MAIN, width: 120, height: 24 },
  { name: "one", text: ONE, width: 80, height: 24 },
  { name: "one", text: ONE, width: 60, height: 24 },
  { name: "nine", text: NINE, width: 80, height: 40 },
  { name: "nine", text: NINE, width: 60, height: 40 },
  { name: "long", text: LONG, width: 80, height: 32 },
  { name: "long", text: LONG, width: 60, height: 36 },
  { name: "expanded", text: LONG, width: 80, height: 40, expanded: true },
  { name: "expanded", text: LONG, width: 60, height: 44, expanded: true },
]
const LOOKS = [{ name: "dark", profile: {} }, { name: "light", profile: { theme: "paper" } }] as const

/** Where weight, colour or dim leaves the plain text: one note per row that has any, so a reader of the .txt can see the hierarchy. */
function styles(rows: readonly Line[]): string[] {
  const out: string[] = []
  rows.forEach((row, index) => {
    let col = 0
    const marks: string[] = []
    for (const span of row) {
      const width = textWidth(span.text)
      const traits = [span.fg && span.fg !== "text" ? span.fg : "", span.bold ? "bold" : "", span.dim ? "dim" : ""].filter(Boolean)
      if (span.text.trim() && traits.length) marks.push(`${col}-${col + width - 1} ${traits.join("+")}`)
      col += width
    }
    if (marks.length) out.push(`-- style: row ${index}: ${marks.join(" | ")}`)
  })
  return out
}

async function frame(layout: string, look: (typeof LOOKS)[number], item: Case) {
  const profile = { ...look.profile, ...(layout === "before" ? {} : { commentSentLayout: layout }) } as Partial<TuiProfile>
  const s: Scene = await scene({ width: item.width, height: item.height }, { profile, exchanges: [] })
  s.talk.exchange(item.text, "Understood.")
  if (item.expanded) await s.h.app.onKey("\x0f")
  s.h.app.render()
  const rows: Line[] = s.h.frames.at(-1)!
  const lines = rows.map(plain)
  if (lines.some((line) => textWidth(line) > item.width)) throw new Error(`overflow: ${layout} ${item.name} ${item.width}`)
  const name = `${layout}-${item.name}-${item.width}-${look.name}`
  const body = lines.map((line) => line.trimEnd())
  const notes = styles(rows)
  writeFileSync(path.join(target, `${name}.txt`), `${body.join("\n")}\n${notes.length ? `\n${notes.join("\n")}\n` : ""}`)
  writeFileSync(path.join(target, "ansi", `${name}.ansi`), `${rows.map((row) => row.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join("")).join("\n")}\n`)
}

let count = 0
for (const layout of layouts) {
  for (const look of LOOKS) {
    for (const item of CASES) {
      await frame(layout, look, item)
      count++
    }
  }
}

/** The sent message of a frame: from its `›` lead to the row before the answer. */
function conversation(name: string): string[] {
  const rows = readFileSync(path.join(target, `${name}.txt`), "utf8").split("\n--")[0]!.split("\n")
  const start = rows.findIndex((row) => row.startsWith("  › "))
  const end = rows.findIndex((row) => row.startsWith("  • "))
  if (start < 0 || end < start) throw new Error(`no sent message in ${name}`)
  return rows.slice(start, end)
}

const SHOWN = ["before", "rail", "stack", "inline"] as const
if (SHOWN.every((layout) => existsSync(path.join(target, `${layout}-main-80-dark.txt`)))) {
  const labels: Record<(typeof SHOWN)[number], string> = { before: "BEFORE (what the owner saw)", rail: "RAIL   commentSentLayout=rail (default)", stack: "STACK  commentSentLayout=stack", inline: "INLINE commentSentLayout=inline" }
  const parts = SHOWN.map((layout) => {
    const rows = conversation(`${layout}-main-80-dark`)
    while (rows.length && !rows[0]!.trim()) rows.shift()
    while (rows.length && !rows.at(-1)!.trim()) rows.pop()
    return [`=== ${labels[layout]} · 80 columns · dark ===`, ...rows].join("\n")
  })
  writeFileSync(path.join(target, "PREVIEW.txt"), `${parts.join("\n\n")}\n`)
}

cleanTemps()
console.log(`${count} frames written to ${target}`)
process.exit(0)

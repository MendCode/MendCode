import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, plain } from "../apps/cli/test/session-ui-harness"
import { ALT_L, ALT_Q, ANSWER, CODE, CODEX, comment, CTRL_C, dragOver, ENTER, key, mouse, OPUS, scene, submitted, typeText, WARN, type Scene, type Size } from "../apps/cli/test/reply-comments-helpers"
import { glyphs, sgr, type Line } from "../apps/cli/src/ui/theme"
import { textWidth } from "../apps/cli/src/view/wrap"
import type { TuiProfile } from "../apps/cli/src/view/tui-profile"

/**
 * Reply comments, LIVE frames: every frame is a screen of the real wired app (appHarness: createApp, real transcript, prompt, toast,
 * footer, sidebar and the comment code), reached with real keys and a real mouse drag, and nothing is composed by hand. The states
 * are those of the design frames in `.agents/runs/frames/comments/`, plus the ctrl+c draft indicator and a light-theme set.
 * Usage: `bun scripts/render-comment-frames-live.ts [directory]`, default `.agents/runs/frames/comments-live` of the main checkout.
 * Each frame ends with `-- fill:` lines (where a selection or an element fill is drawn, since plain text loses colour); `ansi/` holds
 * the same frames with the real theme colours.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/comments-live")
mkdirSync(path.join(target, "ansi"), { recursive: true })
void glyphs

const SIZES: readonly Size[] = [{ width: 60, height: 24 }, { width: 80, height: 24 }, { width: 120, height: 40 }, { width: 160, height: 40, sidebar: true }]
const tag = (size: Size) => `${size.width}x${size.height}${size.sidebar ? "-sidebar" : ""}`
const DRAFT = "go ahead with codex"
const PICK = "Pick one and I will start."
const WORDS = [[OPUS, "too slow for a one-off, skip it"], [WARN, "put this in the PR description too"], [CODE, "keep dryRun on in CI"], [CODEX, "this one"], [PICK, "starting now"]] as const

const written: string[] = []
function save(name: string, s: Scene) {
  s.h.app.render()
  const rows: Line[] = s.h.frames.at(-1)!
  if (rows.length !== s.size.height) throw new Error(`height ${rows.length} != ${s.size.height}: ${name}`)
  const lines = rows.map(plain)
  if (lines.some((line) => textWidth(line) > s.size.width)) throw new Error(`overflow: ${name}`)
  const fills = rows.flatMap((row, index) => {
    const out: string[] = []
    let col = 0
    let open: { role: string; from: number } | undefined
    const close = (to: number) => open && out.push(`fill: row ${index} cols ${open.from}-${to - 1} ${open.role === "primary" ? "selection fill" : "element fill"}`)
    for (const span of row) {
      const role = span.bg === "primary" || span.bg === "element" ? span.bg : undefined
      if (open && open.role !== role) {
        close(col)
        open = undefined
      }
      if (role && !open) open = { role, from: col }
      col += textWidth(span.text)
    }
    close(col)
    return out
  })
  writeFileSync(path.join(target, `${name}.txt`), `${lines.map((line) => line.trimEnd()).join("\n")}\n${fills.length ? `\n${fills.map((note) => `-- ${note}`).join("\n")}\n` : ""}`)
  writeFileSync(path.join(target, "ansi", `${name}.ansi`), `${rows.map((row) => row.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join("")).join("\n")}\n`)
  written.push(name)
}

/** A comment on a passage; when the chip rows have pushed it off screen the transcript is scrolled to it first. */
async function commentOn(s: Scene, quote: string, text: string) {
  for (let tries = 0; tries < 12; tries++) {
    try {
      await comment(s, quote, text)
      return
    } catch (error) {
      if (!String(error).includes("not on screen") || tries === 11) throw error
      await s.h.app.onKey(mouse(tries < 6 ? 64 : 65, 2, 2))
      s.h.app.render()
    }
  }
}
async function comments(s: Scene, count: number) {
  for (const [quote, text] of WORDS.slice(0, count)) await commentOn(s, quote, text)
  await s.h.app.onKey(mouse(65, 2, 2))
  for (let n = 0; n < 12; n++) await s.h.app.onKey(mouse(65, 2, 2))
  s.h.app.render()
}

type Look = { name: string; profile: Partial<TuiProfile> }
const LOOKS: readonly Look[] = [{ name: "", profile: {} }, { name: "light-", profile: { theme: "paper" } }]

for (const look of LOOKS) {
  const light = look.name !== ""
  // The light set covers the states whose colours differ most (fills, tinted rule, marks, list, sent message), at two sizes.
  const sizes = light ? [SIZES[1]!, SIZES[2]!] : SIZES
  for (const size of sizes) {
    const t = tag(size)
    const base = (extra: Partial<TuiProfile> = {}) => ({ ...look.profile, ...extra })

    // 01 A selection and its hint: kept (copy on select off) and copied (the default), both placements.
    for (const place of light ? (["prompt"] as const) : (["passage", "prompt"] as const)) {
      const kept = await scene(size, { profile: base({ copyOnSelect: false, commentHint: place } as never) })
      await dragOver(kept, OPUS)
      save(`${look.name}01-selection-kept-hint-${place}-${t}`, kept)
      const copied = await scene(size, { profile: base({ commentHint: place } as never) })
      await dragOver(copied, OPUS)
      save(`${look.name}01-selection-copied-hint-${place}-${t}`, copied)
    }

    // 02 Composing: the passage filled, the comment typed in the one prompt, the main draft kept out of sight.
    {
      const s = await scene(size, { profile: base() })
      await typeText(s, DRAFT)
      await dragOver(s, OPUS)
      await key(s, ALT_Q)
      await typeText(s, "too slow for a one-off, skip it")
      save(`${look.name}02-composing-${t}`, s)
    }

    // 03 One chip and the main draft untouched; 04 three chips; 05 the list open.
    for (const [name, count, list] of [["03-one-chip", 1, false], ["04-three-chips", 3, false], ["05-list-open", 3, true]] as const) {
      if (light && name === "03-one-chip") continue
      const s = await scene(size, { profile: base() })
      await comments(s, count)
      await typeText(s, DRAFT)
      if (list) await key(s, ALT_L)
      save(`${look.name}${name}-${t}`, s)
    }

    // 06 Reply mode on a code block and on a numbered option; the draft is still there.
    for (const [name, steps] of [["06-reply-mode-option", "1"], ["06-reply-mode-code", "k"]] as const) {
      if (light && name === "06-reply-mode-code") continue
      const s = await scene(size, { profile: base() })
      await typeText(s, DRAFT)
      await key(s, ALT_Q)
      await key(s, steps)
      save(`${look.name}${name}-${t}`, s)
    }

    // 07 The numbered fast path: `d` on an option takes the whole list; the answer is typed as `1: no, 2: yes`.
    if (!light) {
      const empty = await scene(size, { profile: base() })
      await key(empty, ALT_Q)
      await key(empty, "1")
      await key(empty, "d")
      save(`07-decide-empty-${t}`, empty)
      const s = await scene(size, { profile: base() })
      await key(s, ALT_Q)
      await key(s, "1")
      await key(s, "d")
      await typeText(s, "1: no, 2: yes")
      save(`07-decide-${t}`, s)
    }

    // 08 The sent message: really sent (comments + draft, one Enter), then the daemon's echo of what was sent. Folded, and as the model gets it.
    for (const folded of light ? [true] : [true, false]) {
      const s = await scene(size, { profile: base({ commentFolded: folded } as never) })
      await comments(s, 3)
      await typeText(s, DRAFT)
      await key(s, ENTER)
      s.talk.exchange(submitted(s)[0]!, "Understood. Skipping Opus, running codex for both, with the PR note and dryRun on in CI.")
      s.h.app.render()
      save(`${look.name}08-sent-${folded ? "folded" : "today"}-${t}`, s)
    }

    // 12 ctrl+c with an empty prompt and comments pending: they stay as a draft, and the row says so.
    {
      const s = await scene(size, { profile: base() })
      await comments(s, 2)
      await key(s, CTRL_C)
      save(`${look.name}12-ctrl-c-draft-${t}`, s)
    }
  }
}

// 09 Narrow collapse: the same chips at 60 and 80 columns with 2, 3 and 5 comments.
for (const size of SIZES.slice(0, 2)) {
  for (const count of [2, 3, 5]) {
    const s = await scene(size)
    await comments(s, count)
    await typeText(s, DRAFT)
    save(`09-chips-${count}-${tag(size)}`, s)
  }
}

// 10 and 11 at 80x24. A new answer arrives while comments are pending; a compaction removes the answer.
{
  const size = SIZES[1]!
  const next = "Going with codex then. I will run the dry run first."
  const pending = await scene(size)
  await comments(pending, 3)
  await typeText(pending, DRAFT)
  pending.talk.exchange("and?", next)
  save(`10-new-answer-pending-${tag(size)}`, pending)
  const list = await scene(size)
  await comments(list, 3)
  list.talk.exchange("and?", next)
  await key(list, ALT_L)
  save(`10-new-answer-list-${tag(size)}`, list)
  for (const open of [false, true]) {
    const s = await scene(size)
    await comments(s, 3)
    await typeText(s, DRAFT)
    const turnId = "turn_compact"
    s.talk.emit({ type: "turn.started", turnId, queueId: "queue_compact" })
    s.talk.emit({ type: "item.started", turnId, itemId: "item_compact", kind: "compaction", meta: { compactionMethod: "summary", tailTurns: 1, tailTokens: 10 } })
    s.talk.emit({ type: "item.completed", itemId: "item_compact", status: "ok", text: "## Current task\n\nPick a model." })
    s.talk.emit({ type: "turn.completed", turnId })
    s.talk.exchange("Where were we?", next)
    if (open) await key(s, ALT_L)
    save(`11-compacted-${open ? "list" : "chips"}-${tag(size)}`, s)
  }
}

cleanTemps()
console.log(`${written.length} frames written to ${target}`)
process.exit(0)

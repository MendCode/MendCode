import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { SIDEBAR_PRESETS } from "../apps/cli/src/view/sidebar-spec"
import { textWidth } from "../apps/cli/src/view/wrap"
import { setTheme } from "../apps/cli/src/ui/theme"

/**
 * Real harness frames of the activity status, the jump-to-latest button and the scrollbar, in plain text. Usage:
 * `render-activity-scroll-frames.ts <directory> [before|after]`. `before` only uses what the code had before the change (the classic working row,
 * the old label, the boolean scrollbar), so the same scenarios can be drawn by the old tree.
 */
const target = process.argv[2]
if (!target) throw new Error("usage: render-activity-scroll-frames.ts <directory> [before|after]")
const stage = process.argv[3] === "before" ? "before" : "after"
const output = path.join(target, stage)
mkdirSync(output, { recursive: true })

type Options = { width: number; height: number; sidebars?: boolean; profile?: Record<string, unknown>; theme?: "mend" | "mend-light" }

/** The turn started at TURN_AT; the clock stands 2 m 53 s later, as in "Running command… 2m 53s". */
const TURN_AT = Date.UTC(2026, 9, 6, 12, 0, 0)
const CLOCK = TURN_AT + 173_000
const LONG = Array.from({ length: 90 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} of the answer: the quick brown fox jumps over the lazy dog and keeps going until the row wraps`).join("\n\n")

function scene({ width, height, sidebars, profile = {} }: Options) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...(sidebars ? { rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.pulse) } : {}), ...profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: tempDir(), width, height, mode: "full", now: () => CLOCK })
  h.app.applySettings({ onboarded: true })
  return h
}

const rows = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain))
/** The prompt's top rule: the row above the first prompt row. */
const ruleRow = (lines: string[]) => lines.findIndex((line) => line.includes("❭")) - 1

function save(name: string, lines: string[], width: number) {
  if (lines.some((line) => textWidth(line) > width)) throw new Error(`overflow: ${name}`)
  writeFileSync(path.join(output, `${name}.txt`), `${lines.map((line) => line.trimEnd()).join("\n")}\n`)
}

/** A finished exchange, then a turn that runs a command: the working row's state. */
async function working(h: Harness) {
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Build the firmware and tell me how it went", "The build finished. Here is the summary of what changed in this run.")
  talk.exchange("Now run the tests", "All of them passed on the first try.")
  // Enough to fill the screen: the view follows the bottom, so a row taken above the prompt would push the text up.
  talk.exchange("Explain the results", Array.from({ length: 40 }, (_, i) => `result ${i + 1}: everything checked out`).join("\n\n"))
  return talk
}

/** A turn that has started and is generating, nothing drawn in the transcript yet: the only change on screen is the working status itself. */
function startTurn(h: Harness) {
  const turnId = ids("turn")
  // The clock of the scripted events is not the harness clock: this turn starts at TURN_AT.
  h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, seq: 900, at: TURN_AT, turnId, queueId: ids("queue") } as never)
  h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 901, at: TURN_AT + 500, state: "generating", turnId } as never)
  h.app.onEvent({ type: "usage.recorded", sessionId: h.sessionId, seq: 902, at: TURN_AT + 2_000, turnId, provider: "p", model: "gpt-6-luna", input: 1_000, output: 1_240, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as never)
  return turnId
}

/** The turn runs a shell command: the card and the "Running command..." phase. */
function runCommand(h: Harness, turnId: string, command: string) {
  h.app.onEvent({ type: "item.started", sessionId: h.sessionId, seq: 903, at: TURN_AT + 3_000, turnId, itemId: ids("item"), kind: "tool_call", meta: { tool: `shell: ${command}` } } as never)
  h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 904, at: TURN_AT + 3_100, state: "tool", turnId } as never)
}

const SIZES = [[60, 24], [80, 24], [120, 40], [200, 50]] as const
const PLACEMENTS = stage === "before" ? ["transcript"] : ["transcript", "above", "inside", "off"]
const shifts: string[] = []

// 1. The activity status. Every placement: idle, then a command running; the shift table says what moved when the turn started.
for (const [width, height] of SIZES) {
  for (const placement of PLACEMENTS) {
    const h = scene({ width, height, sidebars: width >= 200, profile: placement === "transcript" ? {} : { activityPlacement: placement, activityParts: "spinner,verb,elapsed,tps,queue,interrupt" } })
    await working(h)
    const idle = rows(h)
    const turnId = startTurn(h)
    const generating = rows(h)
    runCommand(h, turnId, "bun test apps/cli --timeout 120000")
    const name = `activity-${placement}-${width}x${height}`
    save(`${name}-idle`, idle, width)
    save(`${name}-generating`, generating, width)
    save(`${name}-working`, rows(h), width)
    const last = (lines: string[]) => lines.findLastIndex((line) => /result \d+/.test(line))
    shifts.push(`${name}: idle -> generating: prompt rule row ${ruleRow(idle)} -> ${ruleRow(generating)}, last transcript row ${last(idle)} -> ${last(generating)}`)
  }
}
writeFileSync(path.join(output, "activity-layout-shift.txt"), `${shifts.join("\n")}\n`)

// 1b. The parts, in another order and with a queued prompt.
if (stage === "after") {
  const h = scene({ width: 120, height: 30, profile: { activityPlacement: "above", activityParts: "elapsed,spinner,verb,queue,tps" } })
  await working(h)
  runCommand(h, startTurn(h), "bun test")
  h.app.onEvent({ type: "queue.changed", sessionId: h.sessionId, seq: 950, at: TURN_AT + 3_000, queue: [{ queueId: ids("queue"), preview: "and then lint it", attachments: 0 }] } as never)
  save("activity-parts-reordered-120x30", rows(h), 120)
}

// 2 and 3. Scrolled up in a long session: the jump button and the scrollbar. Full view, sidebars open from 200 columns.
const scrolls: Array<[string, Record<string, unknown>]> = stage === "before"
  ? [["default", {}], ["scrollbar-true", { scrollbar: true }]]
  : [["default", {}], ["scrollbar-auto", { scrollbar: "auto" }], ["scrollbar-always", { scrollbar: "always" }], ["scrollbar-custom-glyphs", { scrollbar: "always", scrollbarGlyphs: "█░" }], ["jump-left", { jumpHint: "left" }], ["jump-center", { jumpHint: "center", jumpText: "{n} below · {key}" }], ["jump-off", { jumpHint: "off" }]]
for (const [width, height] of SIZES) {
  for (const [label, profile] of scrolls) {
    for (const sidebars of width >= 200 ? [false, true] : [false]) {
      const h = scene({ width, height, sidebars, profile })
      await Bun.sleep(10)
      conversation(h.sessionId, h.app.onEvent).exchange("Count for me", LONG)
      h.app.render()
      await h.app.onKey("\x1b[<64;40;10M")
      await h.app.onKey("\x1b[<64;40;10M")
      save(`scroll-${label}-${width}x${height}${sidebars ? "-sidebars" : ""}`, rows(h), width)
    }
  }
}

// Reduced motion and the light theme, one frame each.
if (stage === "after") {
  const light = scene({ width: 100, height: 26, profile: { activityPlacement: "above", scrollbar: "always" } })
  setTheme("paper")
  await working(light)
  runCommand(light, startTurn(light), "bun run build")
  save("activity-above-light-100x26", rows(light), 100)
  setTheme("mend")
}
cleanTemps()
console.log(`frames written to ${output}`)
// A busy turn keeps the spinner's interval alive: the script ends here.
process.exit(0)

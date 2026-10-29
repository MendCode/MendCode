import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { appHarness as extensionHarness, scratch } from "../apps/cli/test/extensions-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { setTheme, sgr, type Line } from "../apps/cli/src/ui/theme"
import { textWidth } from "../apps/cli/src/view/wrap"

/**
 * Real harness frames of the session stats on every surface: the default footer, the footer with the stat parts placed, the top bar,
 * the activity status, the sidebar card and an extension reading api.stats(). Plain text (`.txt`) and with colours (`.ansi`), at 80 and
 * 120 columns, in the dark (`mend`) and light (`paper`) themes. Usage: `render-session-stats-frames.ts <directory>`.
 */
const target = process.argv[2] ?? ""
if (!target) throw new Error("usage: render-session-stats-frames.ts <directory>")
mkdirSync(target, { recursive: true })

const AT = 1_800_000_000_000
const THEMES = [["dark", "mend"], ["light", "paper"]] as const
const SIZES = [[80, 24], [120, 36]] as const
let seq = 100

/** Six calls: a cold first prompt, then the same prefix read from the cache; the window is 100,000 tokens, 21 % in use. */
function calls(h: Harness | { event(body: Record<string, unknown>): void; sessionId: string }, emit: (body: Record<string, unknown>) => void) {
  void h
  const shape: Array<[number, number, number]> = [[19_800, 0, 310], [380, 19_800, 220], [520, 20_100, 450], [610, 20_500, 180], [440, 20_900, 640], [500, 20_300, 260]]
  for (const [input, cacheRead, output] of shape) emit({ type: "usage.recorded", turnId: ids("turn"), provider: "openai", model: "gpt-6-luna", input, output, reasoning: 0, cacheRead, cacheWrite: 0, contextWindow: 100_000 })
}

function save(name: string, lines: Line[], width: number, themeName: string) {
  const text = lines.map(plain)
  if (text.some((line) => textWidth(line) > width)) throw new Error(`overflow: ${name}`)
  const base = path.join(target, name)
  writeFileSync(`${base}.txt`, `${text.map((line) => line.trimEnd()).join("\n")}\n`)
  writeFileSync(`${base}.ansi`, `${lines.map((line) => line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join("")).join("\n")}\n`)
  void themeName
}

async function session({ width, height, profile = {}, settings = {}, mode = "balanced" }: { width: number; height: number; profile?: Partial<TuiProfile>; settings?: Record<string, unknown>; mode?: "balanced" | "full" }) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: tempDir(), width, height, mode, now: () => AT })
  h.app.applySettings({ onboarded: true, ...settings })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Why does the profile store get hit twice?", "Two lookups start before the first one is stored, so both miss. The cache needs to hold the pending promise.")
  calls(h, (body) => h.app.onEvent({ sessionId: h.sessionId, seq: ++seq, at: AT, ...body } as never))
  return h
}
const frame = (h: Harness) => (h.app.render(), h.frames.at(-1)!)

const widths: string[] = []
for (const [label, themeName] of THEMES) {
  setTheme(themeName)
  for (const [width, height] of SIZES) {
    const size = `${width}x${height}-${label}`
    // The footer today (nothing about stats) and the same footer with the cache share placed after it.
    const base = await session({ width, height })
    save(`footer-default-${size}`, frame(base), width, themeName)
    const placed = await session({ width, height, settings: { footer: ["state", "permission", "context", "quota", "notice", "cache"] } })
    save(`footer-default-plus-cache-${size}`, frame(placed), width, themeName)
    const more = await session({ width, height, settings: { footer: ["state", "permission", "context", "quota", "notice", "cache", "ctx", "hit", "calls", "spend"] } })
    save(`footer-all-parts-${size}`, frame(more), width, themeName)
    // Top bar, full view.
    const bar = await session({ width, height, mode: "full", profile: { topbarStats: "cache,ctx" } })
    save(`topbar-stats-${size}`, frame(bar), width, themeName)
    // Activity status while a turn runs, over the prompt rule.
    const busy = await session({ width, height, mode: "full", profile: { activityPlacement: "above", activityParts: "spinner,verb,elapsed,cache,ctx,interrupt" } as never })
    const turnId = ids("turn")
    busy.app.onEvent({ type: "turn.started", sessionId: busy.sessionId, seq: ++seq, at: AT, turnId, queueId: ids("queue") } as never)
    busy.app.onEvent({ type: "foreground.state", sessionId: busy.sessionId, seq: ++seq, at: AT, state: "generating", turnId } as never)
    save(`activity-parts-${size}`, frame(busy), width, themeName)
  }
  // The sidebar card needs the room of a wide terminal.
  const side = await session({ width: 200, height: 40, mode: "full", profile: { rightSidebar: true, sidebarWidgets: [{ type: "stats", title: "Stats", options: {} }] } as never })
  save(`sidebar-stats-200x40-${label}`, frame(side), 200, themeName)
  // The example extension (examples/extensions/cache-ctx.ts) in the footer's right side.
  for (const [width, height] of SIZES) {
    const { dataDir, write, cleanup } = scratch()
    write("data/extensions/cache-ctx.ts", readFileSync(path.join(import.meta.dir, "../examples/extensions/cache-ctx.ts"), "utf8"))
    const h = await extensionHarness({ dataDir, width, height, mode: "full" })
    await h.start()
    h.message("Why does the profile store get hit twice?", "Two lookups start before the first one is stored.")
    calls(h, (body) => h.event(body))
    await Bun.sleep(5)
    h.app.render()
    save(`extension-cache-ctx-${width}x${height}-${label}`, h.frames.at(-1)!, width, themeName)
    cleanup()
  }
}
void widths
cleanTemps()
console.log(`frames written to ${target}`)
// The harness leaves timers behind; the frames are on disk.
process.exit(0)

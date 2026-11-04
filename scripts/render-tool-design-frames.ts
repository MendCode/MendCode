import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "../apps/cli/test/session-ui-harness"
import { customizePreview } from "../apps/cli/src/view/customize-page"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { glyphs } from "../apps/cli/src/ui/theme"
import { textWidth } from "../apps/cli/src/view/wrap"
import type { Line } from "../apps/cli/src/ui/theme"

/**
 * Harness frames of the tool cards and the turn's end: an edit card (its diff tint marked), three shell commands in a row and
 * the turn's closing line, in each tool design and `timestamps` place, plus the `/customize` diff preview. Each file has the
 * plain frame, then the rows with a background, its spans in «». Usage: render-tool-design-frames.ts <directory>.
 */
const target = process.argv[2]
if (!target) throw new Error("usage: render-tool-design-frames.ts <directory>")
const output: string = target
mkdirSync(output, { recursive: true })

const DIFF = ["--- a/src/cart.ts", "+++ b/src/cart.ts", "@@ -12,5 +12,5 @@", " export function total(items: Item[]) {", "-  let sum = 0", "+  let sum = items.reduce((total, item) => total + item.price, 0)", " }", ""].join("\n")
const plain = (frame: Line[]) => frame.map((line) => line.map((span) => span.text).join(""))
const marked = (frame: Line[]) => frame.map((line) => line.map((span) => (span.bg ? `«${span.text}»` : span.text)).join("")).filter((row) => row.includes("«"))

function save(name: string, frame: Line[], width: number) {
  const rows = plain(frame)
  if (rows.some((row) => textWidth(row) > width)) throw new Error(`Overflow: ${name}`)
  writeFileSync(path.join(output, `${name}.txt`), `${rows.map((row) => row.trimEnd()).join("\n")}\n\n--- rows with a background, its spans in «»\n${marked(frame).join("\n")}\n`)
}

async function session({ width, height, mode, profile }: { width: number; height: number; mode: "balanced" | "full"; profile: Partial<TuiProfile> & Record<string, unknown> }) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: tempDir(), width, height, mode })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Fix the total", "Looking at the cart.")
  const turnId = ids("turn")
  talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  const user = ids("item")
  talk.emit({ type: "item.started", turnId, itemId: user, kind: "user_message" })
  talk.emit({ type: "item.completed", itemId: user, status: "ok", text: "Now sum the prices and run the checks" })
  const edit = ids("item")
  talk.emit({ type: "item.started", turnId, itemId: edit, kind: "tool_call", meta: { tool: "edit: src/cart.ts" } })
  talk.emit({ type: "item.completed", itemId: edit, status: "ok", text: DIFF, meta: { tool: "edit: src/cart.ts" } })
  for (const command of ["bun run typecheck", "bun test cart", "git diff --stat"]) {
    const itemId = ids("item")
    talk.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: `shell: ${command}` } })
    talk.emit({ type: "item.completed", itemId, status: "ok", text: "ok", meta: { tool: `shell: ${command}` } })
  }
  const answer = ids("item")
  talk.emit({ type: "item.started", turnId, itemId: answer, kind: "agent_message" })
  talk.emit({ type: "item.completed", itemId: answer, status: "ok", text: "The total now sums the prices; the checks pass." })
  talk.emit({ type: "turn.completed", turnId })
  h.app.render()
  return h.frames.at(-1)!
}

const designs = (process.argv[3] ?? "rail,branch,terse").split(",")
for (const [width, height] of [[100, 30], [200, 60]] as const) {
  for (const mode of ["balanced", "full"] as const) {
    for (const toolDesign of designs) save(`session-${toolDesign}-${mode}-${width}x${height}`, await session({ width, height, mode, profile: { toolDesign } }), width)
    for (const timestamps of ["top", "off"]) save(`session-timestamps-${timestamps}-${mode}-${width}x${height}`, await session({ width, height, mode, profile: { timestamps: timestamps as never } }), width)
  }
  for (const toolDesign of designs) {
    const profile = { ...DEFAULT_TUI_PROFILE, toolDesign } as TuiProfile
    const frame = customizePreview({ profile, preview: { root: "/work", tip: "", now: 0, chatWidth: width }, screenHeight: height, screenWidth: width, width: Math.floor(width / 2), height: 20, glyphs: glyphs({}), surface: "diff" })
    save(`customize-diff-preview-${toolDesign}-${width}x${height}`, frame, Math.floor(width / 2))
  }
}
cleanTemps()
console.log(`frames written to ${output}`)

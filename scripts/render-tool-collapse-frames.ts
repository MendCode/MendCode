import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

/**
 * Real harness frames of the `full` view for the tool-card click and wrapping fixes: a long expanded shell output, the same card
 * after one click on a body row, and the long running command wrapped under its rail. Usage: render-tool-collapse-frames.ts <directory>.
 */
const target = process.argv[2]
if (!target) throw new Error("usage: render-tool-collapse-frames.ts <directory>")
const output: string = target
mkdirSync(output, { recursive: true })

const COMMAND = "cd /Users/user/Code/repos/heltecv4/heltecv4-32bit-windows && bun scripts/build.ts --base-url https://github.com/Obed0101/heltecv4/releases/download/v1"
const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`

async function click(h: Harness, col: number, row: number) {
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  h.app.render()
}

function save(h: Harness, name: string, size: string) {
  h.app.render()
  const rows = h.frames.at(-1)!.map((line) => line.map((span) => span.text).join(""))
  const width = Number(size.split("x")[0])
  if (rows.some((row) => textWidth(row) > width)) throw new Error(`Overflow: ${name} ${size}`)
  writeFileSync(path.join(output, `${name}-${size}.txt`), rows.join("\n") + "\n")
}

for (const [width, height] of [[80, 24], [120, 40]] as const) {
  const size = `${width}x${height}`
  const h = appHarness({ dataDir: tempDir(), directory: tempDir(), width, height, mode: "full" })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Build the firmware", "Running the build.")
  const turnId = ids("turn")
  const itemId = ids("item")
  talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  talk.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: `shell: ${COMMAND}` } })
  h.app.render()
  save(h, "running-command-wrapped", size)
  talk.emit({ type: "item.completed", itemId, status: "ok", text: Array.from({ length: 60 }, (_, i) => `compiling unit ${i + 1}`).join("\n"), meta: { tool: `shell: ${COMMAND}` } })
  talk.emit({ type: "turn.completed", turnId })
  h.app.render()
  save(h, "finished-collapsed", size)
  const head = h.text().findIndex((row) => row.includes("cd /Users"))
  await click(h, 12, head)
  save(h, "expanded", size)
  await h.app.onKey("\x1b[6~")
  h.app.render()
  save(h, "expanded-scrolled-head-off-screen", size)
  await click(h, 14, h.text().findIndex((row) => row.includes("compiling unit")))
  save(h, "after-click-collapsed", size)
}
cleanTemps()
console.log(`frames written to ${output}`)

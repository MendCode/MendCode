import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, type Harness } from "../apps/cli/test/session-ui-harness"
import { UI8_SIZES, ui8Harness } from "../apps/cli/test/ui-8-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import { setTheme } from "../apps/cli/src/ui/theme"
import { createScreen } from "../apps/cli/src/ui/screen"

const directory = process.argv[2]
if (!directory) throw new Error("usage: render-ui8-frames.ts <directory>")
mkdirSync(directory, { recursive: true })
const cursors: Record<string, unknown> = {}
function save(name: string, h: Harness, width: number, height: number) {
  h.app.render()
  const frame = h.frames.at(-1)!
  if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${width}x${height}`)
  const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
  if (rows.some((row) => row.includes("\x1b"))) throw new Error(`ANSI in plain frame ${name}`)
  const key = `${name}-${width}x${height}`
  writeFileSync(path.join(directory!, `${key}.txt`), rows.join("\n") + "\n")
  cursors[key] = h.cursors.at(-1) ?? null
}
async function quit(h: Harness) {
  await h.app.onKey("\x1b")
  await h.app.onKey("\x03")
  await h.app.onKey("\x03")
}
try {
  for (const [width, height] of UI8_SIZES) {
    const usage = ui8Harness(width, height)
    await usage.type("/usage\r")
    save("usage-overview", usage, width, height)
    if (width < 110) {
      await usage.app.onKey("\x1b[6~")
      save("usage-overview-scrolled", usage, width, height)
    }
    await quit(usage)
    for (const large of [false, true]) {
      const h = ui8Harness(width, height, large)
      await h.type("/context\r")
      save(`context-${large ? "large" : "small"}`, h, width, height)
      if (width < 110) {
        await h.app.onKey("\x1b[6~")
        save(`context-${large ? "large" : "small"}-resources`, h, width, height)
        await h.app.onKey("2")
        save(`context-${large ? "large" : "small"}-largest`, h, width, height)
      }
      await quit(h)
    }
    const scratch = ui8Harness(width, height)
    await scratch.type("/scratch\r")
    await scratch.app.onKey("\x1b[H")
    save("tray-scratchpad-long", scratch, width, height)
    await scratch.app.onKey("\x1b[F")
    save("tray-scratchpad-long-end", scratch, width, height)
    await scratch.app.onKey("\x1b")
    save("tray-scratchpad-unfocused", scratch, width, height)
    await quit(scratch)
  }
  const writes: string[] = []
  const screen = createScreen({ columns: 180, rows: 50, write: (data) => writes.push(data) }, { COLORTERM: "truecolor", MENDCODE_MOUSE: "0" })
  const home = ui8Harness(180, 50, false, true, screen)
  await Bun.sleep(5)
  writes.length = 0
  screen.invalidate()
  save("home-terminal", home, 180, 50)
  const ansi = writes.join("")
  if (/(?:38|48);(?:2|5);/.test(ansi)) throw new Error("terminal emitted an extended color")
  writeFileSync(path.join(directory, "home-terminal-180x50.ansi.txt"), ansi)
  await quit(home)
  writeFileSync(path.join(directory, "cursors.json"), JSON.stringify(cursors, null, 2) + "\n")
} finally {
  cleanTemps()
  setTheme("mend")
}

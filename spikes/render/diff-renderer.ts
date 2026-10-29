// B: minimal differential renderer: keeps the previous frame and rewrites only changed rows.
import { fixture, streamTokens, wrap } from "./fixture"

const width = process.stdout.columns ?? 160
const height = process.stdout.rows ?? 45
const frozen: string[] = []
for (const message of fixture()) frozen.push(...wrap(message.text, width), "")
let previous: string[] = []
process.stdout.write("\x1b[?1049h\x1b[?25l")

function draw(frame: string[]) {
  let out = ""
  for (let row = 0; row < height; row++) {
    const line = frame[row] ?? ""
    if (line !== previous[row]) out += `\x1b[${row + 1};1H${line}\x1b[K`
  }
  previous = frame
  if (out) process.stdout.write(out)
}

let text = ""
let scheduled = false
await streamTokens((token) => {
  text += token
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    const liveLines = wrap(text, width)
    const need = Math.max(0, height - liveLines.length)
    draw([...frozen.slice(frozen.length - need), ...liveLines].slice(-height))
  }, 33)
})
process.stdout.write("\x1b[?25h\x1b[?1049l")
process.exit(0)

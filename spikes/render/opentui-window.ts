// A2: OpenTUI draws only the visible window; finished messages are wrapped once and cached.
import { createCliRenderer, TextRenderable } from "@opentui/core"
import { fixture, streamTokens, wrap } from "./fixture"

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
const width = process.stdout.columns ?? 160
const height = process.stdout.rows ?? 45
const view = new TextRenderable(renderer, { content: "", width: "100%", height: "100%" })
renderer.root.add(view)
const frozen: string[] = []
for (const message of fixture()) frozen.push(...wrap(message.text, width), "")
renderer.start()
let text = ""
await streamTokens((token) => {
  text += token
  const liveLines = wrap(text, width)
  const need = Math.max(0, height - liveLines.length)
  view.content = [...frozen.slice(frozen.length - need), ...liveLines].slice(-height).join("\n")
})
renderer.destroy()
process.exit(0)

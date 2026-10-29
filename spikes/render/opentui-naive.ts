// A1: every message mounted as its own TextRenderable inside a ScrollBox (the OpenCode/v1 approach).
import { createCliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { fixture, streamTokens } from "./fixture"

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
const scroll = new ScrollBoxRenderable(renderer, { width: "100%", height: "100%", stickyScroll: true, stickyStart: "bottom", viewportCulling: true })
renderer.root.add(scroll)
for (const message of fixture()) scroll.add(new TextRenderable(renderer, { content: message.text }))
const live = new TextRenderable(renderer, { content: "" })
scroll.add(live)
renderer.start()
let text = ""
await streamTokens((token) => {
  text += token
  live.content = text
})
renderer.destroy()
process.exit(0)

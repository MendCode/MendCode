import { writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, ids, NOW, tempDir } from "../apps/cli/test/session-ui-harness"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB39Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode", reply: (command) => command.type === "audio.play" ? { ok: true, result: { played: true } } : undefined })
    const save = (name: string) => {
      h.app.render()
      const rows = h.text()
      if (rows.length !== height || rows.some((row) => row.includes("\x1b") || textWidth(row) > width)) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), h.frames.at(-1)!.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n") + "\n")
    }
    await h.type("/customize\r")
    for (let row = 0; row < CUSTOMIZE_ROWS.indexOf("activitySound"); row++) await h.app.onKey("\x1b[B")
    save("customize-sound-off")
    await h.app.onKey("\x1b[C")
    save("customize-sound-pulse")
    await h.app.onKey("\x1b[C")
    save("customize-sound-hum")
    await h.app.onKey("\x1b")
    const turnId = ids("turn")
    let seq = 0
    const emit = (event: Record<string, unknown>) => h.app.onEvent({ sessionId: h.sessionId, seq: ++seq, at: NOW, ...event } as Parameters<typeof h.app.onEvent>[0])
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    emit({ type: "foreground.state", state: "generating", turnId })
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "user_message" })
    emit({ type: "item.completed", itemId, status: "ok", text: "Run the focused checks" })
    save("chat-sound-working")
    emit({ type: "turn.completed", turnId })
    emit({ type: "foreground.state", state: "idle" })
    save("chat-sound-complete")
    await h.app.onKey("\x03")
  }
}

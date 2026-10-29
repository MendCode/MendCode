import { conversation, ids, NOW } from "../apps/cli/test/session-ui-harness"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { b73Harness } from "../apps/cli/test/b73-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB73Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error("Invalid B73 frame size")
    const width = Number(match[1]), height = Number(match[2])
    const h = b73Harness({ width, height })
    const save = (name: string, harness = h) => {
      harness.app.render()
      const frame = harness.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`B73 frame overflow: ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error("ANSI in B73 text frame")
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text + "\n")
    }
    try {
      await h.type("/mflow\r")
      save("mflow-disabled")
      await h.type("\r")
      save("mflow-setup")
      await h.type("\r")
      save("mflow-configured")
      await h.type("\x1b[B\r")
      save("mflow-running")
      await h.type("\t")
      save("mflow-details")
      await h.keys("\x1b", "\x1b")
      for (const operation of ["scan", "relay-guide", "plan", "doctor", "legacy-status"]) {
        const scene = b73Harness({ width, height })
        try {
          await scene.type("/mflow activate\r")
          await scene.keys("\x1b")
          await scene.type("/mflow start\r")
          await scene.keys("\x1b")
          await scene.type(`/mflow ${operation}\r`)
          save(`mflow-${operation}`, scene)
        } finally { await scene.app.onKey("\x03") }
      }
      await h.type("/mflow remove\r")
      save("mflow-remove")
      await h.keys("\x1b", "\x1b")
      h.failNext()
      await h.type("/mflow\r")
      save("mflow-error")
      await h.keys("\x1b")
      const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
      chat.exchange("Review room leases", "The coordinator holds a write lease on `src/client/connection.ts`.")
      chat.emit({ type: "turn.started", turnId: ids("turn"), queueId: ids("queue") })
      h.app.onGlobal({ type: "mflow.waiting", sessionId: h.sessionId, gseq: 1, at: NOW, file: "src/client/connection.ts", deadlineAt: NOW + 90_000 })
      save("mflow-waiting-chat")
    } finally { await h.app.onKey("\x03") }
    const reader = b73Harness({ width, height, remote: { host: "127.0.0.1", readOnly: true } })
    try { await reader.type("/mflow\r"); save("mflow-read-only", reader) }
    finally { await reader.app.onKey("\x03") }
  }
}

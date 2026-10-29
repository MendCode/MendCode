import { writeFileSync } from "node:fs"
import path from "node:path"
import { peerCommandsHarness } from "../apps/cli/test/agent-commands-harness"
import { NOW } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB31Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const h = peerCommandsHarness(width, height)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error(`ANSI ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    h.setReport({ ...h.report(), metadata: [{ sessionId: h.target, title: "Client recovery", tags: ["client", "review"] }] })
    await h.type("/agents\r")
    save("agents-metadata")
    await h.type("2")
    save("agents-done")
    await h.type("1")
    h.app.onGlobal({ type: "session.activity", gseq: 0, at: NOW, sessionId: h.target, directory: "/work/mendcode", title: "Client worker", state: "idle", updatedAt: NOW })
    save("agents-empty")
    await h.type("c")
    save("commands-from-agents")
    await h.type("\x1b")
    await h.type("/agents commands\r")
    save("commands-incoming")
    await h.type("j")
    await h.type("j")
    save("commands-outgoing")
    await h.type("j")
    save("commands-control-blocked")
    await h.type("a")
    save("commands-review-error")
    await h.type("r")
    await h.type("2")
    save("commands-history-result")
    await h.type("j")
    save("commands-history-failed")
    await h.type("3")
    save("commands-policy")
    await h.app.onKey("\x1b[6~")
    await h.app.onKey("\x1b[6~")
    save("commands-policy-scrolled")
    h.setReport({ commands: [], metadata: [] })
    await h.type("r")
    await h.type("1")
    save("commands-empty")
    h.setError("Inbox unavailable")
    await h.type("r")
    save("commands-load-error")
    await h.app.onKey("\x03")
  }
}

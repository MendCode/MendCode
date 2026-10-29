import { writeFileSync } from "node:fs"
import path from "node:path"
import { B60_LEFT, B60_RIGHT, b60Harness } from "../apps/cli/test/b60-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB60Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b60Harness(width, height)
    await h.app.extensionsReady
    await Bun.sleep(5)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width) || rows.some((line) => /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    h.app.onGlobal({ type: "tui.changed", gseq: 0, at: 0, profile: { showProject: false } })
    h.status({ leftRows: B60_LEFT, rightRows: B60_RIGHT })
    save("home-status-rows")
    h.chat("Check the footer", "All four rows stay outside the input. Script segments keep their spacing and color.")
    save("chat-status-rows")
    h.status({ leftRows: [[{ text: "long branch: " + "左🙂".repeat(60) }], ...B60_LEFT], rightRows: [[{ text: "checks: " + "passed ".repeat(40) }], ...B60_RIGHT.slice(1)] })
    save("chat-status-clipped")
    h.status({ leftRows: B60_LEFT, rightRows: B60_RIGHT })
    for (const promptChrome of ["minimal", "ascii-box"] as const) {
      h.app.onGlobal({ type: "tui.changed", gseq: 0, at: 0, profile: { showProject: false, promptChrome } })
      save(`chat-prompt-${promptChrome}`)
    }
    h.app.onGlobal({ type: "tui.changed", gseq: 0, at: 0, profile: { showProject: false } })
    h.app.editor.replaceAll(Array(20).fill("draft").join("\n"))
    save("chat-multiline-input")
    h.app.editor.clear()
    await h.type("/customize\r")
    save("customize-status-rows")
    await h.app.onKey("\x1b")
    await h.type("!")
    save("chat-shell")
    await h.app.onKey("\x1b")
    h.status({ left: [{ text: "main · clean" }], right: [{ text: "12:04" }] })
    save("chat-legacy-status")
    await h.app.onKey("\x03")
    await h.app.onKey("\x03")
  }
}

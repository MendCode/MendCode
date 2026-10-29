import { writeFileSync } from "node:fs"
import path from "node:path"
import { b84Harness } from "../apps/cli/test/b84-harness"
import { conversation } from "../apps/cli/test/session-ui-harness"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB84Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = b84Harness(width, height)
    const save = (name: string) => {
      h.app.render()
      const rows = h.text()
      if (rows.length !== height || rows.some((line) => textWidth(line) > width || /[\x00-\x1f]/.test(line))) throw new Error(`invalid frame: ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    await h.app.start()
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Review the transport changes", "The control channel targets one terminal per project. Requests are correlated with their responses.")
    await h.control({ path: "/tui/append-prompt", body: { text: "Check disconnect cleanup" } })
    save("append-prompt")
    for (const [name, route] of [["help", "/tui/open-help"], ["sessions", "/tui/open-sessions"], ["models", "/tui/open-models"], ["themes", "/tui/open-themes"]] as const) {
      await h.control({ path: route, body: {} })
      save(name)
      await h.type("\x1b")
    }
    await h.control({ path: "/tui/show-toast", body: { title: "Control", message: "Prompt appended", variant: "success", duration: 5000 } })
    save("toast")
    await h.control({ path: "/tui/open-help", body: {} }); await h.type("\x1b")
    await h.control({ path: "/tui/clear-prompt", body: {} })
    save("clear-prompt")
    await h.control({ path: "/tui/publish", body: { type: "tui.prompt.append", properties: { text: "Review the lifecycle tests" } } })
    save("publish-prompt")
    await h.control({ path: "/tui/submit-prompt", body: {} })
    save("submit-prompt")
    await h.control({ path: "/tui/select-session", body: { sessionID: h.second } })
    save("select-session")
    h.app.editor.clear()
    await h.type("\x03")
  }
}

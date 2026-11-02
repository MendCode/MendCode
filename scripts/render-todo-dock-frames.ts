import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, plain } from "../apps/cli/test/session-ui-harness"
import { DEFAULT_TUI_PROFILE } from "../apps/cli/src/view/tui-profile"
import { setTheme } from "../apps/cli/src/ui/theme"
import { renderSvg } from "./readme-images"

const target = process.argv[2] ?? "task-evidence/todo-row-dock/frames"
mkdirSync(target, { recursive: true })
const list = "[x] Inspect the existing views\n[~] Implementar sobres v2 y bloques de contenido conservando los estados y los controles existentes para todas las terminales\n[ ] Verify light and dark themes\n[ ] Run the full test suite"
for (const theme of ["mend", "paper"]) for (const [width, height] of [[80, 30], [100, 30], [200, 60]] as const) for (const mode of ["balanced", "minimal"] as const) {
  if (!setTheme(theme)) throw new Error(`Unknown theme: ${theme}`)
  const h = appHarness({ width, height, mode, hostProfile: { ...DEFAULT_TUI_PROFILE, theme, sidebar: "hidden" } })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Make the task list readable without the extra progress row", "I will keep the plan in the transcript and Todos dock.")
  const turnId = ids("turn"), itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "todo" } })
  chat.emit({ type: "item.completed", turnId, itemId, status: "ok", text: list, meta: { tool: "todo 1/4", retitled: true } })
  chat.emit({ type: "foreground.state", turnId, state: "generating" })
  for (const dock of [false, true]) {
    if (dock) await h.type("\x14")
    h.app.render()
    const frame = h.frames.at(-1)!
    const name = `${theme}-${mode}-${width}x${height}-${dock ? "dock" : "closed"}`
    writeFileSync(path.join(target, `${name}.txt`), frame.map(plain).join("\n") + "\n")
    writeFileSync(path.join(target, `${name}.svg`), renderSvg({ frame, title: name, columns: width, rows: height }))
  }
}
cleanTemps()
console.log(`Wrote real app-harness frames to ${target}`)
// Busy fixtures keep the spinner interval alive; all artifacts have been written synchronously.
process.exit(0)

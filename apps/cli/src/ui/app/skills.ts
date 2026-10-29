import type { SkillsReport } from "@mendcode/protocol"
import { createSkillsState, skillOptions } from "../lazy-pages"
import type { AppContext } from "./context"
export function createSkills(ctx: AppContext, actions: { loadPage(): Promise<void> }) {
  const { input, state, editor, requestFrame } = ctx
  let serial = 0
  async function openSkills() {
    await actions.loadPage()
    const visit = ++serial
    state.page = "skills"
    state.skillsState = createSkillsState()
    state.skillsReport = undefined
    state.skillsError = ""
    requestFrame()
    const reply = await input.send({ type: "skills.list", directory: input.directory ?? "." })
    if (visit !== serial || state.page !== "skills") return
    if (reply.ok) state.skillsReport = reply.result as SkillsReport
    else state.skillsError = reply.error.message
    requestFrame()
  }
  async function skillsKey(key: string) {
    const s = state.skillsState
    const options = skillOptions(state.skillsReport, s.query)
    const skill = options[s.selected]
    if (key === "\x1b") {
      if (s.body) { delete s.body; s.scroll = 0 }
      else { serial++; state.page = "chat" }
    } else if (s.body) {
      if (key === "\x1b[A") s.scroll = Math.max(0, s.scroll - 1)
      if (key === "\x1b[B") s.scroll++
    } else if (["\x1b[A", "\x10"].includes(key)) s.selected = Math.max(0, s.selected - 1)
    else if (["\x1b[B", "\x0e"].includes(key)) s.selected = Math.min(Math.max(0, options.length - 1), s.selected + 1)
    else if (skill && (key === "\r" || key === " " || key === "\x0c")) {
      const visit = ++serial
      const reply = await input.send(key === "\x0c" ? { type: "skills.load", directory: input.directory ?? ".", name: skill.name } : { type: "skills.set", directory: input.directory ?? ".", name: skill.name, enabled: !skill.enabled })
      if (visit !== serial || state.page !== "skills") return
      if (!reply.ok) state.skillsError = reply.error.message
      else if (key === "\x0c") s.body = String(reply.result?.body ?? "")
      else { state.skillsReport = reply.result as SkillsReport; state.skillsError = "" }
    } else if (key === "\t" && skill?.enabled) { editor.insert(skill.disableModelInvocation ? `/${skill.name} ` : `Use the skill tool to load "${skill.name}", then follow its instructions. `); serial++; state.page = "chat" }
    else if (key === "\x7f" || key === "\b") { s.query = Array.from(s.query).slice(0, -1).join(""); s.selected = 0 }
    else if (!/[\x00-\x1f\x7f]/.test(key)) { s.query = (s.query + key).slice(0, 100); s.selected = 0 }
    requestFrame()
  }
  return { openSkills, skillsKey }
}

import type { GlobalEvent, TuiPublish, TuiRequestInput } from "@mendcode/protocol"
import { MAX_DRAFT_CHARS } from "@mendcode/protocol/wire"
import type { BindingAction } from "../keymap"
import { KEY_ACTIONS } from "../keymap"
import type { AppContext } from "./context"

const commands: Record<string, BindingAction> = {
  "help.show": "help", "session.list": "sessions", "session.new": "new",
  "session.compact": "compact", "session.share": "command:share", "agent.cycle": "agent.next",
  "session.page.up": "scroll.up", "session.page.down": "scroll.down",
  "session.line.up": "scroll.line-up", "session.line.down": "scroll.line-down",
  "session.half.page.up": "scroll.half-up", "session.half.page.down": "scroll.half-down",
  "session.first": "scroll.top", "session.last": "scroll.bottom",
}
const aliases: Record<string, string> = {
  session_new: "session.new", session_share: "session.share", session_interrupt: "session.interrupt",
  session_compact: "session.compact", messages_page_up: "session.page.up", messages_page_down: "session.page.down",
  messages_line_up: "session.line.up", messages_line_down: "session.line.down", messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down", messages_first: "session.first", messages_last: "session.last", agent_cycle: "agent.cycle",
}

export function createTuiControl(ctx: AppContext, actions: {
  runKeyAction(action: BindingAction): Promise<void>
  openThemes(): Promise<void>
  restoreTheme(): void
  openModels(): Promise<void>
  switchSession(sessionId: import("@mendcode/protocol").SessionId): Promise<void>
  submit(): Promise<void>
  syncDraft(): void
  syncMentions(): void
}) {
  const { input, state, editor, toasts, requestFrame } = ctx
  let enabled = false
  let ownedDirectory = ""
  let chain = Promise.resolve()
  const directory = () => input.directory ?? ""
  const promptAvailable = () => state.page === "chat" && !state.editingScratch && !state.editingGoal && !state.editingMemory && !state.planDraft
  function changedPrompt() { state.suggestion = 0; actions.syncMentions(); actions.syncDraft(); requestFrame() }
  function dismissPalette() {
    actions.restoreTheme()
    state.palette = undefined
  }

  async function command(value: string): Promise<boolean> {
    const name = aliases[value] ?? value
    if (name === "theme.list") { dismissPalette(); await actions.openThemes(); return true }
    if (name === "model.list") { dismissPalette(); await actions.openModels(); return true }
    if (name === "prompt.clear") {
      if (!promptAvailable()) return false
      editor.clear()
      state.attachments = []
      state.shellMode = false
      state.pastes = []
      changedPrompt()
      return true
    }
    if (name === "prompt.submit") {
      if (!promptAvailable()) return false
      await actions.submit()
      changedPrompt()
      return true
    }
    if (name === "session.interrupt") {
      const turnId = state.transcript.activeTurn
      if (turnId) ctx.report(await input.send({ type: "turn.cancel", sessionId: state.sessionId, turnId }))
      return true
    }
    const action = commands[name] ?? (KEY_ACTIONS.includes(name as typeof KEY_ACTIONS[number]) ? name as BindingAction : undefined)
    if (!action) return false
    dismissPalette()
    const draft = editor.text
    await actions.runKeyAction(action)
    if (action === "help" || action === "sessions") editor.replaceAll(draft)
    return true
  }
  async function publish(event: TuiPublish): Promise<boolean> {
    switch (event.type) {
      case "tui.prompt.append": {
        if (!promptAvailable()) return false
        const text = event.properties.text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
        if (editor.text.length + text.length > MAX_DRAFT_CHARS) return false
        editor.insert(text)
        editor.action("buffer-end")
        changedPrompt()
        return true
      }
      case "tui.command.execute": return command(event.properties.command)
      case "tui.toast.show":
        state.toastPage = state.page
        toasts.show({ message: event.properties.message, variant: event.properties.variant, ...(event.properties.title !== undefined ? { title: event.properties.title } : {}) }, event.properties.duration)
        return true
      case "tui.session.select":
        dismissPalette()
        await actions.switchSession(event.properties.sessionID)
        return state.sessionId === event.properties.sessionID
    }
  }
  async function apply(request: TuiRequestInput): Promise<boolean> {
    switch (request.path) {
      case "/tui/append-prompt": return publish({ type: "tui.prompt.append", properties: request.body })
      case "/tui/show-toast": return publish({ type: "tui.toast.show", properties: request.body })
      case "/tui/select-session": return publish({ type: "tui.session.select", properties: request.body })
      case "/tui/execute-command": return command(request.body.command)
      case "/tui/publish": return publish(request.body)
      case "/tui/open-help": return command("help.show")
      case "/tui/open-sessions": return command("session.list")
      case "/tui/open-models": return command("model.list")
      case "/tui/open-themes": return command("theme.list")
      case "/tui/submit-prompt": return command("prompt.submit")
      case "/tui/clear-prompt": return command("prompt.clear")
    }
  }
  return {
    async register() {
      if (!input.tuiControl || input.remote?.readOnly || !directory()) return
      if (enabled && ownedDirectory && ownedDirectory !== directory()) await input.send({ type: "tui.control.register", directory: ownedDirectory, enabled: false })
      enabled = true
      ownedDirectory = directory()
      const reply = await input.send({ type: "tui.control.register", directory: directory(), enabled: true })
      enabled = reply.ok
      if (!reply.ok) ctx.fail(reply.error.message)
    },
    async stop() {
      if (!enabled) return
      enabled = false
      await input.send({ type: "tui.control.register", directory: ownedDirectory, enabled: false })
    },
    onGlobal(event: GlobalEvent) {
      if (event.type !== "tui.control.request") return undefined
      if (!enabled || event.directory !== ownedDirectory) return Promise.resolve()
      chain = chain.then(async () => {
        let response = false
        if (enabled && event.directory === directory()) try { response = await apply(event.request) } catch { response = false }
        requestFrame()
        await input.send({ type: "tui.control.response", directory: event.directory, requestID: event.requestID, response })
      }).catch(() => {})
      return chain
    },
  }
}

import { PROMPT_FOCUS_CHOICES, PROMPT_MODES, promptCostLine, promptCostOf, promptCostWarning, type PromptStatus, type PromptMode } from "@mendcode/protocol/wire"
import { createPromptModeState } from "../lazy-pages"
import type { AppContext, Page } from "./context"

export function createPromptMode(ctx: AppContext, actions: { loadPage(): Promise<void> }) {
  const { input, state, requestFrame, fail } = ctx
  let serial = 0
  let parent: Page = "chat"
  const directory = () => input.directory ?? "."
  // `auto` follows the session's model, so the status is asked about the model this session is using now.
  const statusQuery = () => ({ type: "prompt.status" as const, directory: directory(), ...(state.effectiveModel?.model ? { modelID: state.effectiveModel.model } : {}) })
  async function refreshReport() {
    const reply = await input.send(statusQuery())
    if (reply.ok && reply.result) state.promptReport = reply.result as PromptStatus
  }
  /** After a choice: what the mode costs on every call for this session's model, and for `guide` and `full` that it is sent each time. Never blocks. */
  function noticeCost(report: PromptStatus | undefined) {
    if (!report) return
    const line = promptCostLine(promptCostOf(report, report.mode))
    const warning = promptCostWarning(report.mode)
    if (line) state.notice = warning ? `${line} · ${warning}` : line
  }
  async function loadPromptMode() {
    const visit = ++serial
    const reply = await input.send(statusQuery())
    if (visit !== serial) return
    if (reply.ok && reply.result) {
      state.promptReport = reply.result as PromptStatus
      state.promptError = ""
    }
    else state.promptError = reply.ok ? "Prompt status unavailable" : reply.error.message
    requestFrame()
  }
  async function openPromptMode(args = "") {
    if (args) {
      if (args === "cycle") {
        const reply = await input.send({ type: "prompt.cycle", directory: directory() })
        if (reply.ok) { state.promptReport = reply.result as PromptStatus; await refreshReport(); noticeCost(state.promptReport) }
        else fail(reply.error.message)
      } else if (PROMPT_MODES.includes(args as PromptMode)) {
        const reply = await input.send({ type: "prompt.set", directory: directory(), mode: args as PromptMode })
        if (reply.ok) { state.promptReport = reply.result as PromptStatus; await refreshReport(); noticeCost(state.promptReport) }
        else fail(reply.error.message)
      } else fail("usage: /prompt-mode minimal|focus|guide|full|custom|cycle")
      requestFrame()
      return
    }
    await actions.loadPage()
    parent = state.page === "setup" || state.page === "customize" ? state.page : "chat"
    state.page = "prompt-mode"
    state.promptModeState = createPromptModeState()
    state.promptReport = undefined
    state.promptError = ""
    requestFrame()
    await loadPromptMode()
    const current = state.promptReport as PromptStatus | undefined
    if (current && state.page === "prompt-mode") state.promptModeState.selected = Math.max(0, current.available.indexOf(current.mode))
    requestFrame()
  }
  async function promptModeKey(key: string) {
    const s = state.promptModeState!
    const options = s.tab === "mode" ? state.promptReport?.available ?? [] : PROMPT_FOCUS_CHOICES
    if (key === "\x1b") {
      serial++
      state.page = parent
    } else if (key === "\t" || key === "1" || key === "2") {
      s.tab = key === "1" ? "mode" : key === "2" ? "focus" : s.tab === "mode" ? "focus" : "mode"
      s.selected = 0
    }
    else if (["\x1b[A", "\x1bOA", "\x10", "k"].includes(key)) s.selected = Math.max(0, s.selected - 1)
    else if (["\x1b[B", "\x1bOB", "\x0e", "j"].includes(key)) s.selected = Math.min(Math.max(0, options.length - 1), s.selected + 1)
    else if (key === "r") {
      await loadPromptMode()
      s.selected = Math.min(s.selected, Math.max(0, (s.tab === "mode" ? state.promptReport?.available.length ?? 0 : PROMPT_FOCUS_CHOICES.length) - 1))
    }
    else if (key === "c" || (key === "\r" || key === " ") && options[s.selected]) {
      const visit = ++serial
      const reply = await input.send(key === "c" ? { type: "prompt.cycle", directory: directory() } : { type: "prompt.set", directory: directory(), ...(s.tab === "mode" ? { mode: options[s.selected] as PromptMode } : { focusID: PROMPT_FOCUS_CHOICES[s.selected]! }) })
      if (visit !== serial || state.page !== "prompt-mode") return
      if (reply.ok) {
        state.promptReport = reply.result as PromptStatus
        await refreshReport()
        if (s.tab === "mode") noticeCost(state.promptReport)
        state.promptError = ""
        if (key === "c" && s.tab === "mode") s.selected = Math.max(0, state.promptReport.available.indexOf(state.promptReport.mode))
        if (key !== "c") {
          serial++
          state.page = parent
        }
      } else state.promptError = reply.error.message
    }
    requestFrame()
  }
  return { openPromptMode, promptModeKey, loadPromptMode }
}

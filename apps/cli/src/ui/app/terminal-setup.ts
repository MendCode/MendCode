import { configLines, createTerminalSetupState, detectTerminal, terminalGuides } from "../lazy-pages"
import { isMac } from "../key-labels"
import { applyConfigEdit, canApply, nodeConfigFiles, planConfigEdit, type ConfigEnvironment, type ConfigPlan } from "../terminal-config"
import type { AppContext } from "./context"

/**
 * `/terminal-setup`: shows how to make Shift+Enter a newline for this terminal and what the terminal sends for a key pressed on the page.
 * On a Mac it also shows how to make Option send Alt (tab switches between the two), and the key check tells the two outcomes apart.
 * For kitty, Ghostty and Alacritty `a` adds the shown line to the terminal's config file: it asks first (`y` writes, any other key cancels),
 * never changes a line that is there, and says how to reload.
 */
export function createTerminalSetup(ctx: AppContext, actions: { loadPage(): Promise<void> }) {
  const { state, env, requestFrame, input } = ctx
  /** The plan the confirmation is asking about; the write uses it only if the files still read the same. */
  let pending: { plan: Extract<ConfigPlan, { kind: "write" }>; kind: ReturnType<typeof detectTerminal>["kind"]; topic: "option" | "enter" } | undefined

  async function openTerminalSetup() {
    await actions.loadPage()
    state.terminalSetupState = createTerminalSetupState(input.platform)
    state.page = "terminal-setup"
    requestFrame()
  }

  const environment = (): ConfigEnvironment | undefined => input.terminalConfig ? { home: input.terminalConfig.home, env, platform: input.platform, files: input.terminalConfig.files ?? nodeConfigFiles } : undefined
  const shown = (file: string) => {
    const home = input.terminalConfig?.home
    return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
  }

  /** `a`: read the files, then ask (a write), or say at once why nothing will be written. */
  function offerApply(s: NonNullable<typeof state.terminalSetupState>) {
    const context = environment()
    const guide = terminalGuides(detectTerminal(env))[s.guide]
    if (!context || !guide || !canApply(guide.kind)) return false
    const topic = isMac(input.platform) && s.topic === "option" ? "option" : "enter"
    const plan = planConfigEdit({ kind: guide.kind, topic, lines: configLines(guide.kind, topic), context })
    delete s.lastKey
    if (plan.kind === "write") {
      pending = { plan, kind: guide.kind, topic }
      s.apply = { stage: "confirm", file: shown(plan.file), lines: plan.lines, created: plan.created }
    } else if (plan.kind === "present") s.apply = { stage: "info", text: `${shown(plan.file)} already has this setting. ${plan.reload}` }
    else s.apply = { stage: "error", text: plan.file ? `${shown(plan.file)} ${plan.reason}` : plan.reason }
    return true
  }

  function confirmApply(s: NonNullable<typeof state.terminalSetupState>) {
    const context = environment()
    const chosen = pending
    pending = undefined
    if (!context || !chosen) return void delete s.apply
    const done = applyConfigEdit({ kind: chosen.kind, topic: chosen.topic, plan: chosen.plan, context })
    s.apply = done.ok
      ? { stage: "done", text: `Added to ${shown(chosen.plan.file)}. ${chosen.plan.reload}` }
      : { stage: "error", text: done.reason }
  }

  function terminalSetupKey(key: string) {
    const s = state.terminalSetupState ??= createTerminalSetupState(input.platform)
    const count = terminalGuides(detectTerminal(env)).length
    if (s.apply?.stage === "confirm") {
      if (key === "y" || key === "Y") confirmApply(s)
      else { pending = undefined; s.apply = { stage: "info", text: "Cancelled: nothing was written." } }
      return requestFrame()
    }
    // An outcome stays until the next key, which then does its usual job.
    if (s.apply) delete s.apply
    if (key === "\x1b") state.page = "chat"
    else if (key === "a" && offerApply(s)) { /* the page now asks, or says why not */ }
    else if (key === "\x1b[A" || key === "\x1bOA") s.guide = (s.guide + count - 1) % count
    else if (key === "\x1b[B" || key === "\x1bOB") s.guide = (s.guide + 1) % count
    else if (key === "\t" && isMac(input.platform)) {
      if (s.topic) delete s.topic
      else s.topic = "option"
      delete s.lastKey
    }
    else s.lastKey = key
    requestFrame()
  }

  return { openTerminalSetup, terminalSetupKey }
}

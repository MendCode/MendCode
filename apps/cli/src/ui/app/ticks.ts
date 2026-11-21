import { HOME_WORKING, inProject } from "../../view/project-scope"
import { needsTick, workflowsNeedTick } from "../lazy-pages"
import { topbarAnimates } from "../../view/topbar"
import { PROMPT_MARGIN } from "../../view/prompt-chrome"
import type { AppContext } from "./context"
import { BUSY } from "./constants"
import { stripTasks } from "../../view/agents-strip"
import { sessionDisplayTitle } from "./display-title"
import { sidebarListsAll } from "../../view/tui-profile"

/** The spinner tick while this chat (or what is open in it) works. */
export const PULSE_MS = 125
/** The tick while only other sessions work: their rows in the list or the home's Agent View. */
export const PULSE_OTHERS_MS = 500

export function createTicks(ctx: AppContext, actions: {
  chatWidth: () => number
  sessionTitle: () => string
  sidebarShown: (width: number) => boolean
  render: () => void
}) {
  const { state, schedule } = ctx
  const { chatWidth, sessionTitle, sidebarShown, render } = actions

  function syncPulse() {
    const busy =BUSY.has(state.transcript.foreground) || state.transcript.foreground === "waiting_approval" || state.turnState.retry !== undefined
    const preview = state.page === "settings" && state.settingsPageState.row < 5
    // The appearance sample uses the same bounded pulse as a busy turn.
    // Sub-agents under an idle session keep the strip's spinner and clocks moving, until the last one that just ended has left it.
    const agents = state.page === "chat" && state.liveTasks !== undefined && stripTasks(state.liveTasks, Date.now()).length > 0
    // The home's Agent View: its spinners and clocks move while a session of this project works elsewhere.
    const home = state.page === "chat" && state.transcript.blocks().length === 0 && [...state.agentSessions.values()].some((s) => HOME_WORKING.has(s.state) && inProject(s.directory, ctx.input.directory))
    // A sub-agent's thread open in the chat's place: its own working row moves while that agent runs.
    const thread = state.page === "chat" && state.agentView !== undefined && (state.agentRoot ?? state.transcript).agentThreads().some((each) => each.itemId === state.agentView && each.running)
    // A PR review of the open session's watch: its activity status and running step move until the run ends (nothing at rest).
    // `/reviews` with a review running turns the same spinner on its running rows.
    const reviewing = state.page === "chat" && state.reviewActivity.some((job) => job.sessionId === state.sessionId) || state.page === "reviews" && state.reviewActivity.length > 0
    // The sessions sidebar shows another session of this project running or waiting for approval: its row's symbol moves on this same tick.
    const listed = state.page === "chat" && (state.sessions ?? []).some((s) => (BUSY.has(s.state) || s.state === "waiting_approval") && (s.directory === (ctx.input.directory ?? "") || sidebarListsAll(state.tuiProfile.sidebarProjects, state.settingsNow.experimental?.bots === true))) && sidebarShown(ctx.input.screen.size.width)
    const near = busy || preview || agents || thread || reviewing
    const wanted = (near || home || listed) && !state.reducedMotion
    // Only other sessions working (the list's rows, the home's Agent View): their symbols turn at a quarter of the speed. Each tick
    // redraws the whole screen, so a list of busy chats no longer keeps the terminal drawing 8 frames a second for a chat at rest.
    const every = near ? PULSE_MS : PULSE_OTHERS_MS
    if (state.pulse && (!wanted || every !== pulseMs)) {
      clearInterval(state.pulse)
      state.pulse = undefined
      if (!wanted) state.pulseOn = true
    }
    if (wanted && !state.pulse) {
      pulseMs = every
      const steps = PULSE_MS * 4 / every
      state.pulse = setInterval(() => {
        state.spinFrame++
        if (state.spinFrame % steps === 0) state.pulseOn = !state.pulseOn
        requestFrame()
      }, every)
    }
  }
  let pulseMs = 0

  /** The top bar title scrolls one cell per 350 ms; the timer lives only while a title overflows its box. */
  function syncTopbarTick() {
    const wanted = state.page === "chat" && state.mode !== "minimal" && !state.reducedMotion && state.transcript.blocks().length > 0 && topbarAnimates({ width: chatWidth() - PROMPT_MARGIN * 2, title: sessionDisplayTitle(state, sessionTitle()) })
    if (wanted && !state.topbarTimer)
      state.topbarTimer = setInterval(() => {
        state.topbarTick++
        requestFrame()
      }, 350)
    if (!wanted && state.topbarTimer) {
      clearInterval(state.topbarTimer)
      state.topbarTimer = undefined
      state.topbarTick = 0
    }
  }

  function syncLoopsTick() {
    // `/reviews` with a review running and reduced motion (no pulse): its live time moves once a second until the run ends.
    const wanted = state.page === "loops" && needsTick(state.loops) || state.page === "reviews" && state.reviewActivity.length > 0 && state.reducedMotion
    if (wanted && !state.loopsTick) state.loopsTick = setInterval(requestFrame, 1_000)
    if (!wanted && state.loopsTick) {
      clearInterval(state.loopsTick)
      state.loopsTick = undefined
    }
  }

  function syncWorkflowsTick() {
    const wanted = state.page === "workflows" && workflowsNeedTick(state.workflows)
    if (wanted && !state.workflowsTick) state.workflowsTick = setInterval(requestFrame, 1_000)
    if (!wanted && state.workflowsTick) {
      clearInterval(state.workflowsTick)
      state.workflowsTick = undefined
    }
  }

  /** Keeps the usage page's Clock widget from going stale on an otherwise-idle page, without an unbounded timer. */
  function syncUsageTick() {
    const wanted = state.page === "usage" && state.usageState.tab === 0 && state.usageState.widgetIndex === undefined && state.usageState.weatherInput === undefined && state.tuiProfile.usageWidgets.includes("clock") && state.tuiProfile.usageClock
    if (wanted && !state.usageTick) state.usageTick = setInterval(requestFrame, 60_000)
    if (!wanted && state.usageTick) {
      clearInterval(state.usageTick)
      state.usageTick = undefined
    }
  }

  /** The background row over the prompt shows run times; they keep counting while the session is otherwise idle. */
  function syncBackgroundTick() {
    const wanted = state.page === "chat" && state.agentShells.some((shell) => shell.status === "running" && shell.sessionId === state.sessionId)
    if (wanted && !state.backgroundTick) state.backgroundTick = setInterval(requestFrame, 1_000)
    if (!wanted && state.backgroundTick) {
      clearInterval(state.backgroundTick)
      state.backgroundTick = undefined
    }
  }

  function requestFrame() {
    if (state.frameScheduled) return
    state.frameScheduled = true
    schedule(render)
  }

  return { syncPulse, syncTopbarTick, syncLoopsTick, syncWorkflowsTick, syncUsageTick, syncBackgroundTick, requestFrame }
}

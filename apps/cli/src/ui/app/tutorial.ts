import { createSandbox, createTour } from "../lazy-pages"
import type { TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"

/**
 * `/tutorial`: learn by doing. The page shows a lesson rail beside a practice chat that is the real terminal app wired to a
 * scripted engine (src/tutorial): nothing it does reaches the daemon, a model, the network or a file of the user's. This
 * module owns the tour's life (open, key routing, progress, close); the rules of each lesson live in src/tutorial/lessons.ts.
 *
 * `/tutorial` resumes after the lessons already done, `/tutorial restart` begins again, `/tutorial all` includes the lessons
 * the user's tier or terminal would leave out.
 */
export function createTutorial(ctx: AppContext, actions: { loadPage(): Promise<void>; changeProfile(patch: Partial<TuiProfile>): void }) {
  const { state, input, requestFrame, now } = ctx
  let chain: Promise<void> = Promise.resolve()

  function closeTutorial() {
    const tour = state.tutorialState
    state.tutorialState = undefined
    if (state.page === "tutorial") state.page = "chat"
    tour?.dispose()
    requestFrame()
  }

  async function openTutorial(args = "") {
    await actions.loadPage()
    state.tutorialState?.dispose()
    const option = args.trim().toLowerCase()
    const saved = state.tuiProfile.tutorialDone.split(",").filter(Boolean)
    const { tier, view } = state.settingsNow
    const tour = createTour({
      bindings: state.bindings,
      tier,
      profile: state.tuiProfile,
      glyphs: ctx.glyphs,
      mode: state.mode,
      reducedMotion: state.reducedMotion,
      accessible: state.accessible,
      width: input.screen.size.width,
      done: option === "restart" ? [] : saved,
      all: option === "all",
      settings: { ...(tier ? { tier } : {}), ...(view ? { view } : {}) },
      now,
      onChange: requestFrame,
      onExit: closeTutorial,
      onProgress: (done) => actions.changeProfile({ tutorialDone: done.join(",") }),
      makeSandbox: createSandbox,
    })
    state.tutorialState = tour
    await tour.start()
    state.page = "tutorial"
    requestFrame()
  }

  /** Keys reach the tour one at a time, in order, even while an earlier one (a `show me`, a streamed answer) is still being handled. */
  function tutorialPageKey(key: string): Promise<void> {
    const tour = state.tutorialState
    if (!tour) { state.page = "chat"; requestFrame(); return Promise.resolve() }
    chain = chain.then(() => tour.key(key)).catch((error) => ctx.fail(`tutorial: ${error instanceof Error ? error.message : String(error)}`)).then(() => requestFrame())
    return chain
  }

  return { openTutorial, tutorialPageKey, closeTutorial }
}

import { parsePrCommand, parsePrReviewCommand, prSections, prSummary, type PrReviewAction, type PrWatchRow } from "../../view/pr-watch"
import { effectiveSettings, type ExperimentalFlag } from "@mendcode/protocol/wire"
import { createTextPageState } from "../lazy-pages"
import type { Settings } from "@mendcode/protocol"
import type { AppContext } from "./context"

const TITLE = "Pull requests"

/** The switches `/pr on|off` turns together: one PR watched and the repository reviewer. */
const PR_FLAGS: readonly ExperimentalFlag[] = ["pr_watch", "pr_review"]

/** `/pr`: the daemon polls linked pull requests through `gh` and wakes the session on a change (docs/pr-watch.md). */
export function createPrWatchCommand(ctx: AppContext, actions: { setFlags(names: readonly ExperimentalFlag[], next: boolean): Promise<boolean> }) {
  const { input, state, requestFrame, fail, say } = ctx

  /** `/pr review|watch-repo|unwatch-repo|repos|publish` (docs/pr-review.md): the daemon's PR reviewer answers in one line. */
  async function reviewCommand(command: { action: PrReviewAction; pr?: string; role?: "all" | "requested" }) {
    if (input.remote) return fail("pr: the reviewer runs gh on the daemon's own machine, so this works only from a local session")
    if (!state.sessionId) return fail("pr: no session yet")
    const reply = await input.send({ type: "pr.review", sessionId: state.sessionId, action: command.action, ...(command.pr ? { pr: command.pr } : {}), ...(command.role ? { role: command.role } : {}) })
    if (!reply.ok) return fail(`pr: ${reply.error.message.replace(/^\[[A-Z-]+\]:\s*/, "")}`)
    say(String(reply.result?.text ?? "done"), "success", { title: "PR review" })
    return requestFrame()
  }

  /** The tier only permits these features; their own experimental flags, as the daemon has them now, are what turn them on. */
  async function bothOff() {
    const reply = await input.send({ type: "settings.get" })
    const settings = reply.ok ? reply.result?.settings as Settings | undefined : undefined
    if (!settings) return false
    const flags = effectiveSettings(settings, { safeMode: input.safeMode }).experimental as Record<string, unknown> | undefined
    return !PR_FLAGS.some((flag) => flags?.[flag] === true)
  }

  async function prCommand(args: string) {
    const word = args.trim().toLowerCase()
    if (word === "on" || word === "off") {
      await actions.setFlags(PR_FLAGS, word === "on")
      return requestFrame()
    }
    if (!word && await bothOff()) return say("pull request tools are off · /pr on turns on watching and the reviewer (they run gh and spend model calls) · Tab after /pr lists every word", "info")
    const review = parsePrReviewCommand(args)
    if (review && !review.ok) return say(review.error, "warning")
    if (review) return reviewCommand(review)
    const parsed = parsePrCommand(args)
    if (!parsed.ok) return say(parsed.error, "warning")
    // gh runs on the daemon's machine and reads that checkout: a remote client has nothing to ask.
    if (input.remote) return fail("pr: gh runs on the daemon's own machine, so this works only from a local session")
    if (!state.sessionId) return fail("pr: no session yet")
    const { action, pr } = parsed.command
    if (action !== "unwatch") {
      state.textPage = createTextPageState({ title: TITLE, status: "loading", hint: "asking gh…" })
      state.page = "text"
      requestFrame()
    }
    const reply = await input.send({ type: "pr.watch", sessionId: state.sessionId, action, ...(pr ? { pr } : {}) })
    const open = state.page === "text" && state.textPage?.title === TITLE
    if (!reply.ok) {
      const message = reply.error.message.replace(/^\[[A-Z-]+\]:\s*/, "")
      if (action === "unwatch" || !open) return fail(`pr: ${message}`)
      state.textPage = createTextPageState({ title: TITLE, status: "error", error: message })
      return requestFrame()
    }
    const text = String(reply.result?.text ?? "")
    const watches = (Array.isArray(reply.result?.watches) ? reply.result.watches : []) as PrWatchRow[]
    if (action === "unwatch") {
      say(text, "success")
      return requestFrame()
    }
    if (!open) return say(action === "watch" ? "watching" : "pull requests read", "success")
    state.textPage = createTextPageState({ title: TITLE, summary: prSummary(watches), sections: prSections({ action, text, watches }) })
    requestFrame()
  }

  return { prCommand }
}

import { parsePrCommand, parsePrReviewCommand, prSections, prSummary, type PrReviewAction, type PrWatchRow } from "../../view/pr-watch"
import { effectiveSettings, type ExperimentalFlag } from "@mendcode/protocol/wire"
import { createTextPageState, preload } from "../lazy-pages"
import { repoSections, type RepoRow } from "../../view/repo-output"
import type { Settings } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { setupPage } from "./setup-confirm"

const TITLE = "Pull requests"

/** The switches `/pr on|off` turns together: one PR watched and the repository reviewer. */
const PR_FLAGS: readonly ExperimentalFlag[] = ["pr_watch", "pr_review"]

/** `/pr`: the daemon polls linked pull requests through `gh` and wakes the session on a change (docs/pr-watch.md). */
export function createPrWatchCommand(ctx: AppContext, actions: { setFlags(names: readonly ExperimentalFlag[], next: boolean): Promise<boolean> }) {
  const { input, state, requestFrame, fail, say } = ctx
  let repos: RepoRow[] = []
  let selected = 0
  let repoText = ""
  let repoPage: typeof state.textPage
  let busy = false
  function showRepos() {
    repoPage = createTextPageState({ title: "Repository watches", summary: "[ ] select · s stop · r restart · R refresh", sections: repoSections(repos, selected, repoText) })
    repoPage.repos = true
    state.textPage = repoPage
    state.page = "text"
    requestFrame()
  }
  async function reposKey(key: string): Promise<boolean> {
    if (!state.textPage?.repos) return false
    repoPage = state.textPage
    if (key === "[" || key === "]") {
      selected = Math.max(0, Math.min(repos.length - 1, selected + (key === "]" ? 1 : -1)))
      showRepos()
      return true
    }
    if (!["s", "r", "R"].includes(key)) return false
    if (busy) return true
    busy = true
    try {
      const row = repos[selected]
      if (key !== "R" && !row) return true
      const reply = await input.send({ type: "pr.review", sessionId: state.sessionId, action: key === "R" ? "list" : key === "s" ? "unwatch-repo" : "watch-repo", ...(row && key !== "R" ? { directory: row.directory, ...(key === "r" && (row.role === "all" || row.role === "requested") ? { role: row.role } : {}) } : {}) })
      if (state.page !== "text" || !state.textPage?.repos) return true
      if (!reply.ok) { repoText = reply.error.message; showRepos(); return true }
      takeRepos(reply.result)
      showRepos()
    } catch (error) {
      if (state.page === "text" && state.textPage?.repos) { repoText = error instanceof Error ? error.message : String(error); showRepos() }
    } finally { busy = false }
    return true
  }
  function takeRepos(result: Record<string, unknown> | undefined) {
    repos = (Array.isArray(result?.watches) ? result.watches : []) as RepoRow[]
    repos = repos.toSorted((a, b) => Number(a.state.startsWith("ended")) - Number(b.state.startsWith("ended")))
    selected = Math.max(0, Math.min(selected, repos.length - 1))
    repoText = String(result?.text ?? "")
  }

  /** Repository lists use the shared page; other replies go through the size-aware notice path. */
  async function reviewCommand(command: { action: PrReviewAction; pr?: string; role?: "all" | "requested" }) {
    if (input.remote) return fail("pr: the reviewer runs gh on the daemon's own machine, so this works only from a local session")
    if (!state.sessionId) return fail("pr: no session yet")
    const parent = state.page
    const sessionId = state.sessionId
    const reply = await input.send({ type: "pr.review", sessionId, action: command.action, ...(command.pr ? { pr: command.pr } : {}), ...(command.role ? { role: command.role } : {}) })
    if (state.page !== parent || state.sessionId !== sessionId) return
    if (!reply.ok) return fail(`pr: ${reply.error.message.replace(/^\[[A-Z-]+\]:\s*/, "")}`)
    if (command.action === "list") {
      await preload("pr")
      takeRepos(reply.result)
      selected = 0
      state.textReturn = parent === "text" ? undefined : parent
      return showRepos()
    }
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
    if (word === "setup" || word.startsWith("setup ")) {
      const role = word.split(/\s+/)[1]
      if (word.split(/\s+/).length > 2 || role && role !== "all" && role !== "requested") return setupPage(ctx, "PR setup", "Usage: /pr setup [all|requested]")
      if (input.remote) return setupPage(ctx, "PR setup", "PR setup is local only. Open a session on the machine that runs the daemon.")
      const sessionId = state.sessionId
      await setupPage(ctx, "PR setup", "Checking login, origin and base-branch configuration…")
      const page = state.textPage
      const command = { type: "pr.review" as const, sessionId, ...(role ? { role: role as "all" | "requested" } : {}) }
      const reply = await input.send({ ...command, action: "setup-preview" })
      if (state.page !== "text" || state.textPage !== page) return
      if (!reply.ok) return setupPage(ctx, "PR setup", reply.error.message)
      const setup = reply.result?.setup as { digest: string; text: string; problems: string[]; changes: string[] } | undefined
      if (!setup) return setupPage(ctx, "PR setup", "This daemon does not support PR setup. Update it before retrying.")
      return setupPage(ctx, "PR setup", setup.text, setup.problems.length || !setup.changes.length ? undefined : async () => {
        const applying = state.textPage
        const done = await input.send({ ...command, action: "setup-apply", reason: setup.digest })
        if (state.page !== "text" || state.textPage !== applying) return
        await setupPage(ctx, "PR repositories", done.ok ? String(done.result?.text ?? "Setup complete") : done.error.message)
      })
    }
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

  return { prCommand, reposKey }
}

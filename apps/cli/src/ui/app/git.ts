import type { ChangesReport, GitCommitReport, GitInitReport, GitPrCreateReport, GitPrView, GitPublishReport, GitPushReport } from "@mendcode/protocol"
import { GIT_COMMIT_MAX_MESSAGE, GIT_NO_REMOTE, GIT_PR_MAX_BODY, GIT_PR_MAX_TITLE, GIT_PUBLISH_MAX_DESCRIPTION, GIT_PUBLISH_MAX_NAME, GIT_PUBLISH_MAX_OWNER, featureOn } from "@mendcode/protocol/wire"
import { createEditor } from "../../view/editor"
import type { GitCommitNotice } from "../../view/git-commit-page"
import type { GitStatusInfo, GitTab } from "../../view/git-page"
import type { GitPrBody } from "../../view/git-pr-page"
import { createGitCommitState, createGitInitState, createGitPrState, gitCommitKey, gitCommitReport, gitCommitSelection, gitInitHit, gitInitKey, gitPrKey, gitPrLinkRow, gitPrPublishHit, gitPrTyping, gitTabHits, preload } from "../lazy-pages"
import type { AppContext } from "./context"

const TABS: readonly GitTab[] = ["changes", "commit", "worktrees", "pr"]
/** Files named in the hint `w` hands to `/commit`. */
const ASK_FILES = 12

/** The tab a page is in, if it is one of the Git page's. */
const tabOf = (page: string): GitTab | undefined => (page === "changes" ? "changes" : page === "git-commit" ? "commit" : page === "git-pr" ? "pr" : page === "worktrees" || page === "warp" ? "worktrees" : undefined)

/** A refusal or failure of `git.push` / `git.pr.create` / `git.publish` / `git.init` as the card shows it: its first line, and under it what git or gh printed. */
function actionNotice(message: string): GitCommitNotice {
  const [first = "", ...rest] = message.replace(/^\[GIT\]: /, "").split("\n")
  const detail = rest.map((line) => line.trimEnd()).filter(Boolean)
  const failed = /^(push (failed|rejected|timed out)|gh could not|gh timed out|git is not installed|publish incomplete|git init (failed|timed out))/.test(first)
  return { tone: failed ? "error" : "warning", text: first.slice(0, 200), ...(detail.length ? { detail: detail.slice(-40) } : {}) }
}

const line = (text: string, tone: "muted" | "warning", fixed = false): GitPrBody => ({ kind: "line", text, tone, ...(fixed ? { fixed } : {}) })

/** A refusal or failure of `git.commit` as the card shows it: its first line, and under it what git and the hooks printed. */
function noticeOf(message: string): GitCommitNotice {
  const [first = "", ...rest] = message.replace(/^\[GIT\]: /, "").split("\n")
  const detail = rest.map((line) => line.trimEnd()).filter(Boolean)
  const failed = /^(commit failed|commit timed out|git add failed)/.test(first)
  return { tone: failed ? "error" : "warning", text: first.slice(0, 200), ...(detail.length ? { detail: detail.slice(-40) } : {}) }
}

/**
 * The Git page (docs/git.md): the tabs row around Changes, Commit and Worktrees, the Commit tab's talk with the daemon, and the keys and
 * clicks that switch tabs. The Changes and Worktrees pages keep their own controllers; this one only opens them.
 */
export function createGit(ctx: AppContext, deps: { loadChanges(reload?: boolean): Promise<void>; loadDiffTotals(): Promise<void>; worktreesCommand(text: string): Promise<boolean>; runSlash(text: string): Promise<boolean>; insertPrompt(text: string): void }) {
  const { input, state, requestFrame, say, fail } = ctx
  const directory = () => input.directory ?? ""

  /** True while the Git page's frame is drawn: the feature is on (balanced and above) and a page of the three tabs is open, or the folder is not a repository. */
  const framed = () => featureOn(state.settingsNow, "git_hub") && (tabOf(state.page) !== undefined || state.page === "git-init")

  /** True while keys are text for the page (a comment, a line number, a workspace name, the commit message), so `<` and `>` type. */
  function typing() {
    if (state.page === "git-init") return false
    if (state.page === "changes") return state.changesState?.mode === "compose" || state.changesState?.mode === "jump"
    if (state.page === "git-commit") return state.gitCommit?.focus === "message" && state.gitCommit.stage === "edit"
    if (state.page === "git-pr") return !!state.gitPr && gitPrTyping(state.gitPr)
    return !!state.worktrees?.form
  }

  /** The one line that replaces the tab while it may not run, or undefined. Nothing is sent to the daemon in these cases. */
  function closed(): GitPrBody | undefined {
    if (input.remote) return line("gh runs on the daemon's own machine: use this tab from a local session", "muted", true)
    if (!featureOn(state.settingsNow, "git_actions")) return line("Blocked by features.git_actions · /tier git_actions default", "muted", true)
    if (state.settingsNow.experimental?.git_actions !== true) return line("Off: this tab uses the network · /experimental git_actions on", "muted", true)
    return undefined
  }

  async function loadGitStatus() {
    if (!directory()) { state.gitStatus = { loaded: true }; return }
    const reply = await input.send({ type: "git.status", directory: directory() })
    const found = reply.ok ? (reply.result ?? {}) as Partial<Record<"branch" | "detached" | "dirty" | "conflicts" | "ahead" | "behind" | "error", unknown>> : undefined
    const status: GitStatusInfo = { loaded: true }
    if (found) {
      if (typeof found.branch === "string") status.branch = found.branch
      if (found.detached === true) status.detached = true
      for (const name of ["dirty", "conflicts", "ahead", "behind"] as const) if (typeof found[name] === "number") status[name] = found[name] as number
      if (typeof found.error === "string") status.error = found.error
    } else if (!reply.ok) status.error = reply.error.message
    state.gitStatus = status
    requestFrame()
  }

  async function loadCommitReport() {
    if (!state.gitCommit) return
    const reply = await input.send({ type: "changes.query", directory: directory() })
    if (!state.gitCommit) return
    state.gitCommit = reply.ok ? gitCommitReport(state.gitCommit, reply.result as ChangesReport) : { ...state.gitCommit, report: undefined, error: reply.error.code === "not_git" ? "not a git repository" : reply.error.message }
    requestFrame()
  }

  async function openCommit() {
    state.gitCommit = { ...(state.gitCommit ?? createGitCommitState(createEditor({ wordWrap: true }))), stage: "edit", plan: undefined, notice: undefined, focus: "files" }
    state.page = "git-commit"
    requestFrame()
    await loadCommitReport()
  }

  /** Reads the branch's pull request (`git.pr.view`), unless the switch is off: then the tab is its one line and nothing is sent. */
  async function loadPr() {
    const shut = closed()
    if (shut) { if (state.gitPr) state.gitPr = { ...state.gitPr, body: shut }; requestFrame(); return }
    if (state.gitPr) state.gitPr = { ...state.gitPr, body: { kind: "loading" } }
    requestFrame()
    const reply = await input.send({ type: "git.pr.view", directory: directory(), ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    let body: GitPrBody
    if (!reply.ok) {
      const first = reply.error.message.replace(/^\[GIT\]: /, "").split("\n")[0]!
      // No remote is not a failure of the tab: it is the one thing the tab can do something about (docs/git.md).
      body = first.startsWith(GIT_NO_REMOTE) ? { kind: "noremote", branch: state.gitStatus.detached ? undefined : state.gitStatus.branch } : line(first.slice(0, 200), reply.error.code === "forbidden" ? "muted" : "warning")
    } else {
      const found = reply.result as GitPrView
      body = found.pr ? { kind: "pr", branch: found.branch, pr: found.pr } : { kind: "none", branch: found.branch }
    }
    state.gitPr = { ...state.gitPr, body }
    requestFrame()
  }

  async function openPr() {
    state.gitPr = createGitPrState()
    state.page = "git-pr"
    requestFrame()
    await loadPr()
  }

  /** `u`: asks the daemon for the plan of the push and shows the card; a refusal is one line. */
  async function pushCard() {
    const view = state.gitPr!
    const reply = await input.send({ type: "git.push", directory: directory(), preview: true, ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    state.gitPr = reply.ok ? { ...state.gitPr, stage: "push", push: (reply.result as GitPushReport).plan, typed: "", notice: undefined } : { ...view, notice: actionNotice(reply.error.message) }
  }

  async function push() {
    const view = state.gitPr!
    const plan = view.push!
    state.gitPr = { ...view, stage: "running", doing: `pushing ${plan.branch} to ${plan.remote}…`, notice: undefined }
    requestFrame()
    const reply = await input.send({ type: "git.push", directory: directory(), ...(state.sessionId ? { sessionId: state.sessionId } : {}), ...(plan.protected ? { confirm: view.typed } : {}) })
    if (!state.gitPr) return
    // A failed push keeps the card, so the command and what git said stay together.
    if (!reply.ok) { state.gitPr = { ...state.gitPr, stage: "push", notice: actionNotice(reply.error.message) }; return }
    const done = reply.result as GitPushReport
    state.gitPr = { ...state.gitPr, stage: "view", push: undefined, typed: "", notice: { tone: "success", text: `pushed ${done.plan.branch} to ${done.plan.remote} · ${done.plan.commitsTotal} ${done.plan.commitsTotal === 1 ? "commit" : "commits"}` } }
    requestFrame()
    void loadGitStatus()
    await loadPr()
  }

  /** `P`: the plan for a new pull request; when the branch is not on its upstream the page says to push first and opens nothing. */
  async function openForm() {
    const view = state.gitPr!
    const reply = await input.send({ type: "git.pr.create", directory: directory(), preview: true, ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    if (!reply.ok) { state.gitPr = { ...view, notice: actionNotice(reply.error.message) }; return }
    const { plan } = reply.result as GitPrCreateReport
    if (!plan.pushed) { state.gitPr = { ...view, notice: { tone: "warning", text: `push first: ${plan.pushNote ?? "the branch is not on its remote"} · u pushes` } }; return }
    const field = (text: string) => { const editor = createEditor({ wordWrap: true }); editor.replaceAll(text); editor.resetHistory(); return editor }
    state.gitPr = { ...view, stage: "form", notice: undefined, form: { plan, title: field(plan.defaults.title), text: field(plan.defaults.body), base: field(plan.base), draft: false, field: "title" } }
  }

  const formArgs = () => {
    const form = state.gitPr!.form!
    return { title: form.title.text.trim(), body: form.text.text, base: form.base.text.trim(), draft: form.draft }
  }

  /** `enter` on the form: the plan with the title, body, base and draft as typed, which is the card; or one line saying what is missing. */
  async function createCard() {
    const view = state.gitPr!
    const typed = formArgs()
    if (!typed.title) { state.gitPr = { ...view, notice: { tone: "warning", text: "empty title · tab goes back to it" }, form: { ...view.form!, field: "title" } }; return }
    if (!typed.base) { state.gitPr = { ...view, notice: { tone: "warning", text: "no base branch · type the branch the pull request targets" }, form: { ...view.form!, field: "base" } }; return }
    const reply = await input.send({ type: "git.pr.create", directory: directory(), preview: true, ...typed, ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    state.gitPr = reply.ok ? { ...state.gitPr, stage: "create", create: (reply.result as GitPrCreateReport).plan, notice: undefined } : { ...state.gitPr, notice: actionNotice(reply.error.message) }
  }

  async function createPr() {
    const view = state.gitPr!
    state.gitPr = { ...view, stage: "running", doing: "creating the pull request…", notice: undefined }
    requestFrame()
    const reply = await input.send({ type: "git.pr.create", directory: directory(), ...formArgs(), ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    if (!reply.ok) { state.gitPr = { ...state.gitPr, stage: "create", notice: actionNotice(reply.error.message) }; return }
    const done = reply.result as GitPrCreateReport
    state.gitPr = { ...state.gitPr, stage: "view", form: undefined, create: undefined, notice: { tone: "success", text: done.url ? `opened ${done.number ? `#${done.number} ` : ""}${done.url}` : "pull request created" } }
    requestFrame()
    // Saved on the session the way `/pr link` does, when that is on: gh is asked once more for the number, the title and the state.
    if (done.url && featureOn(state.settingsNow, "session_meta") && state.sessionId) void input.send({ type: "session.meta", sessionId: state.sessionId, input: { action: "link_pr", pr: done.url } })
    await loadPr()
  }

  /** `g` on the empty state: the plan (and, from gh, the account that is the default owner) opens the form; a refusal is one line. Nothing is created. */
  async function openPublish() {
    const view = state.gitPr!
    const reply = await input.send({ type: "git.publish", directory: directory(), preview: true, ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    if (!reply.ok) { state.gitPr = { ...view, notice: actionNotice(reply.error.message) }; return }
    const { plan } = reply.result as GitPublishReport
    const field = (text: string) => { const editor = createEditor({ wordWrap: true }); editor.replaceAll(text); editor.resetHistory(); return editor }
    state.gitPr = { ...view, stage: "publish", notice: undefined, publish: { plan, name: field(plan.defaults.name), owner: field(plan.owner), description: field(""), field: "name" } }
  }

  /** What the form holds, as the command takes it. There is no visibility in it: the repository is private. */
  const publishArgs = () => {
    const form = state.gitPr!.publish!
    return { name: form.name.text.trim(), owner: form.owner.text.trim(), description: form.description.text.trim() }
  }

  /** `enter` on the last field: the plan with the name, owner and description as typed, which is the card; or one line saying what is wrong. */
  async function publishCard() {
    const reply = await input.send({ type: "git.publish", directory: directory(), preview: true, ...publishArgs(), ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    state.gitPr = reply.ok ? { ...state.gitPr, stage: "publish-card", publishCard: (reply.result as GitPublishReport).plan, notice: undefined } : { ...state.gitPr, notice: actionNotice(reply.error.message) }
  }

  /** `enter` on the card: creates the private repository and adds `origin`. The push is not part of it. A partial failure keeps the card with what exists now. */
  async function publish() {
    const view = state.gitPr!
    const plan = view.publishCard!
    state.gitPr = { ...view, stage: "running", doing: `creating ${plan.repo} on GitHub, private…`, notice: undefined }
    requestFrame()
    const reply = await input.send({ type: "git.publish", directory: directory(), ...publishArgs(), ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (!state.gitPr) return
    if (!reply.ok) {
      state.gitPr = { ...state.gitPr, stage: "publish-card", notice: actionNotice(reply.error.message) }
      requestFrame()
      // The repository on this machine may have changed (origin added, say): the tab behind the card follows, and nothing is retried.
      if (/^(\[GIT\]: )?(publish incomplete|gh timed out)/.test(reply.error.message)) { void loadGitStatus(); await loadPr() }
      return
    }
    const done = reply.result as GitPublishReport
    const next = done.plan.head === "unborn" ? "commit first, then push" : "u pushes the branch when you are ready"
    state.gitPr = { ...state.gitPr, stage: "view", publish: undefined, publishCard: undefined, notice: { tone: "success", text: `published ${done.plan.repo}, private · origin added · ${next}` } }
    requestFrame()
    void loadGitStatus()
    await loadPr()
  }

  /** `o` and a click on the link: no browser opener exists in the terminal, so the link is copied and printed. */
  function copyLink() {
    const body = state.gitPr?.body
    if (!state.gitPr || body?.kind !== "pr") return
    ctx.copyText(body.pr.url, "the pull request link")
    state.gitPr = { ...state.gitPr, notice: { tone: "success", text: `link copied · ${body.pr.url}` } }
  }

  /** True when `git.status` found no repository here: the folder gets one state in place of every tab (docs/git.md). */
  const notRepository = () => directory() !== "" && state.gitStatus.loaded && !state.gitStatus.branch && !state.gitStatus.detached && !state.gitStatus.error

  /** The Git page of a folder that is not a repository: asks the daemon whether it could be initialized (its plan, or why not) and shows the one action. */
  async function openInit() {
    await preload("git-init")
    state.gitInit = createGitInitState(directory())
    state.page = "git-init"
    requestFrame()
    const view = state.gitInit
    let body: NonNullable<typeof state.gitInit>["body"]
    if (input.remote) body = { kind: "refused", text: "git runs on the daemon's own machine: use this from a local session" }
    else if (!state.sessionId) body = { kind: "refused", text: "open a session in this folder first" }
    else {
      const reply = await input.send({ type: "git.init", directory: directory(), sessionId: state.sessionId, preview: true })
      body = reply.ok ? { kind: "ready", plan: (reply.result as GitInitReport).plan } : { kind: "refused", text: reply.error.message.replace(/^\[GIT\]: /, "").split("\n")[0]!.slice(0, 300) }
    }
    if (state.gitInit !== view) return
    state.gitInit = { ...view, body }
    requestFrame()
  }

  /** `enter` on the card: makes the repository, then lands on the Commit tab with the files listed. Nothing is committed. */
  async function initialize() {
    const view = state.gitInit!
    state.gitInit = { ...view, stage: "running", notice: undefined }
    requestFrame()
    const reply = await input.send({ type: "git.init", directory: directory(), sessionId: state.sessionId! })
    if (!state.gitInit) return
    // A failed init keeps the card, so the command and what git said stay together.
    if (!reply.ok) { state.gitInit = { ...state.gitInit, stage: "card", notice: actionNotice(reply.error.message) }; return }
    const done = reply.result as GitInitReport
    state.gitInit = undefined
    await loadGitStatus()
    await preload("git-commit")
    await openCommit()
    if (state.gitCommit) state.gitCommit = { ...state.gitCommit, notice: { tone: "success", text: `initialized ${done.plan.branch} · nothing committed · tick the files to commit` } }
    requestFrame()
  }

  async function initKey(key: string) {
    const view = state.gitInit
    if (!view) return
    const result = gitInitKey(view, key)
    state.gitInit = result.state
    switch (result.action.type) {
      case "close": state.page = "chat"; break
      case "refresh": await openTab(state.settingsNow.git?.defaultTab ?? "changes"); break
      case "confirm": await initialize(); break
      default: break
    }
    requestFrame()
  }

  async function openTab(tab: GitTab) {
    await loadGitStatus()
    if (notRepository()) return openInit()
    await preload("git-commit")
    if (tab === "pr") { await preload("git-pr"); return openPr() }
    if (tab === "commit") return openCommit()
    if (tab === "worktrees") { await deps.worktreesCommand("/warp"); return }
    // Back on Changes with the page as it was: the same file, the same comments; a fresh page when it was a session or message view.
    if (state.changesReport && state.changesState && !state.changesSource) {
      state.page = "changes"
      requestFrame()
      await deps.loadChanges(false)
      return
    }
    await deps.runSlash("/changes")
  }

  /** `/git [changes | commit | worktrees | pr]`: the tab asked for, else `git.defaultTab`, else Changes. */
  async function openGit(args: string) {
    if (!featureOn(state.settingsNow, "git_hub")) return say("the Git page needs the balanced tier · /tier balanced", "warning")
    const word = args.trim().toLowerCase()
    const wanted = word === "" ? state.settingsNow.git?.defaultTab ?? "changes" : TABS.find((tab) => tab === word)
    if (!wanted) return fail("usage: /git [changes | commit | worktrees | pr]")
    await openTab(wanted)
  }

  async function step(direction: 1 | -1) {
    const at = TABS.indexOf(tabOf(state.page)!)
    await openTab(TABS[(at + direction + TABS.length) % TABS.length]!)
  }

  async function review() {
    const view = state.gitCommit!
    const reply = await input.send({ type: "git.commit", directory: directory(), message: view.editor.text, paths: gitCommitSelection(view).paths, preview: true })
    if (!state.gitCommit) return
    state.gitCommit = reply.ok ? { ...state.gitCommit, stage: "review", plan: (reply.result as GitCommitReport).plan, notice: undefined } : { ...state.gitCommit, notice: noticeOf(reply.error.message) }
  }

  async function commit() {
    const view = state.gitCommit!
    const selection = gitCommitSelection(view)
    state.gitCommit = { ...view, stage: "running" }
    requestFrame()
    const reply = await input.send({ type: "git.commit", directory: directory(), message: view.editor.text, paths: selection.paths })
    if (!state.gitCommit) return
    if (!reply.ok) {
      state.gitCommit = { ...state.gitCommit, stage: "edit", plan: undefined, focus: "files", notice: noticeOf(reply.error.message) }
      return
    }
    const done = reply.result as GitCommitReport
    view.editor.replaceAll("")
    view.editor.resetHistory()
    state.gitCommit = { ...state.gitCommit, stage: "edit", plan: undefined, focus: "files", ticked: new Set(), notice: { tone: "success", text: `committed ${done.sha ?? ""} ${done.subject ?? ""} · ${selection.files.length} ${selection.files.length === 1 ? "file" : "files"}`.replace(/\s+/g, " ").trim() } }
    requestFrame()
    await loadCommitReport()
    void loadGitStatus()
    void deps.loadDiffTotals()
    // The review's comments are matched against the new tree: the ones whose code is committed become outdated.
    if (state.changesState) void deps.loadChanges(true)
  }

  /** `w`: the existing `/commit` prompt, with the ticked files as its hint, in the prompt. Sending it costs a turn and its git commands go through the normal approvals; nothing is sent from here. */
  function ask() {
    const names = gitCommitSelection(state.gitCommit!).files.map((file) => file.path)
    const hint = names.length ? `only these files: ${names.slice(0, ASK_FILES).join(" ")}${names.length > ASK_FILES ? ` and ${names.length - ASK_FILES} more` : ""}` : ""
    state.page = "chat"
    deps.insertPrompt(`/commit${hint ? ` ${hint}` : ""}`)
    say("/commit is in the prompt · enter sends it and costs a turn", "info")
  }

  async function commitKey(key: string) {
    const view = state.gitCommit
    if (!view) return
    if (view.stage === "edit" && view.focus === "files" && (key === "<" || key === ">")) return step(key === ">" ? 1 : -1)
    const mapped = state.bindings.inline.get(key)
    const result = gitCommitKey(view, key, { edit: mapped?.startsWith("edit.") ? mapped.slice(5) : undefined, blocked: state.bindings.disabled.has(key), page: Math.max(1, input.screen.size.height - 8) })
    state.gitCommit = result.state
    if (view.editor.text.length > GIT_COMMIT_MAX_MESSAGE) view.editor.replaceAll(view.editor.text.slice(0, GIT_COMMIT_MAX_MESSAGE))
    switch (result.action.type) {
      case "close": state.page = "chat"; break
      case "refresh": await loadCommitReport(); void loadGitStatus(); break
      case "review": await review(); break
      case "commit": await commit(); break
      case "ask": ask(); break
      default: break
    }
    requestFrame()
  }

  async function prKey(key: string) {
    const view = state.gitPr
    if (!view) return
    if (view.stage === "view" && (key === "<" || key === ">")) return step(key === ">" ? 1 : -1)
    const mapped = state.bindings.inline.get(key)
    const result = gitPrKey(view, key, { edit: mapped?.startsWith("edit.") ? mapped.slice(5) : undefined, blocked: state.bindings.disabled.has(key) })
    state.gitPr = result.state
    const form = state.gitPr.form
    if (form) {
      if (form.title.text.length > GIT_PR_MAX_TITLE) form.title.replaceAll(form.title.text.slice(0, GIT_PR_MAX_TITLE))
      if (form.text.text.length > GIT_PR_MAX_BODY) form.text.replaceAll(form.text.text.slice(0, GIT_PR_MAX_BODY))
    }
    const publishing = state.gitPr.publish
    if (publishing) {
      if (publishing.name.text.length > GIT_PUBLISH_MAX_NAME) publishing.name.replaceAll(publishing.name.text.slice(0, GIT_PUBLISH_MAX_NAME))
      if (publishing.owner.text.length > GIT_PUBLISH_MAX_OWNER) publishing.owner.replaceAll(publishing.owner.text.slice(0, GIT_PUBLISH_MAX_OWNER))
      if (publishing.description.text.length > GIT_PUBLISH_MAX_DESCRIPTION) publishing.description.replaceAll(publishing.description.text.slice(0, GIT_PUBLISH_MAX_DESCRIPTION))
    }
    switch (result.action.type) {
      case "close": state.page = "chat"; break
      case "refresh": void loadGitStatus(); await loadPr(); break
      case "link": copyLink(); break
      case "push": await pushCard(); break
      case "new": await openForm(); break
      case "confirm-push": await push(); break
      case "review": await createCard(); break
      case "confirm-create": await createPr(); break
      case "publish": await openPublish(); break
      case "review-publish": await publishCard(); break
      case "confirm-publish": await publish(); break
      default: break
    }
    requestFrame()
  }

  /** Keys on a page of the four tabs: `<` and `>` switch tabs (not while the page takes text), and the Commit and PR tabs' own keys. True when the key was used here. */
  async function gitKey(key: string): Promise<boolean> {
    if (!framed()) return false
    if (state.page === "git-commit") { await commitKey(key); return true }
    if (state.page === "git-pr") { await prKey(key); return true }
    if (state.page === "git-init") { await initKey(key); return true }
    if ((key !== "<" && key !== ">") || typing()) return false
    await step(key === ">" ? 1 : -1)
    return true
  }

  /** A click on the tabs row (the first row of a page of the three tabs) picks a tab. True when the click was on that row, a tab or not. */
  async function gitClick(at: { row: number; col: number }): Promise<boolean> {
    if (!framed()) return false
    const view = state.gitPr
    // The one action of a folder that is not a repository, and of a repository with no remote: a click on it is its key.
    if (at.row > 0 && state.page === "git-init" && state.gitInit) {
      const hit = gitInitHit(state.gitInit, input.screen.size.width, input.screen.size.height)
      if (!hit || at.row - 1 !== hit.row || at.col < hit.from || at.col >= hit.to) return false
      await initKey("i")
      return true
    }
    if (at.row > 0 && state.page === "git-pr" && view) {
      const hit = gitPrPublishHit(view, input.screen.size.width, input.screen.size.height)
      if (hit) {
        if (at.row - 1 !== hit.row || at.col < hit.from || at.col >= hit.to) return false
        await prKey("g")
        return true
      }
    }
    // The link of the pull request is the one thing on the PR tab a click does: it copies it.
    if (at.row > 0 && state.page === "git-pr" && view?.stage === "view" && view.body.kind === "pr") {
      if (at.row - 1 !== gitPrLinkRow(view, input.screen.size.width, input.screen.size.height)) return false
      copyLink()
      requestFrame()
      return true
    }
    if (at.row !== 0) return false
    const hit = gitTabHits(input.screen.size.width).find((entry) => at.col >= entry.from && at.col < entry.to)
    if (hit && hit.tab !== tabOf(state.page)) await openTab(hit.tab)
    return true
  }

  /** A paste into the commit message. */
  function gitPaste(text: string): boolean {
    const pr = state.gitPr
    if (state.page === "git-pr" && pr?.stage === "push" && pr.push?.protected && framed()) {
      state.gitPr = { ...pr, typed: (pr.typed + text.replace(/[\r\n]+/g, "")).slice(0, 300), notice: undefined }
      requestFrame()
      return true
    }
    if (state.page === "git-pr" && pr?.stage === "publish" && pr.publish && framed()) {
      const form = pr.publish
      const [editor, limit] = form.field === "name" ? [form.name, GIT_PUBLISH_MAX_NAME] as const : form.field === "owner" ? [form.owner, GIT_PUBLISH_MAX_OWNER] as const : [form.description, GIT_PUBLISH_MAX_DESCRIPTION] as const
      editor.insert(text.replace(/\s*[\r\n]+\s*/g, " "))
      if (editor.text.length > limit) editor.replaceAll(editor.text.slice(0, limit))
      requestFrame()
      return true
    }
    if (state.page === "git-pr" && pr?.stage === "form" && pr.form && pr.form.field !== "draft" && framed()) {
      const editor = pr.form.field === "title" ? pr.form.title : pr.form.field === "base" ? pr.form.base : pr.form.text
      editor.insert(pr.form.field === "body" ? text.replace(/\r\n?/g, "\n") : text.replace(/\s*[\r\n]+\s*/g, " "))
      if (editor === pr.form.title && editor.text.length > GIT_PR_MAX_TITLE) editor.replaceAll(editor.text.slice(0, GIT_PR_MAX_TITLE))
      if (editor === pr.form.text && editor.text.length > GIT_PR_MAX_BODY) editor.replaceAll(editor.text.slice(0, GIT_PR_MAX_BODY))
      requestFrame()
      return true
    }
    const view = state.gitCommit
    if (state.page !== "git-commit" || !view || view.focus !== "message" || view.stage !== "edit" || !framed()) return false
    view.editor.insert(text.replace(/\r\n?/g, "\n"))
    if (view.editor.text.length > GIT_COMMIT_MAX_MESSAGE) view.editor.replaceAll(view.editor.text.slice(0, GIT_COMMIT_MAX_MESSAGE))
    requestFrame()
    return true
  }

  return { openGit, gitKey, gitClick, gitPaste, framed, typing, loadGitStatus }
}

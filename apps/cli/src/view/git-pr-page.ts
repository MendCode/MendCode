import type { GitPrInfo, GitPrPlan, GitPublishPlan, GitPushPlan } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { clampLine } from "./changes-page"
import { fit, panelGrid, spread } from "./deck"
import type { Editor } from "./editor"
import type { EditAction } from "./editor-actions"
import { chipAt, muted, mutedWrapped, outputRows, plural, quoted, text, wrapped } from "./git-card"
import { messageRows, type GitCommitNotice } from "./git-commit-page"
import { fitHints } from "./git-page"
import { PUBLISH_FIELDS, PUBLISH_LABEL, noRemoteRows, publishCardRows, publishEditor, publishFieldTabs, publishFormRows, publishSummary, type GitPublishForm } from "./git-publish-page"
import { tabsRow, type PageTab } from "./page"
import { wrap } from "./wrap"

/**
 * The PR tab of the Git page (docs/git.md): the pull request of the current branch, read through gh, and the two actions that leave the machine, push
 * and create pull request, each behind a card that shows the exact command. The keys and rows here are pure; the page controller (`ui/app/git.ts`)
 * talks to the daemon. With the switch off the tab is one line and nothing is read.
 */

export type GitPrBody =
  | { kind: "loading" }
  /** One line instead of the page: the switch is off, gh is missing, there is no remote... */
  | { kind: "line"; text: string; tone: ColorName; /** Reading again cannot change it (the switch, the machine): no `r` hint. */ fixed?: boolean }
  | { kind: "none"; branch: string }
  | { kind: "pr"; branch: string; pr: GitPrInfo }
  /** The repository has no remote: nothing to push, and the tab offers to publish it. */
  | { kind: "noremote"; branch: string | undefined }
export type GitPrField = "title" | "body" | "base" | "draft"
export type GitPrStage = "view" | "form" | "push" | "create" | "running" | "publish" | "publish-card"
export type GitPrForm = { plan: GitPrPlan; title: Editor; text: Editor; base: Editor; draft: boolean; field: GitPrField }
export type GitPrState = {
  body: GitPrBody
  stage: GitPrStage
  notice: GitCommitNotice | undefined
  /** The plan of the push card. */
  push: GitPushPlan | undefined
  /** What has been typed to confirm a protected branch. */
  typed: string
  form: GitPrForm | undefined
  /** The plan of the create card. */
  create: GitPrPlan | undefined
  /** The form of the publish, and the plan of its card. */
  publish: GitPublishForm | undefined
  publishCard: GitPublishPlan | undefined
  /** What the running stage is doing. */
  doing: string
}
export type GitPrAction =
  | { type: "none" } | { type: "typed" } | { type: "close" } | { type: "refresh" } | { type: "link" }
  | { type: "push" } | { type: "new" } | { type: "confirm-push" } | { type: "review" } | { type: "confirm-create" }
  | { type: "publish" } | { type: "review-publish" } | { type: "confirm-publish" }

const NONE: GitPrAction = { type: "none" }
const NARROW = 70
const FIELDS: readonly GitPrField[] = ["title", "body", "base", "draft"]
const FIELD_TABS: PageTab[] = [{ key: "", label: "Title" }, { key: "", label: "Body" }, { key: "", label: "Base" }, { key: "", label: "Draft" }]
const LABEL = 9

export const createGitPrState = (): GitPrState => ({ body: { kind: "loading" }, stage: "view", notice: undefined, push: undefined, typed: "", form: undefined, create: undefined, publish: undefined, publishCard: undefined, doing: "" })

const HINT_LOADING = "esc back"
const HINT_LINE = "r refresh · esc back"

function hintsOf(state: GitPrState): { hints: string; escape: string } {
  if (state.stage === "running") return { hints: state.doing, escape: "esc back" }
  if (state.stage === "push") return { hints: state.push?.protected ? "type the branch name · enter push · esc cancel" : "enter push · esc cancel", escape: "esc cancel" }
  if (state.stage === "create") return { hints: "enter create the pull request · esc edit", escape: "esc edit" }
  if (state.stage === "publish-card") return { hints: "enter publish · esc edit", escape: "esc edit" }
  if (state.stage === "publish") {
    const last = state.publish?.field === "description"
    return { hints: `type the ${state.publish?.field ?? "name"} · ${last ? "enter review" : "enter next field"} · tab next · esc cancel`, escape: "esc cancel" }
  }
  if (state.stage === "form") {
    const field = state.form?.field
    const hints = field === "title" ? "type the title · enter next field · tab next · esc cancel"
      : field === "body" ? "type the body · tab next field · esc cancel"
      : field === "base" ? "type the base branch · enter review · tab next · esc cancel"
      : "space draft · enter review · tab next · esc cancel"
    return { hints, escape: "esc cancel" }
  }
  const body = state.body
  if (body.kind === "loading") return { hints: HINT_LOADING, escape: "esc back" }
  if (body.kind === "line") return { hints: body.fixed ? HINT_LOADING : HINT_LINE, escape: "esc back" }
  if (body.kind === "noremote") return { hints: "g publish to GitHub · r refresh · esc back", escape: "esc back" }
  if (body.kind === "none") return { hints: "u push · P create PR · r refresh · esc back", escape: "esc back" }
  return { hints: "u push · o copy link · r refresh · esc back", escape: "esc back" }
}

/** True while keys are text for the page (a field of the form, the branch name of a protected push), so `<` and `>` type. */
export const gitPrTyping = (state: GitPrState) => (state.stage === "form" && state.form?.field !== "draft") || state.stage === "publish" || (state.stage === "push" && state.push?.protected === true)

/**
 * Handles one raw key. View: `u` asks for the push card, `P` for the form of a new pull request, `o` copies the link, `r` refreshes. Push card: type the
 * branch name when it is protected, `enter` pushes, `esc` cancels. Form: `tab` and `shift+tab` walk title, body, base and draft; the text fields are the
 * app's editors; `enter` on the base or the draft asks for the card; `esc` cancels. Create card: `enter` creates, `esc` goes back to the form.
 * `edit` is the editor action the user's key bindings give this key, `blocked` a key they switched off.
 */
export function gitPrKey(state: GitPrState, key: string, input: { edit?: string | undefined; blocked?: boolean } = {}): { state: GitPrState; action: GitPrAction } {
  const move = (patch: Partial<GitPrState>, action: GitPrAction = NONE) => ({ state: { ...state, notice: undefined, ...patch }, action })
  if (state.stage === "running") return { state, action: NONE }

  if (state.stage === "create") {
    if (key === "\r") return move({}, { type: "confirm-create" })
    if (key === "\x1b" || key === "q") return move({ stage: "form", create: undefined })
    return { state, action: NONE }
  }

  if (state.stage === "publish-card") {
    if (key === "\r") return move({}, { type: "confirm-publish" })
    if (key === "\x1b" || key === "q") return move({ stage: "publish", publishCard: undefined })
    return { state, action: NONE }
  }

  if (state.stage === "publish" && state.publish) {
    const form = state.publish
    const walk = (step: 1 | -1) => move({ publish: { ...form, field: PUBLISH_FIELDS[(PUBLISH_FIELDS.indexOf(form.field) + step + PUBLISH_FIELDS.length) % PUBLISH_FIELDS.length]! } })
    if (key === "\x1b") return move({ stage: "view", publish: undefined })
    if (key === "\t") return walk(1)
    if (key === "\x1b[Z") return walk(-1)
    if (key === "\r") return form.field === "description" ? move({}, { type: "review-publish" }) : walk(1)
    const editor = publishEditor(form)
    if (key === "\x1f") editor.undo()
    else if (key === "\x1b[90;6u") editor.redo()
    else if (input.edit) editor.action(input.edit as EditAction)
    else if (!input.blocked && key !== "\x1b\r") editor.key(key)
    return move({}, { type: "typed" })
  }

  if (state.stage === "push") {
    const plan = state.push
    if (key === "\x1b" || (key === "q" && !plan?.protected)) return move({ stage: "view", push: undefined, typed: "" })
    if (key === "\r") {
      if (plan?.protected && state.typed !== plan.branch) return { state: { ...state, notice: { tone: "warning", text: `type ${plan.branch} to confirm` } }, action: NONE }
      return move({}, { type: "confirm-push" })
    }
    if (plan?.protected) {
      if (key === "\x7f" || key === "\b") return move({ typed: state.typed.slice(0, -1) })
      // A chunk of typed text can arrive as one key ("mai"), so any run of printable characters counts.
      if (!/[\u0000-\u001f\u007f-\u009f]/.test(key) && state.typed.length < 300) return move({ typed: (state.typed + key).slice(0, 300) })
    }
    return { state, action: NONE }
  }

  if (state.stage === "form" && state.form) {
    const form = state.form
    const walk = (step: 1 | -1) => move({ form: { ...form, field: FIELDS[(FIELDS.indexOf(form.field) + step + FIELDS.length) % FIELDS.length]! } })
    if (key === "\x1b") return move({ stage: "view", form: undefined })
    if (key === "\t") return walk(1)
    if (key === "\x1b[Z") return walk(-1)
    if (form.field === "draft") {
      if (key === " ") return move({ form: { ...form, draft: !form.draft } })
      if (key === "\r") return move({}, { type: "review" })
      return { state, action: NONE }
    }
    const editor = form.field === "title" ? form.title : form.field === "base" ? form.base : form.text
    if (form.field !== "body" && key === "\r") return form.field === "base" ? move({}, { type: "review" }) : walk(1)
    const newline = key === "\r" || key === "\x1b\r"
    if (key === "\x1f") editor.undo()
    else if (key === "\x1b[90;6u") editor.redo()
    else if (input.edit) editor.action(input.edit as EditAction)
    else if (!input.blocked && !(newline && form.field !== "body")) editor.key(newline ? "\n" : key)
    return move({}, { type: "typed" })
  }

  if (key === "\x1b" || key === "q") return move({}, { type: "close" })
  if (key === "r") return move({}, { type: "refresh" })
  const body = state.body
  if (body.kind === "noremote" && (key === "g" || key === "u")) return move({}, { type: "publish" })
  if (body.kind === "none" || body.kind === "pr") {
    if (key === "u") return move({}, { type: "push" })
    if (key === "P" && body.kind === "none") return move({}, { type: "new" })
    if (key === "o" && body.kind === "pr") return move({}, { type: "link" })
  }
  return { state, action: NONE }
}

const TONE: Record<GitCommitNotice["tone"], ColorName> = { warning: "warning", error: "error", success: "success" }

const REVIEW: Record<string, { text: string; fg: ColorName }> = {
  APPROVED: { text: "approved", fg: "success" },
  CHANGES_REQUESTED: { text: "changes requested", fg: "warning" },
  REVIEW_REQUIRED: { text: "review required", fg: "text" },
}

function checksLine(pr: GitPrInfo): Span[] {
  const { pass, fail, pending, skip } = pr.checks
  if (pass + fail + pending + skip === 0) return [muted("none reported")]
  const out: Span[] = [text(`${pass} passed`)]
  if (fail) out.push(muted(" · "), { text: `${fail} failed`, fg: "error" })
  if (pending) out.push(muted(" · "), text(`${pending} pending`))
  if (skip) out.push(muted(` · ${skip} skipped`))
  return out
}

function prRows(pr: GitPrInfo, width: number, g: Glyphs): Line[] {
  const label = (name: string): Span => muted(name.padEnd(LABEL))
  const out: Line[] = []
  out.push(clampLine([muted(`#${pr.number}  `), text(pr.title, { bold: true })], width))
  out.push(clampLine([muted(`${pr.head} → ${pr.base} · ${pr.state}${pr.draft ? " · draft" : ""}`)], width))
  out.push(clampLine([text(pr.url)], width))
  out.push([])
  out.push(clampLine([label("checks"), ...checksLine(pr)], width))
  for (const name of pr.failing) out.push(clampLine([text("  "), { text: g.fail, fg: "error" }, text(` ${name}`)], width))
  for (const name of pr.pending) out.push(clampLine([text("  "), muted(g.queue), muted(` ${name}`)], width))
  const review = pr.review ? REVIEW[pr.review] ?? { text: pr.review.toLowerCase().replace(/_/g, " "), fg: "text" as ColorName } : undefined
  out.push(clampLine([label("review"), review ? { text: review.text, fg: review.fg } : muted("none")], width))
  out.push(clampLine([label("merge"), pr.mergeable === "conflicting" ? { text: "conflicts with base", fg: "error" } : pr.mergeable === "mergeable" ? { text: "mergeable", fg: "success" } : muted("not known yet")], width))
  return out
}

/** The row, in the page's own rows, that holds the link of the pull request, for a click that copies it. */
export function gitPrLinkRow(state: GitPrState, width: number, height: number): number {
  const url = state.body.kind === "pr" ? state.body.pr.url : undefined
  if (!url) return -1
  return renderGitPrPage({ state, width, height }).findIndex((row) => row.some((span) => span.text === url))
}

/** Where a click on "Publish to GitHub" lands: its row in the page's rows (the tabs row is not one of them) and its screen columns; undefined while it is not drawn. */
export function gitPrPublishHit(state: GitPrState, width: number, height: number) {
  if (state.stage !== "view" || state.body.kind !== "noremote") return undefined
  return chipAt(renderGitPrPage({ state, width, height }), ` ${PUBLISH_LABEL} `)
}

/** The commits a card names: the newest first, with the rest counted. */
function commitRows(commits: ReadonlyArray<{ sha: string; subject: string }>, total: number, width: number): Line[] {
  const out = commits.map((commit): Line => clampLine([text(`  ${commit.sha} `, { fg: "muted" }), text(commit.subject)], width))
  if (total > commits.length) out.push([muted(`  +${total - commits.length} more`)])
  return out
}

/** The card of the push: the exact command, where it goes, what goes, and what is not done. After a failure it keeps the command and gives way to what git printed. */
function pushRows(plan: GitPushPlan, typed: string, width: number, failure: readonly string[] | undefined, room: number): Line[] {
  const out: Line[] = [[{ text: "leaves this machine", fg: "warning", bold: true }]]
  out.push(...wrapped(quoted(plan.argv), width, { bold: true }))
  out.push(...wrapped(`remote ${plan.remote}  ${plan.url}`, width))
  out.push([])
  out.push([text(`${plural(plan.commitsTotal, "commit")} will be sent`)])
  out.push(...commitRows(failure ? plan.commits.slice(0, 2) : plan.commits, plan.commitsTotal, width))
  if (failure) return [...out, [], ...outputRows(failure.slice(-Math.max(3, room - out.length - 1)), width)]
  out.push([])
  out.push(...mutedWrapped("not done: no force, no tags, no other branch, no pull request", width))
  out.push(...mutedWrapped("uses your own git login; if git would ask for a password the push fails", width))
  if (plan.hooks.length) out.push(...mutedWrapped(`repository hooks run: ${plan.hooks.join(", ")}`, width))
  if (plan.behind > 0) out.push(...wrap(`${plan.remote} has ${plural(plan.behind, "commit")} this branch lacks: git will reject this push, and the page does not force it`, width).map((row): Line => [{ text: row, fg: "warning" }]))
  if (plan.protected) {
    out.push([])
    out.push(...wrap(`${plan.branch} is protected here: type its name to confirm`, width).map((row): Line => [text(row)]))
    out.push([muted("> "), text(typed), { text: "█", fg: "primary" }])
  }
  return out
}

/** The card of the pull request: the exact command, the body that goes on standard input, where it goes, and what is not done. */
function createRows(plan: GitPrPlan, width: number, failure: readonly string[] | undefined, room: number): Line[] {
  const out: Line[] = [[{ text: "leaves this machine", fg: "warning", bold: true }]]
  out.push(...wrapped(quoted(plan.argv), width, { bold: true }))
  const lines = plan.body ? plan.body.split("\n").length : 0
  out.push(...mutedWrapped(lines ? `body: ${plural(lines, "line")} on standard input, never in the command` : "body: empty", width))
  out.push(...wrapped(`remote ${plan.remote}  ${plan.url}`, width))
  out.push([])
  out.push([text(`${plan.branch} → ${plan.base} · ${plural(plan.commitsTotal, "commit")} not in ${plan.base}${plan.draft ? " · draft" : ""}`)])
  out.push(...commitRows(failure ? plan.commits.slice(0, 2) : plan.commits, plan.commitsTotal, width))
  if (failure) return [...out, [], ...outputRows(failure.slice(-Math.max(3, room - out.length - 1)), width)]
  out.push([])
  out.push(...mutedWrapped("not done: no merge, no force, no push (the branch is already on the remote)", width))
  out.push(...mutedWrapped("uses your own gh login; if gh would ask, it fails", width))
  return out
}

/** The page's rows: exactly `height` lines of `width` cells. The caller puts the Git tabs row above it and gives it one row less. */
export function renderGitPrPage(input: { state: GitPrState; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { state, width, height } = input
  if (height <= 0) return []
  const g = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)
  const pad = (rows: Line[]) => {
    const out = rows.slice(0, height)
    while (out.length < height) out.push([])
    return out.map((row) => fit([{ text: " " }, ...fit(row, inner), { text: " " }], width))
  }
  const wide = width >= NARROW
  const { hints, escape } = hintsOf(state)
  const publishing = state.publish !== undefined && (state.stage === "publish" || state.stage === "publish-card" || state.stage === "running")
  const title = state.stage === "push" ? "Push" : state.stage === "form" || state.stage === "create" ? "New pull request" : publishing ? "Publish to GitHub" : "Pull request"
  const header = spread([{ text: title, fg: "primary", bold: true }], [{ text: fitHints({ title, hints, escape, inner }), fg: "muted" }], inner)
  const body = state.body
  const form = state.stage === "form" ? state.form : undefined
  const publishForm = state.stage === "publish" ? state.publish : undefined

  const left: Line = []
  if (publishing && state.publish) left.push(...publishSummary(state.publish))
  else if (form) left.push(text(`${form.plan.branch} → ${form.plan.base || "…"}`))
  else if (body.kind === "noremote") left.push(...(body.branch ? [text(body.branch)] : []), muted(`${body.branch ? " · " : ""}no remote`))
  else if (body.kind === "pr") {
    const { pr } = body
    left.push(text(`#${pr.number} ${pr.state}`))
    if (pr.checks.fail) left.push({ text: ` · ${pr.checks.fail} ${pr.checks.fail === 1 ? "check failed" : "checks failed"}`, fg: "error" })
    else if (pr.checks.pending) left.push(muted(` · ${pr.checks.pending} pending`))
  } else if (body.kind === "none") left.push(text(body.branch), muted(" · no pull request"))
  const summary = spread(left, form && !wide ? tabsRow(FIELD_TABS, FIELDS.indexOf(form.field), inner) : publishForm && !wide ? publishFieldTabs(publishForm, inner) : [], inner)

  const room = Math.max(0, height - 4)
  const notice: Line = state.notice ? clampLine([{ text: state.notice.text, fg: TONE[state.notice.tone] }], inner) : []
  const top: Line[] = [header, summary, []]
  const frame = (rows: Line[]) => pad([...top, ...rows.slice(0, room), ...Array.from({ length: Math.max(0, room - rows.length) }, (): Line => []), notice])
  const card = (heading: string, rows: (width: number) => Line[]) => panelGrid({ width: inner, padding: true, rows: [[{ title: heading, active: true, body: rows }]], heights: [room] })

  if (state.stage === "running") return frame([[muted(state.doing)]])
  if (state.stage === "push" && state.push) return frame(card("Confirm · push", (w) => pushRows(state.push!, state.typed, w, state.notice?.detail, room - 4)))
  if (state.stage === "create" && state.create) return frame(card("Confirm · create pull request", (w) => createRows(state.create!, w, state.notice?.detail, room - 4)))
  if (state.stage === "publish-card" && state.publishCard) return frame(card("Confirm · publish", (w) => publishCardRows(state.publishCard!, w, state.notice?.detail, room - 4)))
  if (publishForm) return frame(publishFormRows({ form: publishForm, inner, room, wide }))
  if (form) {
    const field = (name: GitPrField) => form.field === name
    const titlePanel = { title: "Title", weight: 5, active: field("title"), body: (w: number) => messageRows(form.title, w, 1, field("title"), "the title of the pull request") }
    const basePanel = { title: "Base", weight: 2, active: field("base"), body: (w: number) => messageRows(form.base, w, 1, field("base"), "branch") }
    const draftPanel = { title: "Draft", weight: 1.2, active: field("draft"), body: [[form.draft ? { text: "[x]", fg: "primary" } as Span : muted("[ ]")]] as Line[] }
    const bodyPanel = { title: "Body", weight: 1, active: field("body"), body: (w: number) => messageRows(form.text, w, Math.max(1, room - 10), field("body"), "describe the change") }
    if (wide) return frame(panelGrid({ width: inner, padding: true, rows: [[titlePanel, basePanel, draftPanel], [bodyPanel]], heights: [5, Math.max(5, room - 6)], maxColumns: 3 }))
    const single = field("title") ? titlePanel : field("base") ? basePanel : field("draft") ? draftPanel : bodyPanel
    const rows = (w: number) => single === bodyPanel ? messageRows(form.text, w, Math.max(1, room - 2), true, "describe the change") : typeof single.body === "function" ? single.body(w) : single.body
    return frame(panelGrid({ width: inner, compact: true, rows: [[{ title: single.title, active: true, body: rows }]], heights: [room] }))
  }
  if (body.kind === "loading") return frame([[muted("reading the pull request…")]])
  if (body.kind === "line") return frame([[{ text: body.text, fg: body.tone }]])

  if (body.kind === "noremote") return frame(panelGrid({ width: inner, padding: true, rows: [[{ title: "No remote", active: true, body: (w: number) => noRemoteRows(body.branch, w) }]], heights: [room] }))
  return frame(body.kind === "pr"
    ? panelGrid({ width: inner, padding: true, rows: [[{ title: "Pull request", active: true, body: (w: number) => prRows(body.pr, w, g) }]], heights: [room] })
    : panelGrid({ width: inner, padding: true, rows: [[{ title: "Pull request", active: true, body: [[text(`No pull request for ${body.branch}.`)], [muted("u pushes the branch · P opens a pull request for it once it is pushed.")]] }]], heights: [room] }))
}

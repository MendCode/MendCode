import type { GitPublishPlan } from "@mendcode/protocol"
import type { Line, Span } from "../ui/theme"
import { panelGrid } from "./deck"
import type { Editor } from "./editor"
import { actionChip, mutedWrapped, outputRows, plural, quoted, text, wrapped } from "./git-card"
import { messageRows } from "./git-commit-page"
import { tabsRow, type PageTab } from "./page"

/**
 * The publish half of the PR tab (docs/git.md): a repository with no remote offers to publish itself as a private repository on GitHub. The form
 * (name, owner, description), the card with the exact command and the rows of the empty state live here; the keys are the PR tab's (`git-pr-page.ts`)
 * and the talk with the daemon is the page controller's. There is no visibility field: the repository is private, always.
 */

export type GitPublishField = "name" | "owner" | "description"
export const PUBLISH_FIELDS: readonly GitPublishField[] = ["name", "owner", "description"]
export type GitPublishForm = { plan: GitPublishPlan; name: Editor; owner: Editor; description: Editor; field: GitPublishField }

export const PUBLISH_LABEL = "Publish to GitHub (private)"
/** What every screen of the publish says about visibility; there is nothing to choose. */
export const PRIVATE_LINE = "private · change visibility on GitHub"
const FIELD_TABS: PageTab[] = [{ key: "", label: "Name" }, { key: "", label: "Owner" }, { key: "", label: "Description" }]

export const publishEditor = (form: GitPublishForm, field = form.field) => (field === "name" ? form.name : field === "owner" ? form.owner : form.description)

/** The summary line of the form: the repository as typed, and that it is private. */
export function publishSummary(form: GitPublishForm): Span[] {
  const name = form.name.text.trim() || "…"
  const owner = form.owner.text.trim() || "…"
  return [text(`${owner}/${name}`), { text: " · private", fg: "muted" }]
}

/** The panel of the empty state: a repository with no remote has nothing to push, and offers to publish. */
export function noRemoteRows(branch: string | undefined, width: number): Line[] {
  return [
    ...wrapped(`${branch ?? "This repository"} has no remote: there is nothing to push and no pull request yet.`, width),
    ...mutedWrapped("Publishing creates a private repository with your gh login and adds it as origin. Pushing stays a separate step.", width),
    [],
    [actionChip(PUBLISH_LABEL)],
  ]
}

/** The form: name and owner side by side, the description under them, and the visibility, which is a line and not a field. Below `narrow` one field shows at a time. */
export function publishFormRows(input: { form: GitPublishForm; inner: number; room: number; wide: boolean }): Line[] {
  const { form, inner, room, wide } = input
  const field = (name: GitPublishField) => form.field === name
  const panel = (name: GitPublishField, title: string, weight: number, placeholder: string) => ({
    title, weight, active: field(name), body: (w: number) => messageRows(publishEditor(form, name), w, 1, field(name), placeholder),
  })
  const name = panel("name", "Name", 5, "repository name")
  const owner = panel("owner", "Owner", 3, "user or organization")
  const description = panel("description", "Description", 1, "optional, one line")
  if (wide) {
    // The visibility is a panel of its own when there is room; without it the summary line still says private.
    if (room < 15) return panelGrid({ width: inner, padding: true, rows: [[name, owner], [description]], heights: [5, Math.max(3, room - 6)], maxColumns: 2 })
    const visibility = { title: "Visibility", weight: 1, body: [[text(PRIVATE_LINE)]] as Line[] }
    return panelGrid({ width: inner, padding: true, rows: [[name, owner], [description], [visibility]], heights: [5, 5, Math.min(5, room - 12)], maxColumns: 2 })
  }
  const single = field("name") ? name : field("owner") ? owner : description
  return panelGrid({ width: inner, compact: true, rows: [[{ title: single.title, active: true, body: single.body }]], heights: [room] })
}

/** The tabs of the fields, for the summary line of the narrow form. */
export const publishFieldTabs = (form: GitPublishForm, inner: number): Line => tabsRow(FIELD_TABS, PUBLISH_FIELDS.indexOf(form.field), inner)

/** The card: the exact command, the repository, that it is private, and what is not done. After a failure it keeps the command and gives way to what exists now. */
export function publishCardRows(plan: GitPublishPlan, width: number, failure: readonly string[] | undefined, room: number): Line[] {
  const out: Line[] = [[{ text: "leaves this machine", fg: "warning", bold: true }]]
  out.push(...wrapped(quoted(plan.argv), width, { bold: true }))
  out.push(...wrapped(`${plan.repo} · ${PRIVATE_LINE}`, width))
  const state = plan.head === "unborn" ? "no commit yet: this creates an empty repository, the first commit comes before the push"
    : plan.head === "detached" ? "detached HEAD: only a remote is added"
    : `${plan.branch ?? "this branch"} · ${plural(plan.commits, "commit")} ${plan.commits === 1 ? "stays" : "stay"} on this machine until you push`
  out.push(...mutedWrapped(state, width))
  if (failure) return [...out, [], ...outputRows(failure.slice(-Math.max(3, room - out.length - 1)), width)]
  out.push([])
  out.push(...mutedWrapped("not done: no push, no public repository, no other remote", width))
  out.push(...mutedWrapped("uses your own gh login; if gh would ask, it fails", width))
  return out
}

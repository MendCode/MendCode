import type { ColorName, Line } from "../ui/theme"
import { boxRow } from "./panel-box"
import { wrapSpans } from "./markdown"
import { approvalRuleOffer, type ApprovalRuleOffer } from "@mendcode/protocol/wire"

/** A pending request as the panels draw it: the transcript's title/detail plus the extras from the wire. */
export type PanelRequest = {
  requestId: string
  title: string
  detail: string
  tool?: string
  permission?: "read" | "write" | "execute"
  permissionContext?: { name: string; patterns: string[]; always: string[] }
  /** The engine itself flagged this call although the session is in full access: allow once or reject only. */
  engineFlagged?: true
  options?: ReadonlyArray<{ label: string; description?: string }>
  multiple?: boolean
  questions?: import("@mendcode/protocol").QuestionInfo[]
}

/** Rows of one panel, and which of them a click can pick: `row` is relative to the panel's first row. */
export type PanelHit = { row: number; index: number; from?: number; to?: number }
export type PanelRows = { rows: Line[]; hits: PanelHit[] }

/**
 * `edit` and `comment` are plan-review choices and `note` is a rejection with a note; the terminal handles those itself
 * (the typed text goes back as the reason). `project` and `user` approve once and also save an allow rule. The others resolve the request.
 */
export type ApprovalChoice = { label: string; key: string; choice: "once" | "session" | "project" | "user" | "deny" | "note" | "edit" | "comment" }

export const PLAN_TITLE = "Review plan"

/** What "always allow" would save, from the request's permission context; undefined when nothing safe applies (or the engine sent no context). */
export function ruleOffer(request: Pick<PanelRequest, "title" | "tool" | "permissionContext" | "permission">): ApprovalRuleOffer | undefined {
  const context = request.permissionContext
  if (request.title === PLAN_TITLE || !context) return undefined
  return approvalRuleOffer({ name: context.name, ...(request.permission ? { permission: request.permission } : {}), patterns: context.patterns })
}

/**
 * The choices of an approval prompt, in order, with the letter key that also picks each. A plan review offers four:
 * approve, edit the plan text (the edited plan goes back as the reply), comment (feedback; plan mode stays) and reject.
 * A tool approval adds "always allow" for this project and for all projects when `offer` names a rule, and a reject-with-note
 * row. Those have no letter key: a prompt typed as an answer must never start by saving a rule.
 * A call the engine flagged although the session is in full access (`flagged`) offers only "Allow once" and "Reject".
 */
export function approvalOptions(title: string, offer?: ApprovalRuleOffer, flagged?: boolean): ApprovalChoice[] {
  if (flagged) return [
    { label: "Allow once", key: "a", choice: "once" },
    { label: "Reject", key: "d", choice: "deny" },
  ]
  if (title === "Save to memory?") return [
    { label: "Save", key: "a", choice: "once" },
    { label: "Save and don't ask for memory again", key: "s", choice: "session" },
    { label: "Edit text", key: "e", choice: "edit" },
    { label: "Reject", key: "d", choice: "deny" },
  ]
  if (title === PLAN_TITLE)
    return [
      { label: "Approve & build", key: "a", choice: "once" },
      { label: "Edit plan", key: "e", choice: "edit" },
      { label: "Comment", key: "c", choice: "comment" },
      { label: "Reject", key: "d", choice: "deny" },
    ]
  return [
    { label: "Allow once", key: "a", choice: "once" },
    { label: "Allow for this session", key: "s", choice: "session" },
    ...(offer ? [{ label: `Always allow ${offer.label} in this project`, key: "", choice: "project" as const }, { label: `Always allow ${offer.label} in all projects`, key: "", choice: "user" as const }] : []),
    { label: "Reject", key: "d", choice: "deny" },
    ...(offer ? [{ label: "Reject with a note", key: "", choice: "note" as const }] : []),
  ]
}

/** The choices of the pending request as the panel shows them. */
export const approvalChoicesOf = (request: PanelRequest | undefined): ApprovalChoice[] => (request ? approvalOptions(request.title, ruleOffer(request), request.engineFlagged === true) : [])

/** v1's per-permission icon (`permission.tsx`); glyphs missing from common terminal fonts (⚙ ⟳) fall back to △. */
export function permissionIcon(tool: string | undefined): string {
  const name = (tool ?? "").toLowerCase()
  if (/^(edit|write|apply_patch|notebook_edit)$/.test(name)) return "→"
  if (/^(read|ls)$/.test(name)) return "←"
  if (/^(glob|grep)$/.test(name)) return "✱"
  if (/^(shell|task)/.test(name)) return "#"
  if (/^(webfetch|web_fetch)$/.test(name)) return "%"
  if (/^web_?search$/.test(name)) return "◈"
  return "△"
}

/** `Allow <Title>?` for a tool approval; a plan review keeps its own title. */
export function approvalTitle(title: string) {
  return title === PLAN_TITLE || title === "Save to memory?" ? title : `Allow ${title}?`
}

/** The protocol limit of a deny reason: the only text an approval can carry back. */
export const MAX_PLAN_REPLY = 2000
export const PLAN_EDITED_NOTE = "The user edited the plan (edited version below). Submit exactly this plan again with plan_submit:\n\n"

/**
 * The reason that carries an edited plan back to the agent, with a note that the user changed it. The daemon's approval
 * decisions have no answer text, so a deny reason is what the agent reads; undefined when the plan does not fit the limit.
 */
export function editedPlanReason(plan: string): string | undefined {
  const reason = `${PLAN_EDITED_NOTE}${plan.trim()}`
  return reason.length <= MAX_PLAN_REPLY ? reason : undefined
}

export function renderApprovalPanel(input: {
  width: number
  request: PanelRequest
  /** The request's detail rows (a wrapped head and the diff), already indented and laid out for `width - 2 * margin - 1`. */
  detail: Line[]
  choice: number
  hint: string
  /** The explanation rows ("?"), already wrapped for the panel, shown under the detail. */
  explain?: Line[]
  /** The choices to list; the request's own (`approvalChoicesOf`) when absent. */
  choices?: readonly ApprovalChoice[]
}): PanelRows {
  const { width, request } = input
  const rail: ColorName = "muted"
  const row = (line: Line) => boxRow({ line, width, rail })
  const rows: Line[] = [row([{ text: ` ${permissionIcon(request.tool)} `, fg: "muted" }, { text: approvalTitle(request.title), fg: "text", bold: true }])]
  if (request.title === "Save to memory?") {
    const parts = request.detail.split("\n")
    const chips = parts.pop() ?? ""
    for (const line of wrapSpans([{ text: parts.join("\n"), fg: "text" }], Math.max(10, width - 8), [{ text: "  " }])) rows.push(row(line))
    rows.push(row([{ text: `  ${chips}`, fg: "muted", dim: true }]))
  } else for (const line of input.detail) rows.push(row(line))
  if (input.explain?.length) {
    rows.push(row([]))
    for (const line of input.explain) rows.push(row(line))
  }
  rows.push(row([]))
  const options = approvalOptionRows({ width, choices: input.choices ?? approvalChoicesOf(request), choice: input.choice })
  const hits: PanelRows["hits"] = options.hits.map((hit) => ({ ...hit, row: hit.row + rows.length }))
  rows.push(...options.rows)
  rows.push(row([]), row([{ text: ` ${input.hint}`, fg: "muted", dim: true }]))
  return { rows, hits }
}

/**
 * The option rows of an approval: number, radio, label and key of every real choice, each row a click on that choice (`row` is
 * relative to the first option row). The terminal draws them even when a custom view draws the rest of the prompt.
 */
export function approvalOptionRows({ width, choices, choice }: { width: number; choices: readonly ApprovalChoice[]; choice: number }): PanelRows {
  const rows: Line[] = []
  const hits: PanelRows["hits"] = []
  choices.forEach((option, index) => {
    const on = index === choice
    hits.push({ row: rows.length, index })
    rows.push(
      boxRow({
        width,
        rail: "muted",
        fill: on ? "element" : "panel",
        line: [
          { text: ` ${index + 1}  `, fg: "muted" },
          { text: on ? "(●) " : "(○) ", fg: on ? "primary" : "muted" },
          { text: option.label, fg: on ? "text" : "muted", bold: on },
          { text: `  ${option.key}`, fg: "muted", dim: true },
        ],
      }),
    )
  })
  return { rows, hits }
}

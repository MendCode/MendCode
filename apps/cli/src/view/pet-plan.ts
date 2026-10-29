import type { PetPlan, PetProgress, PetProgressStep } from "../../../../packages/protocol/src/pet-data"
import type { ColorName, Line, Span } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { boxPanel } from "./deck"
import { lineWidth, terminalText, truncateEnd, wrap } from "./wrap"

const LABEL_WIDTH = 13
const CARD_MAX = 80

/** Money with two decimals; a real but sub-cent amount is not shown as zero. */
export function petUsd(value: number | undefined) {
  if (value === undefined) return "not set"
  return value > 0 && value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`
}

const muted = (text: string): Line => [{ text, fg: "muted" }]
const action = (key: string, label: string): Span[] => [{ text: key, fg: "primary", bold: true }, { text: ` ${label}`, fg: "text" }]
const separator: Span = { text: " · ", fg: "muted" }

/** `y generate · esc cancel`: the key in the accent, its verb in plain text. */
export function actionRow(items: ReadonlyArray<readonly [string, string]>): Line {
  return items.flatMap(([key, label], index) => index === 0 ? action(key, label) : [separator, ...action(key, label)])
}

/** Label and value as one aligned row; a long value wraps under itself instead of under the label. */
function tableRows(rows: ReadonlyArray<readonly [string, string]>, width: number): Line[] {
  return rows.flatMap(([label, value]) => wrap(terminalText(value), Math.max(8, width - LABEL_WIDTH)).map((text, index): Line => [
    { text: (index === 0 ? label : "").padEnd(LABEL_WIDTH), fg: "muted" },
    { text, fg: "text" },
  ]))
}

/** The card is as tall as its content and only as wide as its longest row, never the page. */
function card(input: { rows: Line[]; width: number; min?: number }): Line[] {
  const content = Math.max(input.min ?? 0, ...input.rows.map(lineWidth))
  const width = Math.min(Math.min(input.width, CARD_MAX), content + 4)
  return boxPanel({ body: input.rows, width, height: input.rows.length + 2, compact: true })
}

const stepsOf = (plan: PetPlan): PetProgressStep[] => [...(plan.petId ? [] : [{ label: "reference" as const, status: "pending" as const }]), ...plan.states.flatMap((label) => Array.from({ length: plan.frames ?? 1 }, (_, at) => ({ label, ...((plan.frames ?? 1) > 1 ? { frame: at + 1 } : {}), status: "pending" as const })))]

export function petPlanText(plan: PetPlan) {
  return [plan.description, `image calls ${plan.calls}`, `states ${plan.states.join(" · ")}`, ...((plan.frames ?? 1) > 1 ? [`frames ${plan.frames} a state`] : []), `model ${plan.model}`, `est. cost ${petUsd(plan.estimatedUsd)}`, "description and reference image go to the image provider", "estimate only · failed calls are not refunded", "y generate · esc cancel"]
}

function planCard(plan: PetPlan, width: number): Line[] {
  const inner = Math.min(width, CARD_MAX) - 4
  const wrapped = wrap(terminalText(plan.description), inner)
  const shown = wrapped.slice(0, 3)
  if (wrapped.length > 3) shown[2] = truncateEnd(`${shown[2]} …`, inner)
  const description = shown.map((text): Line => [{ text, fg: "text", bold: true }])
  return card({
    width,
    min: 56,
    rows: [
      ...description,
      [],
      ...tableRows([["image calls", String(plan.calls)], ["states", plan.states.join(" · ")], ...((plan.frames ?? 1) > 1 ? [["frames", `${plan.frames} a state`] as [string, string]] : []), ["model", plan.model], ["est. cost", petUsd(plan.estimatedUsd)]], inner),
      [],
      muted("description and reference image go to the image provider"),
      muted("estimate only · failed calls are not refunded"),
      [],
      actionRow([["y", "generate"], ["esc", "cancel"]]),
    ],
  })
}

const MARKS: Record<PetProgressStep["status"], { mark: string; fg: ColorName; word: string }> = {
  done: { mark: "●", fg: "success", word: "done" },
  working: { mark: "▸", fg: "primary", word: "working" },
  pending: { mark: "○", fg: "muted", word: "pending" },
  failed: { mark: "×", fg: "error", word: "failed" },
}

function progressCard(input: { plan: PetPlan; progress: PetProgress | undefined; error: string | undefined; width: number }): Line[] {
  const steps = input.progress?.steps ?? stepsOf(input.plan)
  const done = steps.filter((step) => step.status === "done").length
  const inner = Math.min(input.width, CARD_MAX) - 4
  const rows: Line[] = [
    [{ text: input.error ? "stopped" : "generating", fg: input.error ? "error" : "text", bold: true }, { text: `  ${done}/${steps.length}`, fg: "muted" }],
    [],
    ...steps.map((step): Line => {
      const { mark, fg, word } = MARKS[step.status]
      return [{ text: `${mark} `, fg }, { text: `${step.label}${step.frame ? ` ${step.frame}` : ""}`.padEnd(LABEL_WIDTH), fg: step.status === "pending" ? "muted" : "text" }, { text: word, fg: step.status === "failed" ? "error" : "muted" }]
    }),
    [],
    ...(input.error ? wrap(terminalText(input.error), inner).map((text): Line => [{ text, fg: "error" }]) : [muted("cannot cancel while calls run")]),
    ...(input.error ? [[], actionRow([["esc", "back"]])] : []),
  ]
  return card({ rows, width: input.width, min: 44 })
}

/** The paid-call confirmation, then its progress. Both are compact cards under the page header. */
export function renderPetPlan(input: { plan: PetPlan; width: number; height: number; busy?: boolean; error?: string; progress?: PetProgress | undefined }) {
  const working = !!input.busy || !!input.error
  const inner = Math.max(8, input.width - 4)
  const body = working ? progressCard({ plan: input.plan, progress: input.progress, error: input.error, width: inner }) : planCard(input.plan, inner)
  const title = input.plan.petId ? "Regenerate state" : "New pet"
  const subtitle = input.error ? "experimental · generation stopped" : input.busy ? "experimental · image calls in progress" : "experimental · nothing is sent until you confirm"
  return appearancePage({ title, subtitle, body, hints: "", width: input.width, height: input.height })
}

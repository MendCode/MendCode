import type { CompoundReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { panelGrid } from "./deck"
import { wrapSpans } from "./markdown"

export type CompoundPageState = { profile: number; run: number; scroll: number; error: string }
const row = (text: string, fg: "text" | "primary" | "muted" | "error" = "text"): Line => [{ text, fg }]

export function renderCompoundPage(input: { report?: CompoundReport; state: CompoundPageState; width: number; height: number; readOnly: boolean }): Line[] {
  const { report, state, width, height } = input
  const inner = Math.max(4, width - 4)
  const room = Math.max(4, height - 2)
  const compact = width < 70
  const profile = report?.profiles[Math.max(0, Math.min(state.profile, report.profiles.length - 1))]
  const run = report?.runs[Math.max(0, Math.min(state.run, report.runs.length - 1))]
  const limits = run?.profile.limits ?? profile?.limits
  const profiles: Line[] = [row(`Orchestration: ${report ? report.config.orchestration.enabled ? "on" : "off" : "loading"}`, "primary"), [], ...(report?.profiles.length ? report.profiles.map((profile, index) => row(`${index === state.profile ? "›" : " "} ${profile.name}${profile.name === profile.strategy ? "" : ` · ${profile.strategy}`}`, index === state.profile ? "primary" : "text")) : [row("No compound profiles", "muted")]), ...(profile ? [row(`Primary: ${profile.primary.model}`), ...(profile.escalation ? [row(`Escalation: ${profile.escalation.model}`)] : []), ...(profile.critic ? [row(`Critic: ${profile.critic.model}`)] : [])] : []), ...(state.error ? [[], row(state.error, "error")] : []), ...(report?.issues.map((issue) => row(issue, "error")) ?? [])]
  const budget: Line[] = limits ? [row(`Requests: ${run?.ledger.requests.length ?? 0} / ${limits.maxModelRequests}`), row(`Tokens: ${run?.ledger.tokens.toLocaleString("en-US") ?? "0"} / ${limits.maxTotalTokens.toLocaleString("en-US")}`), row(`Runtime: ${run ? Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt) : 0} / ${limits.maxRuntimeMs} ms`), row(`Cost: $${(run?.ledger.costUsd ?? 0).toFixed(4)}${run?.ledger.unknownCosts ? " + unknown" : ""}`), ...(limits.maxCostUsd === undefined ? [] : [row(`USD cap: $${limits.maxCostUsd}`)]), row(`Unknown USD: ${limits.unknownCost === "block" ? "block" : "token cap"}`)] : [row("No configured limits", "muted")]
  const execution = (w: number): Line[] => run ? [row(`${run.profile.name} · ${run.state}`, run.state === "blocked" || run.state === "failed" ? "error" : "primary"), row(`Phase: ${run.phase}`), ...(run.reason ? [[], ...wrapSpans(row(run.reason, run.state === "unreviewed-revision" ? "muted" : "error"), w)] : []), ...(run.workspace ? [[], row("Candidate", "primary"), ...wrapSpans(row(run.workspace), w)] : []), ...(run.result ? [[], ...wrapSpans(row(run.result), w)] : []), ...(run.review ? [[], row(`Critic: ${run.review.verdict}`, "primary"), ...wrapSpans(row(run.review.summary), w)] : [])] : [row("No compound runs", "muted")]
  const receipts: Line[] = run ? [row("Model requests", "primary"), ...run.ledger.requests.map((request) => row(`${request.leg} · ${request.model} · ${request.state}`)), [], row("Validation", "primary"), ...run.validation.flatMap((check) => [row(`${check.id}: ${check.status}`, check.status === "pass" ? "text" : "error"), ...(check.detail ? [row(check.detail, "muted")] : [])]), ...(run.fingerprint ? [[], row(`Snapshot: ${run.fingerprint.slice(0, 16)}`, "muted")] : [])] : []
  const histories: Line[] = report?.runs.map((run, index) => row(`${index === state.run ? "›" : " "} ${run.profile.name} · ${run.state} · ${run.ledger.requests.length} requests`, index === state.run ? "primary" : "text")) ?? []
  const top = Math.max(11, Math.floor(room * .30))
  const body = compact ? panelGrid({ rows: [[{ title: "Orchestration", body: (w) => {
    const all = [...profiles, [], ...budget, [], ...execution(w), [], ...receipts, [], ...histories].flatMap((line) => wrapSpans(line, w))
    state.scroll = Math.max(0, Math.min(state.scroll, all.length - Math.max(1, room - 4)))
    return all.slice(state.scroll)
  } }]], width: inner, heights: [room], compact: false, padding: true }) : panelGrid({ rows: [
    [{ title: "Profiles", body: (w) => profiles.flatMap((line) => wrapSpans(line, w)).slice(state.scroll), weight: 2 }, { title: "Limits", body: (w) => budget.flatMap((line) => wrapSpans(line, w)), weight: 1 }],
    [{ title: "Execution", body: (w) => execution(w).slice(state.scroll), weight: 2 }, { title: "Ledger", body: (w) => [...receipts, ...(histories.length ? [[], row("Runs", "primary"), ...histories] : [])].flatMap((line) => wrapSpans(line, w)).slice(state.scroll), weight: 1 }],
  ], width: inner, heights: [top, room - top - 1], compact: false, padding: true, maxColumns: 2 })
  return appearancePage({ title: "Compound", hints: compact ? "pg↑↓ scroll · r refresh · esc" : input.readOnly ? "pg↑↓ scroll · r refresh · esc back" : width < 110 ? "↑↓ profile · pg↑↓ · r refresh · e toggle · o session · esc" : "↑↓ profile · [ ] run · pg↑↓ scroll · r refresh · e on/off · o session · x cancel · esc back", body, width, height, ...(state.error ? { subtitle: state.error } : {}) })
}

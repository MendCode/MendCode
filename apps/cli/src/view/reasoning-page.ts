import type { Line } from "../ui/theme"
import type { renderModelPage } from "./model-page"
import { panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

export function renderReasoningPage(input: Parameters<typeof renderModelPage>[0]): Line[] {
  const { width, height, state, error } = input
  if (height <= 0) return []
  const report = input.report?.reasoning
  const config = state.pendingReasoning ?? report?.config
  const pending = !!state.pendingReasoning || state.pendingAuto !== undefined
  const row = (label: string, value: string): Line => [{ text: `${label}  `, fg: "primary" }, { text: value, fg: "text" }]
  const policy: Line[] = config ? [
    row("Mode", config.mode), row("Evaluator consent", config.remoteProcessing ? "on" : "off"), row("Provider", config.provider), row("Failure", config.failureMode), row("Lease", `${config.maxLeaseSteps} generations`), row("Decisions", `${config.maxDecisionsPerTurn} per turn`), row("Reasoning Auto", (state.pendingAuto ?? report?.reasoningAuto) ? "on" : "off"),
  ] : [[{ text: error ?? "loading…", fg: error ? "error" : "muted" }]]
  const receipt = report?.receipt
  const runtime: Line[] = report ? [row("Policy", report.valid ? "valid" : "invalid"), row("Evaluator", report.evaluatorReady ? "loopback ready" : "not configured"), row("Manual effort", "always wins"),
    ...(receipt ? [row("Last decision", receipt.status), ...(receipt.effort ? [row("Effort", receipt.effort)] : []), ...(receipt.suggestedEffort ? [row("Suggested", receipt.suggestedEffort)] : []), row("Lease left", String(receipt.leaseRemaining)), row("Decisions used", String(receipt.decisions)), ...(receipt.reason ? [[{ text: receipt.reason, fg: "muted" }] as Line] : [])] : []),
  ] : []
  if (pending) runtime.push([], row("Consent", config?.remoteProcessing ? "processing + evaluator cost" : "no evaluator processing"), ...(config?.remoteProcessing ? [[{ text: "Sends the public goal, progress and up to 4 redacted tool results to your loopback evaluator. Its service may charge for evaluation.", fg: "warning" }] as Line] : []))
  if (report && JSON.stringify(report.config) !== JSON.stringify(report.consent)) runtime.push([], [{ text: "Project restrictions reduce consent", fg: "warning" }])
  if (error) runtime.push([], [{ text: error, fg: "error" }])
  const bodyRows = (lines: Line[]) => (columns: number) => lines.flatMap((line) => line.length === 1 ? wrap(line[0]!.text, columns).map((text) => [{ ...line[0]!, text }]) : [line])
  const panels = [{ title: pending ? "Proposed policy" : "Policy", body: bodyRows(policy), active: true, scroll: state.reasoningScroll ?? 0 }, { title: "Runtime", body: bodyRows(runtime), scroll: state.reasoningScroll ?? 0 }]
  const room = Math.max(0, height - 2)
  const stacked = width < 70
  const body = panelGrid({ width, padding: true, compact: false, heights: [room], rows: [stacked ? [panels[state.reasoningTab ?? 0]!] : panels] })
  const confirmation = pending ? "enter save · " : ""
  const refresh = error ? "r refresh · " : ""
  const hints = stacked ? `${confirmation}${refresh}o/s/a · c · 1/2 panels · ↑↓ · esc back` : `${confirmation}${refresh}o/s/a · c consent · p provider · +/- limit · f failure · l lease · t auto · r refresh · ↑↓ · esc back`
  return pickerFrame("Reasoning", hints, width, height, body, pending ? "Unsaved" : "")
}

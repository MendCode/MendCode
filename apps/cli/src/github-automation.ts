import path from "node:path"
import type { GithubFinishReport, GithubInstallReport, GithubReviewReport, GithubRunReport, PrCheckoutReport, ReasoningEffort, SessionId, TurnId } from "@mendcode/protocol"
import { REASONING_EFFORTS } from "@mendcode/protocol/wire"
import { createHeadlessRun } from "./run"
import { sessionSelection } from "./session-output"
import type { Automation, AutomationDeps } from "./automation"

export function githubInstallText(report: GithubInstallReport) {
  return `GitHub agent · ${report.repository}\n${report.written ? "Added workflow" : "Workflow preview"}: ${report.file}\n${report.written ? "Commit the workflow when ready.\n" : report.workflow}${report.blocked.map((item) => `Pending: ${item}\n`).join("")}`
}
export function prCheckoutText(report: PrCheckoutReport) {
  return `Checked out PR #${report.number} as '${report.branch}'\n${report.forkRemote ? `Fork remote: ${report.forkRemote}\n` : ""}${report.donorSession === "skipped" ? "Donor session import skipped in MendCode mode\n" : ""}`
}
export function githubFinishText(report: GithubFinishReport) {
  return `GitHub run ${report.status} · ${report.branch}\n${report.switched ? "Agent changed branches; infrastructure push skipped\n" : ""}${report.pullRequest ? `Created PR #${report.pullRequest}\n` : ""}${report.published ? "Published\n" : "Response and changes kept local\n"}${report.blocked.map((item) => `Pending: ${item}\n`).join("")}`
}

export function createGithubAutomation(deps: AutomationDeps) {
  return async (command: Extract<Automation, { kind: "github.install" | "github.run" | "pr" }>) => {
    const env = deps.env ?? process.env, directory = command.projectDir ? path.resolve(deps.cwd, command.projectDir) : deps.cwd
    const fail = (message: string, code = 1) => { if (command.json) deps.out.write(`${JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "error", command: command.kind, error: { code: "failed", message } })}\n`); else deps.err.write(`error: ${message}\n`); return code }
    const result = (data: GithubInstallReport | PrCheckoutReport | GithubFinishReport, human: string) => { deps.out.write(command.json ? `${JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "result", command: command.kind, data })}\n` : human) }
    if (deps.allowFiles === false) return fail("GitHub and PR commands require a local daemon", 64)
    if (command.kind === "github.install") {
      const model = command.model ?? env.MODEL
      if (!model) return fail("Select a model with --model PROVIDER/MODEL or MODEL", 64)
      const reply = await deps.client.send({ type: "github.install", directory, input: { model, write: command.write, ...(command.hosted ? { hosted: true, release: command.release!, sha256: command.sha256! } : {}) } })
      if (!reply.ok) return fail(reply.error.message)
      const report = reply.result as unknown as GithubInstallReport
      result(report, githubInstallText(report))
      return 0
    }
    const token = command.token ?? env.GH_TOKEN ?? env.GITHUB_TOKEN
    if (command.kind === "pr") {
      if (!command.noTui && !command.json && !deps.openPr) return fail("PR runtime launcher unavailable; use --no-tui", 64)
      const reply = await deps.client.send({ type: "pr.checkout", directory, number: command.number, ...(token ? { token } : {}) })
      if (!reply.ok) return fail(reply.error.message)
      const report = reply.result as unknown as PrCheckoutReport
      result(report, prCheckoutText(report))
      if (!command.noTui && !command.json) { deps.out.write("Starting MendCode runtime...\n"); await deps.openPr!(report) }
      return 0
    }
    if (!token) return fail("GitHub run needs --token, GH_TOKEN or GITHUB_TOKEN", 64)
    let event = command.event
    if (!event) {
      if (!env.GITHUB_EVENT_PATH || !env.GITHUB_EVENT_NAME || !env.GITHUB_REPOSITORY) return fail("Supply --event JSON or the GitHub Actions event environment", 64)
      try {
        const payload = await (deps.readJson ?? ((file: string) => Bun.file(file).json()))(env.GITHUB_EVENT_PATH)
        const [owner, repo] = env.GITHUB_REPOSITORY.split("/")
        event = JSON.stringify({ eventName: env.GITHUB_EVENT_NAME, repo: { owner, repo }, ...(env.GITHUB_ACTOR ? { actor: env.GITHUB_ACTOR } : {}), payload })
      } catch { return fail("Cannot read GitHub Actions event JSON", 64) }
    }
    const model = command.model ?? env.MODEL, variant = command.variant ?? env.VARIANT
    const effort = command.effort ?? env.EFFORT
    if (effort && !(REASONING_EFFORTS as readonly string[]).includes(effort)) return fail(`EFFORT must be one of ${REASONING_EFFORTS.join(", ")}`, 64)
    const selected = await sessionSelection(deps.client, { ...(model ? { model } : {}), ...(variant ? { variant } : {}), ...(effort ? { effort: effort as ReasoningEffort } : {}) }, { directory })
    if (!selected.ok) return fail(selected.message, 64)
    const mentions = command.mentions ?? env.MENTIONS?.split(",").map((mention) => mention.trim()).filter(Boolean)
    if (command.review) {
      // The PR reviewer: one review of the event's pull request, its text on stdout (the job summary), no agent turn.
      const reviewed = await deps.client.send({ type: "github.run", directory, input: { event, token, publish: command.publish, review: true, ...(mentions ? { mentions } : {}) }, ...(selected.model ? { choice: selected.model } : {}) })
      if (!reviewed.ok) return fail(reviewed.error.message)
      const report = reviewed.result as unknown as GithubReviewReport
      if (command.json) deps.out.write(`${JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "result", command: command.kind, data: report })}\n`)
      else deps.out.write(`${report.text}\n`)
      return report.status === "failed" ? 1 : 0
    }
    const prompt = command.prompt ?? env.PROMPT
    const prepared = await deps.client.send({ type: "github.run", directory, input: { event, token, publish: command.publish, ...(command.attachments ? { attachments: true } : {}), ...(prompt ? { prompt } : {}), ...(mentions ? { mentions } : {}) }, ...(selected.model ? { choice: selected.model } : {}) })
    if (!prepared.ok) return fail(prepared.error.message)
    const report = prepared.result as unknown as GithubRunReport
    let code = 1, finished = false, interrupted = false
    const headless = createHeadlessRun({ client: deps.client as import("@mendcode/client").Client, sessionId: report.sessionId as SessionId, prompt: report.prompt, json: command.json, approve: command.approve, thinking: command.thinking, out: deps.out, err: deps.err })
    if (!command.json) deps.err.write(`session: ${report.sessionId}\nGitHub ${report.eventName} · ${report.repository} · ${report.branch}\n`)
    let activeTurn: TurnId | undefined
    const cancel = () => { if (!finished && activeTurn) void deps.client.send({ type: "turn.cancel", sessionId: report.sessionId as SessionId, turnId: activeTurn }).catch(() => undefined) }
    deps.listen((event) => {
      if (event.sessionId === report.sessionId && event.type === "turn.started") { activeTurn = event.turnId; if (interrupted) cancel() }
      headless.onEvent(event)
    })
    deps.onInterrupt(() => { interrupted = true; cancel() })
    try {
      const subscribed = await deps.client.subscribe(report.sessionId as SessionId, 0)
      if (!subscribed.ok) code = fail(subscribed.error.message)
      else code = interrupted ? 2 : await headless.start()
    } catch { code = fail("GitHub agent run failed") }
    finally {
      finished = true
      deps.listen(undefined)
    }
    const completion = await deps.client.send({ type: "github.finish", runId: report.runId, status: code === 0 ? "completed" : code === 2 ? "stopped" : "failed" })
    if (!completion.ok) return fail(completion.error.message)
    const completed = completion.result as unknown as GithubFinishReport
    result(completed, githubFinishText(completed))
    return code
  }
}

import type { CommandInput, CommandReply } from "@mendcode/client"
import type { DreamRun, MemoryEntry, MemoryGraphReport, PrJobSummary, SessionSummary, WorkflowSummary } from "@mendcode/protocol"
import type { AttentionItem, MemoryProposal, PickupItem, TodayData, TodayDream, TodayEvent } from "./today-page"

/**
 * The data behind /today: assembled from what the daemon already answers (docs/today.md), read-only, with no model call and no
 * storage of its own. Every source is asked once per load; a source that cannot answer leaves its rows out and says why in
 * `notes`, so a remote or read-only client sees what it can and what is local-only.
 */

/** Without a stored visit, "since" is the last day. */
export const FIRST_VISIT_WINDOW_MS = 24 * 3_600_000
/** Sessions older than this are not offered for picking up, whatever the last visit was. */
export const PICKUP_WINDOW_MS = 7 * 24 * 3_600_000
const SESSION_LIMIT = 100
const MAX_ATTENTION = 40
const MAX_PICKUP = 30
const MAX_PROPOSALS = 40
const MAX_CONFLICTS = 5
const MAX_DIRECTORIES = 6
const TITLE_CHARS = 70

export type TodaySource = {
  send(command: CommandInput): Promise<CommandReply>
  /** The folder the terminal was opened in; memory is read for it. */
  directory?: string | undefined
  /** The terminal's session: `pr.review` needs one to be asked through. */
  sessionId?: string | undefined
  remote?: { host: string; readOnly: boolean } | undefined
  /** PR review jobs are read only when the `pr_review` feature is on. */
  reviews: boolean
  now: number
  /** Epoch ms of the last visit to /today; 0 or absent when there was none. */
  lastVisit?: number | undefined
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const project = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory
const shortId = (id: string) => (id.length > 12 ? id.slice(0, 12) : id)
const sessionTitle = (session: SessionSummary) => clip(session.title || session.draft?.preview || "Untitled session", TITLE_CHARS)
const sessionLink = (session: SessionSummary) => ({ command: "session", ref: shortId(session.sessionId), sessionId: session.sessionId })

/** The session's status as `session.list` reports it (waiting_for_input, interrupted, failed, completed, ...). */
const statusOf = (session: SessionSummary) => session.status ?? "idle"

function attentionOfSession(session: SessionSummary): AttentionItem | undefined {
  const status = statusOf(session)
  if (status !== "waiting_for_approval" && status !== "waiting_for_input") return undefined
  const approval = status === "waiting_for_approval"
  const asked = session.pending ? clip(session.pending, 160) : approval ? "a tool call" : "a question"
  const history: TodayEvent[] = [{ at: session.updatedAt, text: session.tool ? `last activity: ${session.tool}` : "last activity in the session" }]
  return {
    id: session.sessionId,
    kind: approval ? "approval" : "decision",
    title: sessionTitle(session),
    project: project(session.directory),
    since: session.since ?? session.updatedAt,
    why: approval ? `waiting for your approval: ${asked}` : `waiting for your answer: ${asked}`,
    explain: `${approval ? "The agent needs your approval before it runs" : "The agent asked you"}: ${asked}. The session does not continue until you answer.`,
    next: approval ? "Open the session and allow or reject the request." : "Open the session and answer the question.",
    history,
    evidence: [`session ${session.sessionId}`, `status ${status}`],
    link: sessionLink(session),
  }
}

/** Jobs a person should look at: waiting for them, or finished with confirmed findings nobody resolved. */
const REVIEWED = new Set<PrJobSummary["state"]>(["done", "checkpointed", "paused", "waiting"])

function attentionOfJob(job: PrJobSummary): AttentionItem | undefined {
  const open = Math.max(0, job.findings.confirmed - job.findings.resolved)
  const waiting = job.state === "waiting"
  if (!REVIEWED.has(job.state) || (!waiting && open === 0)) return undefined
  const blocking = job.findings.blocking ?? 0
  const findings = `${plural(open, "open finding")}${blocking ? `, ${blocking} blocking` : ""}`
  return {
    id: job.id,
    kind: "review",
    title: clip(`${job.repo}#${job.number}${job.title ? ` ${job.title}` : ""}`, TITLE_CHARS),
    project: job.repo,
    since: job.updatedAt,
    why: waiting ? (open ? `waiting for you · ${findings}` : "the review is waiting for you") : findings,
    explain: [waiting ? "The review waits for a decision from you." : "", open ? `${findings} from ${job.reviewer} that no fix round has resolved.` : "", job.stop?.remaining ?? ""].filter(Boolean).join(" "),
    next: job.sessionId ? "Open the reviewer session to read the findings." : "Open /reviews to read the findings and act on the job.",
    history: [{ at: job.updatedAt, text: `review ${job.state}${job.phase ? ` · ${job.phase}` : ""}` }, { at: job.createdAt, text: `review started (${job.trigger})` }],
    evidence: [`job ${job.id}`, `${job.findings.confirmed} confirmed, ${job.findings.plausible} plausible, ${job.findings.resolved} resolved`, ...(job.url ? [job.url] : [])],
    link: { command: "/reviews", ref: job.id, ...(job.sessionId ? { sessionId: job.sessionId } : {}) },
  }
}

function attentionOfWorkflow(workflow: WorkflowSummary): AttentionItem | undefined {
  if (workflow.state !== "needs_input") return undefined
  const task = workflow.tasks.find((entry) => entry.state === "needs_input")
  return {
    id: workflow.workflowId,
    kind: "decision",
    title: clip(workflow.name, TITLE_CHARS),
    project: project(workflow.directory),
    since: workflow.updatedAt,
    why: task ? `task "${clip(task.title, 40)}" needs your input` : "a task needs your input",
    explain: `${workflow.reason ? `${clip(workflow.reason, 200)} ` : ""}The workflow is paused on a request only you can answer: ${clip(workflow.objective, 160)}`,
    next: "Open /workflows, select it and answer the request.",
    history: [{ at: workflow.updatedAt, text: "needs input" }, { at: workflow.startedAt, text: "workflow started" }],
    evidence: [`workflow ${workflow.workflowId}`, `round ${workflow.rounds}`],
    link: { command: "/workflows", ref: workflow.workflowId },
  }
}

function attentionOfConflicts(graph: MemoryGraphReport): AttentionItem[] {
  const text = new Map(graph.nodes.map((node) => [node.memoryId, node.text]))
  return graph.links
    .filter((link) => link.kind === "conflicts" && text.has(link.from) && text.has(link.to))
    .slice(0, MAX_CONFLICTS)
    .map((link) => ({
      id: `${link.from}:${link.to}`,
      kind: "contradiction" as const,
      title: clip(`"${text.get(link.from)}" vs "${text.get(link.to)}"`, TITLE_CHARS),
      project: "memory",
      since: link.createdAt,
      why: "two saved memories disagree",
      explain: `"${clip(text.get(link.from)!, 220)}" conflicts with "${clip(text.get(link.to)!, 220)}". Both are injected into turns, so the agent may follow either.`,
      next: "Open /memory, keep the one that is right and archive or edit the other.",
      history: [{ at: link.createdAt, text: "marked as conflicting" }],
      evidence: [`memory ${link.from}`, `memory ${link.to}`],
      link: { command: "/memory", ref: `${shortId(link.from)}, ${shortId(link.to)}` },
    }))
}

type Git = { dirty: number; ahead: number }

function pickupOfSession(session: SessionSummary, git: Map<string, Git>): PickupItem | undefined {
  const status = statusOf(session)
  const tool = session.tool ? `was running ${session.tool}` : undefined
  const left = session.summary ? clip(session.summary, 240) : session.draft?.preview ? `unsent draft: ${clip(session.draft.preview, 160)}` : tool ?? "no summary yet; open it to read the last messages"
  const base = { sessionId: session.sessionId, title: sessionTitle(session), project: project(session.directory), leftAt: session.updatedAt, leftOff: left, link: sessionLink(session) }
  const draftNext = session.draft ? "Send or finish the draft you were writing." : undefined
  const history: TodayEvent[] = [{ at: session.updatedAt, text: `last activity (${status})` }, { at: session.createdAt, text: "session started" }]
  const evidence = [`session ${session.sessionId}`, `status ${status}`]
  if (status === "interrupted") return { ...base, state: "interrupted", why: "the last turn was lost before it finished", next: draftNext ?? "Open it and ask the agent to continue.", history, evidence }
  if (status === "failed") return { ...base, state: "failed", why: "the last turn failed", next: draftNext ?? "Open it, read the error and retry.", history, evidence }
  if (session.paused) return { ...base, state: "blocked", why: "paused; it starts nothing until resumed", next: draftNext ?? "Open it and resume the session.", history, evidence }
  if (status !== "completed" || session.lifecycle?.pr) return undefined
  const state = git.get(session.directory)
  if (!state || (state.dirty === 0 && state.ahead === 0)) return undefined
  const detail = [state.dirty ? `${plural(state.dirty, "file")} with uncommitted changes` : "", state.ahead ? `${plural(state.ahead, "commit")} not pushed` : ""].filter(Boolean).join(", ")
  return { ...base, state: "awaiting-review", why: `finished, ${detail} in ${project(session.directory)}`, next: draftNext ?? "Review the changes, then commit or open a pull request.", history, evidence: [...evidence, `git status of ${session.directory}`] }
}

const KIND_OF: Record<NonNullable<MemoryEntry["kind"]>, MemoryProposal["kind"]> = { new: "new", update: "fix", archive: "drop" }

function proposalOf(entry: MemoryEntry, saved: Map<string, MemoryEntry>, runs: DreamRun[]): MemoryProposal {
  const kind = entry.kind ?? "new"
  const target = entry.targetId ? saved.get(entry.targetId) : undefined
  const run = entry.source === "agent" ? runs.find((candidate) => candidate.startedAt <= entry.createdAt && entry.createdAt <= (candidate.endedAt ?? candidate.startedAt + 3_600_000)) : undefined
  const before = kind === "update" ? (target ? [target.text] : []) : kind === "archive" ? [entry.text] : []
  return {
    id: entry.memoryId,
    kind: KIND_OF[kind],
    title: clip(`${entry.category}: ${entry.text}`, TITLE_CHARS),
    at: entry.createdAt,
    why: entry.reason ? clip(entry.reason, 240) : kind === "archive" ? "proposed for archiving" : kind === "update" ? "proposed correction of a saved memory" : "proposed as a new memory",
    ...(run ? { run: `#${run.runId}` } : {}),
    before,
    ...(kind === "archive" ? {} : { after: entry.text }),
    next: "Approve, edit or reject it in /memory.",
    evidence: [`${entry.scope} scope · ${entry.category}`, ...(entry.targetId ? [`changes memory ${entry.targetId}`] : []), ...(kind === "update" && !target ? ["the saved memory it changes is not in this folder's view"] : [])],
    link: { command: "/memory", ref: shortId(entry.memoryId) },
  }
}

function dreamOf(runs: DreamRun[]): TodayDream | undefined {
  const run = runs[0]
  if (!run) return undefined
  const consolidation = run.report?.consolidation
  const parts = {
    running: ["running now"],
    done: [`proposed ${plural(run.proposed, "change")}`, ...(consolidation ? [`applied ${consolidation.applied}`, `archived ${consolidation.archived}`] : []), ...(run.notes ? [run.notes] : [])],
    skipped: [`skipped${run.notes ? `: ${run.notes}` : ""}`],
    failed: [`failed${run.error ? `: ${run.error}` : ""}`],
  }[run.status]
  return { run: `#${run.runId}`, at: run.endedAt ?? run.startedAt, summary: clip(parts.join(" · "), 300) }
}

/**
 * Reads everything /today shows. Never throws: a source that fails adds a line to `notes` and its rows stay empty.
 * Asks only for what the client may read (docs/today.md): a remote client does not ask for PR reviews, a read-only one not for memory.
 */
export async function loadTodayData(source: TodaySource): Promise<TodayData> {
  const { now } = source
  const lastVisit = source.lastVisit && source.lastVisit > 0 ? source.lastVisit : now - FIRST_VISIT_WINDOW_MS
  const notes: string[] = []
  async function ask(label: string, command: CommandInput): Promise<Record<string, unknown> | undefined> {
    // Two reads of one source (the sessions) that fail alike leave one note.
    const note = (why: string) => { const text = `${label} could not be read: ${clip(why, 80)}.`; if (!notes.includes(text)) notes.push(text) }
    try {
      const reply = await source.send(command)
      if (reply.ok) return reply.result ?? {}
      note(reply.error.message.replace(/^\[[A-Z_-]+\]:\s*/, ""))
    } catch (error) {
      note(error instanceof Error ? error.message : String(error))
    }
    return undefined
  }

  const memoryReadable = !source.remote?.readOnly
  const reviewsReadable = source.reviews && !source.remote && !!source.sessionId
  if (source.reviews && source.remote) notes.push("PR reviews are local-only and are not listed here.")
  if (source.reviews && !source.remote && !source.sessionId) notes.push("PR reviews are listed once the session has started.")
  if (!memoryReadable) notes.push("This client is read-only: memory proposals and contradictions are not listed.")

  const [sessionsResult, waitingResult, jobsResult, workflowsResult, memoriesResult, graphResult, dreamResult] = await Promise.all([
    ask("Sessions", { type: "session.list", limit: SESSION_LIMIT, roots: true, hideEmpty: true, since: Math.max(0, now - PICKUP_WINDOW_MS) }),
    // Sessions waiting for the user, however old and however many newer ones there are: the pickup window must not hide them.
    ask("Sessions", { type: "session.list", limit: SESSION_LIMIT, roots: true, hideEmpty: true, state: "waiting" }),
    reviewsReadable ? ask("PR reviews", { type: "pr.review", sessionId: source.sessionId as never, action: "status" }) : undefined,
    ask("Workflows", { type: "workflow.list" }),
    memoryReadable ? ask("Memory", { type: "memory.list", session: "all", ...(source.directory ? { directory: source.directory } : {}) }) : undefined,
    memoryReadable ? ask("Memory contradictions", { type: "memory.graph", ...(source.directory ? { directory: source.directory } : {}) }) : undefined,
    ask("Dream", { type: "dream.list", ...(source.directory ? { directory: source.directory } : {}) }),
  ])

  const sessions = ((sessionsResult?.sessions as SessionSummary[] | undefined) ?? []).filter((session) => !session.archivedAt)
  const attending = new Map(sessions.map((session) => [session.sessionId, session]))
  for (const session of (waitingResult?.sessions as SessionSummary[] | undefined) ?? []) if (!session.archivedAt && !attending.has(session.sessionId)) attending.set(session.sessionId, session)
  const jobs = ((jobsResult?.dashboard as { jobs?: PrJobSummary[] } | undefined)?.jobs ?? []).slice(0, 500)
  const workflows = (workflowsResult?.workflows as WorkflowSummary[] | undefined) ?? []
  const memories = (memoriesResult?.memories as MemoryEntry[] | undefined) ?? []
  const graph = graphResult?.graph as MemoryGraphReport | undefined ?? (graphResult as MemoryGraphReport | undefined)
  const runs = (dreamResult?.runs as DreamRun[] | undefined) ?? []

  // The directories of sessions that finished: one `git.status` each (at most six), to tell a finished session with changes nobody reviewed.
  const finished = sessions.filter((session) => statusOf(session) === "completed" && !session.lifecycle?.pr)
  const directories = [...new Set(finished.map((session) => session.directory))].slice(0, MAX_DIRECTORIES)
  const git = new Map<string, Git>()
  await Promise.all(directories.map(async (directory) => {
    try {
      const reply = await source.send({ type: "git.status", directory })
      if (reply.ok) git.set(directory, { dirty: Number(reply.result?.dirty ?? 0), ahead: Number(reply.result?.ahead ?? 0) })
    } catch {
      // A folder git cannot read simply has no "uncommitted" row.
    }
  }))

  const saved = new Map(memories.filter((entry) => entry.status === "saved").map((entry) => [entry.memoryId as string, entry]))
  const attention = [
    ...[...attending.values()].flatMap((session) => attentionOfSession(session) ?? []),
    ...jobs.flatMap((job) => attentionOfJob(job) ?? []),
    ...workflows.flatMap((workflow) => attentionOfWorkflow(workflow) ?? []),
    ...(graph?.links ? attentionOfConflicts(graph) : []),
  ].sort((a, b) => a.since - b.since).slice(0, MAX_ATTENTION)
  const pickup = sessions
    .flatMap((session) => pickupOfSession(session, git) ?? [])
    .sort((a, b) => b.leftAt - a.leftAt)
    .slice(0, MAX_PICKUP)
  const memory = memories
    .filter((entry) => entry.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PROPOSALS)
    .map((entry) => proposalOf(entry, saved, runs))

  const ran = sessions.filter((session) => session.updatedAt >= lastVisit)
  const dream = dreamOf(runs)
  return {
    summary: {
      lastVisit,
      sessionsRan: ran.length,
      sessionsFinished: ran.filter((session) => statusOf(session) === "completed").length,
      projects: new Set(ran.map((session) => session.directory)).size,
      dreamRuns: runs.filter((run) => run.startedAt >= lastVisit).length,
      ...(dream ? { lastDreamAt: dream.at } : {}),
    },
    ...(dream ? { dream } : {}),
    attention,
    pickup,
    memory,
    ...(notes.length ? { notes } : {}),
  }
}

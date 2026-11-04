import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseTodoListText, redactSecrets, type SessionEvent, type SessionId, type TodoListItem } from "@mendcode/protocol"
import { compactList, MIN_SHORT_ID, shortSuffix } from "./session-list-text"

/**
 * An accepted or applied plan, kept as a Markdown file (docs/plan-review.md, "Plan files"). The file is written when the user
 * decides, by this observer of the session's events, and never when a session has no plan. The agent is told its path after a
 * compaction (it reads the plan from the file, not from a summary), other sessions list and read it with `sessions`, and the
 * session's own `todo` list is mirrored into its Progress block so the steps' state survives compaction too.
 */

export type PlanStatus = "accepted" | "applied" | "done"
export type PlanFile = { id: string; title: string; status: PlanStatus; session: string; project: string; saved: string; updated: string; steps?: { done: number; total: number }; /** Where the plan text is: this record, or the engine's own file. */ path: string; /** This record's own path, which differs from `path` when an engine keeps the text. */ record: string }

const PROGRESS_START = "<!-- progress:start -->"
const PROGRESS_END = "<!-- progress:end -->"
const MAX_LISTED = 50
const MAX_READ_BYTES = 64 * 1024
const MAX_PENDING = 16
const MAX_PROGRESS_ITEMS = 50
const STEP_MARK: Readonly<Record<TodoListItem["status"], string>> = { pending: "[ ]", in_progress: "[~]", done: "[x]", cancelled: "[-]" }
export const PLAN_ID = /^plan-[a-z0-9][a-z0-9-]{0,100}$/

const slugOf = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "plan"
const tail = (sessionId: string) => sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toLowerCase()
const realOf = (directory: string) => { try { return realpathSync(directory) } catch { return path.resolve(directory) } }

/** The folder of one project under the data directory: its name for the eye, a hash of its real path for stability. */
export const projectFolder = (directory: string) => {
  const real = realOf(directory)
  return `${slugOf(path.basename(real))}-${createHash("sha256").update(real).digest("hex").slice(0, 8)}`
}

function firstHeading(markdown: string) {
  return /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? markdown.split("\n").find((line) => line.trim())?.replace(/^[-*\d.\s]+/, "").trim() ?? ""
}

function render(meta: { title: string; status: PlanStatus; session: string; project: string; saved: string; updated: string; steps?: { done: number; total: number } | undefined; file?: string | undefined }, body: string, progress = "") {
  const front = ["---", `title: ${JSON.stringify(meta.title)}`, `status: ${meta.status}`, `session: ${meta.session}`, `project: ${JSON.stringify(meta.project)}`, `saved: ${meta.saved}`, `updated: ${meta.updated}`, ...(meta.file ? [`file: ${JSON.stringify(meta.file)}`] : []), ...(meta.steps ? [`steps: ${meta.steps.done}/${meta.steps.total}`] : []), "---", ""]
  return `${front.join("\n")}\n${body.trim()}\n${progress ? `\n${progress}\n` : ""}`
}

function parse(text: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return undefined
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":")
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const unquote = (value = "") => { try { return value.startsWith("\"") ? String(JSON.parse(value)) : value } catch { return value } }
  const status = fields.get("status")
  if (status !== "accepted" && status !== "applied" && status !== "done") return undefined
  const steps = /^(\d+)\/(\d+)$/.exec(fields.get("steps") ?? "")
  const rest = text.slice(match[0].length)
  const at = rest.indexOf(PROGRESS_START)
  return {
    ...(fields.get("file") ? { file: unquote(fields.get("file")) } : {}),
    title: unquote(fields.get("title")), status: status as PlanStatus, session: fields.get("session") ?? "", project: unquote(fields.get("project")), saved: fields.get("saved") ?? "", updated: fields.get("updated") ?? "",
    ...(steps ? { steps: { done: Number(steps[1]), total: Number(steps[2]) } } : {}),
    body: (at >= 0 ? rest.slice(0, at) : rest).trim(),
  }
}

const progressBlock = (items: readonly TodoListItem[]) => [PROGRESS_START, "## Progress", "", ...items.map((item) => `- ${STEP_MARK[item.status]} ${item.text.replace(/\s+/g, " ").trim()}`), PROGRESS_END].join("\n")

export const PLAN_HEADER = "id · status steps · age · title"

/** The id of a plan as a list prints it: `plan-` and the shortest end of the name (at least 8 characters, never starting with a dash) no other plan shares. `read` takes it as is. */
export function shortPlanId(id: string, universe: readonly string[]): string {
  const name = id.slice("plan-".length)
  let end = shortSuffix(name, universe.map((other) => other.slice("plan-".length)))
  while (end.startsWith("-") && end.length < name.length) end = name.slice(-(end.length + 1))
  return `plan-${end}`
}

/**
 * The plans `sessions plans=true` lists, grouped by project: a header, then `id · status steps · age · title`. The session and the
 * file are in the plan itself (`read=<id>`); `universe` is every plan id the short ids must stay unique among.
 */
export function planListLines(plans: readonly PlanFile[], now: number, universe: readonly string[] = plans.map((plan) => plan.id)): string[] {
  const everyone = [...new Set([...universe, ...plans.map((plan) => plan.id)])]
  return compactList({
    header: PLAN_HEADER,
    now,
    rows: plans.map((plan) => ({ id: shortPlanId(plan.id, everyone), state: `${plan.status}${plan.steps ? ` ${plan.steps.done}/${plan.steps.total}` : ""}`, at: Date.parse(plan.updated) || now, title: plan.title, folder: plan.project })),
  })
}

export function createPlanFiles(input: {
  /** The data directory; plans live in `<dir>/plans/<project>/` unless the project keeps them in the repository. */
  dir: string
  enabled(): boolean
  location(): "data" | "repo"
  directoryOf(sessionId: SessionId): string | undefined
  now(): number
}) {
  const dataFolder = (directory: string) => path.join(input.dir, "plans", projectFolder(directory))
  const repoFolder = (directory: string) => path.join(realOf(directory), ".mendcode", "plans")
  const folderFor = (directory: string) => (input.location() === "repo" ? repoFolder(directory) : dataFolder(directory))

  /** The requests a review is waiting on, so the reply can name the plan it decides (a reply carries its edits, not always the title). */
  const pending = new Map<string, { title: string; markdown: string; file?: string | undefined }>()
  const active = new Map<string, string>()
  const none = new Set<string>()
  /** Compactions seen per session since its pointer was last delivered. */
  const due = new Map<string, number>()
  const todoItems = new Set<string>()

  function write(file: string, text: string, folder: string) {
    mkdirSync(folder, { recursive: true, ...(input.location() === "data" ? { mode: 0o700 } : {}) })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, text, { mode: 0o600 })
    renameSync(temporary, file)
  }

  const entryOf = (file: string, text: string): PlanFile | undefined => {
    const parsed = parse(text)
    return parsed ? { id: path.basename(file, ".md"), title: parsed.title, status: parsed.status, session: parsed.session, project: parsed.project, saved: parsed.saved, updated: parsed.updated, ...(parsed.steps ? { steps: parsed.steps } : {}), path: parsed.file ?? file, record: file } : undefined
  }

  /** The plan files of one folder, newest first. */
  function scan(folder: string): PlanFile[] {
    let names: string[]
    try { names = readdirSync(folder).filter((name) => name.startsWith("plan-") && name.endsWith(".md")) } catch { return [] }
    const found: Array<{ entry: PlanFile; at: number }> = []
    for (const name of names) {
      const file = path.join(folder, name)
      try {
        const entry = entryOf(file, readFileSync(file, "utf8").slice(0, 2_048))
        if (entry) found.push({ entry, at: statSync(file).mtimeMs })
      } catch { /* a file that vanished or cannot be read is not a plan */ }
    }
    return found.sort((a, b) => b.at - a.at).map((item) => item.entry)
  }

  function save(sessionId: SessionId, plan: { title: string; markdown: string; comments?: string | undefined; file?: string | undefined; status: "accepted" | "applied" }) {
    const directory = input.directoryOf(sessionId)
    if (!directory) return
    const folder = folderFor(directory)
    const title = redactSecrets(plan.title || firstHeading(plan.markdown) || "Plan").text.replace(/\s+/g, " ").trim().slice(0, 200)
    const file = path.join(folder, `plan-${slugOf(title)}-${tail(sessionId)}.md`)
    const now = new Date(input.now()).toISOString()
    let saved = now
    try { saved = parse(readFileSync(file, "utf8"))?.saved ?? now } catch { /* a new plan */ }
    const comments = plan.comments?.trim() ? `\n\n## Review comments\n\n${redactSecrets(plan.comments.trim()).text}` : ""
    // An engine that already keeps the plan in a file (Claude Code) is registered, not copied: this record holds the state and names that file.
    const body = plan.file ? `# ${title}\n\nThe plan text is kept by the engine in ${plan.file}.${comments}` : `${/^#\s/.test(plan.markdown.trimStart()) ? "" : `# ${title}\n\n`}${redactSecrets(plan.markdown).text}${comments}`
    write(file, render({ title, status: plan.status, session: sessionId, project: realOf(directory), saved, updated: now, file: plan.file }, body), folder)
    active.set(sessionId, file)
    none.delete(sessionId)
  }

  /** The newest open plan this session accepted: from memory, else from the project's folders (once per session). */
  function activeFile(sessionId: SessionId): string | undefined {
    const known = active.get(sessionId)
    if (known) return known
    if (none.has(sessionId)) return undefined
    const directory = input.directoryOf(sessionId)
    const found = directory ? [...scan(folderFor(directory)), ...scan(input.location() === "repo" ? dataFolder(directory) : repoFolder(directory))].find((entry) => entry.session === sessionId && entry.status !== "done") : undefined
    if (found) active.set(sessionId, found.path)
    else none.add(sessionId)
    return found?.path
  }

  function mirror(sessionId: SessionId, text: string) {
    const file = activeFile(sessionId)
    if (!file) return
    try {
      const parsed = parse(readFileSync(file, "utf8"))
      const items = parseTodoListText(text).slice(0, MAX_PROGRESS_ITEMS)
      if (!parsed || !items.length) return
      const counted = items.filter((item) => item.status !== "cancelled")
      const done = counted.filter((item) => item.status === "done").length
      const finished = counted.length > 0 && done === counted.length
      write(file, render({ ...parsed, status: finished ? "done" : parsed.status, updated: new Date(input.now()).toISOString(), steps: { done, total: counted.length } }, parsed.body, progressBlock(items)), path.dirname(file))
      if (finished) { active.delete(sessionId); none.add(sessionId) }
    } catch { /* the plan file is a convenience: a failed write never reaches the session */ }
  }

  /** One line for the agent: where its plan is and how far it got. Not the plan. */
  function pointer(sessionId: SessionId): string | undefined {
    const file = activeFile(sessionId)
    if (!file) return undefined
    try {
      const entry = entryOf(file, readFileSync(file, "utf8").slice(0, 2_048))
      if (!entry || entry.status === "done") return undefined
      return `Plan file: ${entry.path} (${entry.status}${entry.steps ? `, ${entry.steps.done}/${entry.steps.total} steps done` : ""}${entry.path === file ? "" : `; progress in ${file}`}). Read it for the plan itself; the summary does not carry it.`
    } catch { return undefined }
  }

  return {
    observe(event: SessionEvent) {
      switch (event.type) {
        case "server.request":
          if (!event.planReview) return
          pending.set(event.requestId, { title: event.planReview.title ?? "", markdown: event.planReview.markdown, file: event.planReview.file })
          while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
          return
        case "server.request.resolved": {
          const asked = pending.get(event.requestId)
          pending.delete(event.requestId)
          const reply = event.planReview
          if (!reply || (reply.action !== "accept" && reply.action !== "apply") || !input.enabled()) return
          const markdown = reply.markdown ?? asked?.markdown
          if (!markdown) return
          try { save(event.sessionId, { title: asked?.title ?? "", markdown, comments: reply.comments, file: asked?.file, status: reply.action === "apply" ? "applied" : "accepted" }) } catch { /* see mirror */ }
          return
        }
        case "item.started":
          if (event.kind === "compaction") due.set(event.sessionId, (due.get(event.sessionId) ?? 0) + 1)
          else if (event.kind === "tool_call" && /^todo(?:\s|$)/.test(String(event.meta?.tool ?? ""))) {
            todoItems.add(event.itemId)
            while (todoItems.size > MAX_PENDING) todoItems.delete(todoItems.values().next().value!)
          }
          return
        case "item.completed":
          if (!todoItems.delete(event.itemId) || event.status !== "ok" || !event.text || !input.enabled()) return
          mirror(event.sessionId, event.text)
          return
        default:
      }
    },
    /** The plan's pointer for the first turn after a compaction (once), with `done` to call when that turn ran. Undefined when no compaction happened or the session has no open plan. */
    afterCompaction(sessionId: SessionId): { text: string; done(): void } | undefined {
      const seen = due.get(sessionId)
      if (seen === undefined || !input.enabled()) return undefined
      const text = pointer(sessionId)
      if (!text) { due.delete(sessionId); return undefined }
      // A compaction during the turn that carried the pointer is not covered by it: it stays due.
      return { text: `[${text}]`, done: () => { if (due.get(sessionId) === seen) due.delete(sessionId) } }
    },
    /** A summary the engine wrote carries the pointer: the next message need not. */
    anchored: (sessionId: SessionId) => void due.delete(sessionId),
    /** The same line without consuming anything, for a summary written by the engine. */
    pointer: (sessionId: SessionId) => input.enabled() ? pointer(sessionId) : undefined,
    /** The folder plans of this session's project are kept in (data location only: a repository folder is the project already). */
    roots(sessionId: SessionId): string[] {
      const directory = input.directoryOf(sessionId)
      return directory && input.enabled() && input.location() === "data" ? [dataFolder(directory)] : []
    },
    /** Plans of one project (newest first), or of every project kept in the data directory. */
    list(where: { directory?: string | undefined; all?: boolean | undefined }): PlanFile[] {
      if (!input.enabled()) return []
      if (where.all) {
        let folders: string[] = []
        try { folders = readdirSync(path.join(input.dir, "plans")).map((name) => path.join(input.dir, "plans", name)) } catch { /* no plan was ever saved */ }
        return folders.flatMap(scan).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, MAX_LISTED)
      }
      if (!where.directory) return []
      const both = [...scan(dataFolder(where.directory)), ...scan(repoFolder(where.directory))]
      return both.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, MAX_LISTED)
    },
    /** A plan by its id, from the project's folders first, then every project's in the data directory. */
    read(id: string, directory?: string): { ok: true; text: string; entry: PlanFile } | { ok: false; message: string } {
      if (!input.enabled()) return { ok: false, message: "plan files are off in this tier (/tier plan_files on)" }
      if (!PLAN_ID.test(id)) return { ok: false, message: `${id} is not a plan id (plan-…); sessions plans=true lists them` }
      const folders = [...(directory ? [dataFolder(directory), repoFolder(directory)] : [])]
      try { for (const name of readdirSync(path.join(input.dir, "plans"))) folders.push(path.join(input.dir, "plans", name)) } catch { /* none */ }
      // A short id (what lists print) is `plan-` and the end of the name: it names the one plan whose name ends that way.
      let wanted = id
      if (id.length - "plan-".length >= MIN_SHORT_ID && !folders.some((folder) => existsSync(path.join(folder, `${id}.md`)))) {
        const end = `${id.slice("plan-".length)}.md`
        const hits = new Set<string>()
        for (const folder of folders) {
          try { for (const name of readdirSync(folder)) if (name.startsWith("plan-") && name.endsWith(end)) hits.add(name.slice(0, -".md".length)) } catch { /* no such folder */ }
        }
        if (hits.size === 1) wanted = [...hits][0]!
      }
      for (const folder of folders) {
        const file = path.join(folder, `${wanted}.md`)
        try {
          const text = readFileSync(file, "utf8")
          const entry = entryOf(file, text)
          // A record that names an engine's own file: the state here, the plan text there.
          if (entry && entry.path !== file) {
            let plan = "(the engine's plan file is gone)"
            try { plan = readFileSync(entry.path, "utf8") } catch { /* said above */ }
            return { ok: true, text: `${text}\n\n---\n\n${plan}`.slice(0, MAX_READ_BYTES), entry }
          }
          if (entry) return { ok: true, text: text.length > MAX_READ_BYTES ? `${text.slice(0, MAX_READ_BYTES)}\n[truncated; the file holds the rest]` : text, entry }
        } catch { /* try the next folder */ }
      }
      return { ok: false, message: `no plan ${id}; sessions plans=true lists them` }
    },
  }
}

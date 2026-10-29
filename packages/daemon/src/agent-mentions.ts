import type { SessionId, TaskRecord } from "@mendcode/protocol"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"

const MENTION = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9_-]*)(?=[\s.,;:!?)]|$)/g
const LEADING = /^\s*@([A-Za-z0-9][A-Za-z0-9_-]*)(?=[\s.,;:!?)]|$)[\s,:;]*/
const MAX_MENTIONS = 4
/** Messages one running child may hold for its next generation; a fifth is refused rather than growing without bound. */
const MAX_PENDING = 4
const ACTIVE = new Set(["queued", "running", "needs_input"])

/** The sub-agents `@name` addresses in `text`, in order of first mention; `known` are the names the session can delegate to. */
export function mentionedAgents(text: string, known: readonly string[]): string[] {
  const names = new Set(known)
  const found: string[] = []
  for (const match of text.matchAll(MENTION)) {
    const name = match[1]!
    if (names.has(name) && !found.includes(name)) found.push(name)
  }
  return found.slice(0, MAX_MENTIONS)
}

/**
 * `@agent` in a prompt hands that part of the work to the sub-agent: the text goes to the model unchanged, followed by a
 * note that tells it to run the named agent through the task tool. Text without a known mention is returned as it is.
 */
export function expandAgentMentions(input: { text: string; known: readonly string[] }): string {
  const names = mentionedAgents(input.text, input.known)
  if (!names.length) return input.text
  const notes = names.map((name) => `<agent-mention name="${name}">The user addressed @${name}. Delegate the part of this request meant for it to the "${name}" sub-agent with the task tool (agent: "${name}") and use its result.</agent-mention>`)
  return `${input.text}\n\n${notes.join("\n")}`
}

/** A prompt that opens with `@name` of a known sub-agent speaks to it: the name and the message after it (empty: nothing to send). */
export function leadingMention(text: string, known: readonly string[]): { name: string; message: string } | undefined {
  const match = LEADING.exec(text)
  if (!match || !known.includes(match[1]!)) return undefined
  const message = text.slice(match[0].length).trim()
  return message ? { name: match[1]!, message } : undefined
}

export type MentionDelivery = { delivery: "delivered" | "queued"; task: TaskRecord }

/**
 * `@name message` to a sub-agent this session already ran (`agentMentions: "address"`): the message continues that child's
 * own conversation instead of asking the parent's model to start another one. An idle child resumes at once as its next
 * generation in the background (`delivered`), so the parent is told when it ends like any background child. A child that is
 * still working keeps the message until its current generation ends and then resumes with it (`queued`). Held messages are
 * kept in `file` (when given) as well: a daemon restart interrupts the child, and the restarted daemon resumes it with them.
 */
export function createMentionRouting(options: {
  /** The children of a session, newest last. */
  children(parentId: SessionId): TaskRecord[]
  /** One child by id, for the messages a restart left held. */
  task?(taskId: SessionId): TaskRecord | undefined
  /** Continues `task` with `prompt` as a background generation. */
  resume(parentId: SessionId, task: TaskRecord, prompt: string): Promise<TaskRecord>
  /** A held message could not be sent when its child settled: the parent hears why. */
  failed(parentId: SessionId, task: TaskRecord, message: string): void
  /** Where held messages survive a restart (mode 0600); without it they live in memory only. */
  file?: string
}) {
  const held = new Map<SessionId, { parentId: SessionId; messages: string[] }>()

  function save() {
    if (!options.file) return
    try {
      if (!held.size) return void rmSync(options.file, { force: true })
      const temporary = `${options.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify([...held]), { mode: 0o600 })
      renameSync(temporary, options.file)
    } catch { /* a full disk loses the copy, never the message in memory */ }
  }

  async function send(parentId: SessionId, name: string, message: string): Promise<MentionDelivery | undefined> {
    const task = options.children(parentId).filter((child) => child.agent === name).sort((a, b) => a.updatedAt - b.updatedAt).at(-1)
    if (!task) return undefined
    if (ACTIVE.has(task.state)) {
      const entry = held.get(task.taskId) ?? { parentId, messages: [] }
      if (entry.messages.length >= MAX_PENDING) throw new Error(`@${name} already holds ${MAX_PENDING} messages; wait for its current step to end`)
      entry.messages.push(message)
      held.set(task.taskId, entry)
      save()
      return { delivery: "queued", task }
    }
    return { delivery: "delivered", task: await options.resume(parentId, task, message) }
  }

  /**
   * Called on every change of a child: once it settles, what it holds resumes it, after the pass that closes the child's turn
   * (the change arrives inside it).
   */
  function settled(task: TaskRecord) {
    const entry = held.get(task.taskId)
    if (!entry || ACTIVE.has(task.state)) return
    held.delete(task.taskId)
    save()
    const prompt = entry.messages.join("\n\n")
    queueMicrotask(() => {
      void options.resume(entry.parentId, task, prompt).catch((error: unknown) => options.failed(entry.parentId, task, `${error instanceof Error ? error.message : String(error)}\n\nUndelivered message:\n${prompt}`))
    })
  }

  // Messages a previous daemon held: their children were interrupted by the restart, so each resumes with them now.
  if (options.file) {
    try {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as Array<[SessionId, { parentId: SessionId; messages: string[] }]>
      for (const [taskId, entry] of saved.slice(0, 200)) if (entry && Array.isArray(entry.messages)) held.set(taskId, { parentId: entry.parentId, messages: entry.messages.filter((m) => typeof m === "string").slice(0, MAX_PENDING) })
    } catch { /* none saved */ }
    for (const taskId of [...held.keys()]) {
      const task = options.task?.(taskId)
      if (task) settled(task)
      else held.delete(taskId)
    }
    save()
  }

  return { send, settled, pending: (taskId: SessionId) => held.get(taskId)?.messages.length ?? 0 }
}

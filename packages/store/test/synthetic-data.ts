import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "../src"

/**
 * Deterministic synthetic history shaped like real use: tool outputs of source code and logs, model history that repeats
 * those outputs, streaming deltas, and per-turn file snapshots of a repository every session starts from. Not real user
 * data and not a promise about any one user's disk: the ratios come from text that looks like code and logs.
 */

function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}
export type Rng = ReturnType<typeof prng>

const WORDS = ["session", "store", "event", "payload", "turn", "item", "tool", "result", "stream", "buffer", "config", "client", "daemon", "request", "reply", "state", "queue", "cache", "index", "token"]
const pick = <T>(rng: Rng, list: readonly T[]) => list[Math.floor(rng() * list.length)]!

/** TypeScript-looking source of about `bytes` characters. */
export function codeText(rng: Rng, bytes: number): string {
  const out: string[] = []
  let size = 0
  while (size < bytes) {
    const a = pick(rng, WORDS)
    const b = pick(rng, WORDS)
    const line =
      rng() < 0.25
        ? `export function ${a}${b[0]!.toUpperCase()}${b.slice(1)}(input: ${a}Input, ${b}: number = ${Math.floor(rng() * 500)}): ${b}Result {`
        : rng() < 0.4
          ? `  const ${a} = await ctx.${b}.read(${JSON.stringify(`${a}-${Math.floor(rng() * 9999)}`)}, { limit: ${Math.floor(rng() * 90)} })`
          : rng() < 0.6
            ? `  if (!${a}.${b}) throw new RangeError("[${a.toUpperCase()}]: ${b} is ${Math.floor(rng() * 1000)} out of range")`
            : rng() < 0.8
              ? `  // ${a} ${b} ${pick(rng, WORDS)} must stay ${pick(rng, WORDS)} when ${pick(rng, WORDS)} is ${pick(rng, WORDS)}`
              : `  return { ${a}, ${b}, count: ${Math.floor(rng() * 100000)}, at: ${Math.floor(rng() * 1e12)} }`
    out.push(line)
    size += line.length + 1
  }
  return out.join("\n").slice(0, bytes)
}

/** Test-runner / build log output of about `bytes` characters. */
export function logText(rng: Rng, bytes: number): string {
  const out: string[] = []
  let size = 0
  while (size < bytes) {
    const line = `[${new Date(1_790_000_000_000 + Math.floor(rng() * 86_400_000)).toISOString()}] ${pick(rng, ["PASS", "PASS", "PASS", "INFO", "WARN"])} packages/${pick(rng, WORDS)}/test/${pick(rng, WORDS)}.test.ts ${pick(rng, WORDS)} ${pick(rng, WORDS)} (${Math.floor(rng() * 90)}ms)`
    out.push(line)
    size += line.length + 1
  }
  return out.join("\n").slice(0, bytes)
}

export function proseText(rng: Rng, bytes: number): string {
  const out: string[] = []
  let size = 0
  while (size < bytes) {
    const word = pick(rng, WORDS)
    out.push(word)
    size += word.length + 1
  }
  return out.join(" ").slice(0, bytes)
}

/** A repository of files every session starts from (so their "before" snapshots repeat across sessions). */
export function syntheticRepo(files = 40, fileBytes = 6_000): Map<string, string> {
  const rng = prng(7)
  return new Map(Array.from({ length: files }, (_, i) => [`src/module-${i}.ts`, codeText(rng, fileBytes)] as const))
}

/** The same file with a few lines changed: what an edit leaves behind. */
function edited(rng: Rng, content: string): string {
  const lines = content.split("\n")
  for (let i = 0; i < 3; i++) lines[Math.floor(rng() * lines.length)] = `  // edited ${Math.floor(rng() * 1e9)} ${pick(rng, WORDS)}`
  return lines.join("\n")
}

export type SyntheticShape = {
  turns: number
  toolCallsPerTurn: number
  readBytes: number
  shellBytes: number
  deltasPerMessage: number
  messageBytes: number
  filesPerTurn: number
}

/** Moderate sessions: a dozen turns, three tool calls each. Real heavy sessions are larger, short ones smaller. */
export const TYPICAL_SESSION: SyntheticShape = { turns: 8, toolCallsPerTurn: 3, readBytes: 6_000, shellBytes: 2_500, deltasPerMessage: 6, messageBytes: 1_500, filesPerTurn: 2 }

export type SyntheticStore = ReturnType<typeof createSynthetic>

/** Opens a store in `dir` and returns helpers that write sessions the way the daemon does. */
export function createSynthetic(options: { dir: string; compress: boolean; pageSize?: number; now?: () => number; repo?: Map<string, string> }) {
  const store: Store = openStore({ dir: options.dir, compress: options.compress, ...(options.pageSize ? { pageSize: options.pageSize } : {}), ...(options.now ? { now: options.now } : {}) })
  const ids = createIdFactory()
  const repo = options.repo ?? syntheticRepo()
  const repoPaths = [...repo.keys()]
  /** Per session, for each turn: its id and how many model messages the history held once it ended (the cut a fork there needs). */
  const marks = new Map<SessionId, Array<{ turnId: string; messages: number }>>()

  function session(index: number, shape: SyntheticShape = TYPICAL_SESSION, directory = "/work/project"): SessionId {
    const rng = prng(1000 + index)
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory, title: `session ${index}` })
    const working = new Map<string, string>()
    const history: unknown[] = []
    const ended: Array<{ turnId: string; messages: number }> = []
    marks.set(sessionId, ended)
    for (let t = 0; t < shape.turns; t++) {
      const turnId = ids("turn")
      store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      const userItem = ids("item")
      const request = proseText(rng, 300)
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: userItem, kind: "user_message" })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: userItem, status: "ok", text: request })
      history.push({ role: "user", content: request })
      for (let c = 0; c < shape.toolCallsPerTurn; c++) {
        const item = ids("item")
        const kind = c % 3
        const tool = kind === 0 ? "read" : kind === 1 ? "shell" : "edit"
        const output = kind === 0 ? codeText(rng, shape.readBytes) : kind === 1 ? logText(rng, shape.shellBytes) : "edited 1 file"
        store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: item, kind: "tool_call", meta: { tool } })
        store.sessionSink.append({ type: "item.completed", sessionId, itemId: item, status: "ok", text: output, toolInput: JSON.stringify({ path: pick(rng, repoPaths) }) })
        history.push({ role: "assistant", content: "", toolCalls: [{ id: item, name: tool, input: { path: "x" } }] }, { role: "tool", toolCallId: item, content: output })
      }
      const message = ids("item")
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: message, kind: "agent_message" })
      const answer = proseText(rng, shape.messageBytes)
      const slice = Math.ceil(answer.length / shape.deltasPerMessage)
      for (let d = 0; d < shape.deltasPerMessage; d++) store.sessionSink.append({ type: "item.delta", sessionId, itemId: message, text: answer.slice(d * slice, (d + 1) * slice) })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: message, status: "ok", text: answer })
      history.push({ role: "assistant", content: answer })
      store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "faux", model: "faux-1", input: 4000, output: 600, reasoning: 0, cacheRead: 3000, cacheWrite: 0 })
      for (let f = 0; f < shape.filesPerTurn; f++) {
        const file = pick(rng, repoPaths)
        const before = working.get(file) ?? repo.get(file)!
        const after = edited(rng, before)
        const encoder = new TextEncoder()
        store.turns.files.captureBefore(sessionId, turnId, file, { state: "content", content: encoder.encode(before) })
        store.turns.files.seal(sessionId, turnId, file, { state: "content", content: encoder.encode(after) })
        working.set(file, after)
      }
      store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
      ended.push({ turnId, messages: history.length })
    }
    store.engineMessages.save(sessionId, "native", history)
    return sessionId
  }

  /**
   * A fork of `source` through its turn number `throughTurn` (0-based; the last turn by default), made the way the daemon
   * makes one. Returns the new session and how many model messages it carries.
   */
  function fork(source: SessionId, throughTurn?: number): { sessionId: SessionId; messages: number } {
    const ended = marks.get(source)
    if (!ended?.length) throw new RangeError("[SYNTHETIC]: not a synthetic session")
    const through = throughTurn ?? ended.length - 1
    const turn = ended[through]!
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/work/project", title: `fork of ${source}` })
    store.forkConversation(source, sessionId, { throughTurnId: turn.turnId, cuts: { native: turn.messages } })
    marks.set(sessionId, ended.slice(0, through + 1))
    return { sessionId, messages: turn.messages }
  }

  return { store, session, fork }
}

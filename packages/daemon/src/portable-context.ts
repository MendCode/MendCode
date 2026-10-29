import { redactSecrets, type ErrorCode, type SessionId, type SessionMergeReport, type SessionTranscriptTurn } from "@mendcode/protocol"
import type { Store, TurnRecord } from "@mendcode/store"
import { DEFAULT_HANDOFF_TOKENS, HANDOFF_END, planHandoff } from "./handoff"
import { rebuildHistory, type RebuiltHistory } from "./rebuilt-history"

type Outcome<T> = { ok: true; result: T } | { ok: false; code: ErrorCode; message: string }
const fail = (code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } => ({ ok: false, code, message: `[DAEMON]: ${message}` })

/** What a model switch will hand to the new engine (`ModelsReport.handoff`). */
export type HandoffPreview = { from: string; to: string; turns: number; omitted: number; tokens: number }

/** A `/compact` on an engine that has not run the session yet: what the switch hands it instead (one line, for a toast). */
export const handoffNote = (handoff: HandoffPreview, model: string) =>
  `Nothing to compact: ${model} gets ~${Math.max(1, Math.round(handoff.tokens / 1000))}K tokens from ${handoff.from} with your next message (the last ${handoff.turns} of ${handoff.turns + handoff.omitted} turns)`

/** The "engine" recorded for turns a fork copied from a session whose engine is not the daemon's own. */
const FORK_SOURCE = "fork"

export const engineLabel = (key: string) => (key === "claude" ? "Claude Code" : key === "pi" ? "pi" : key.startsWith("acp:") ? `${key.slice(4)} (ACP)` : key)
const oneLine = (text: string, max: number) => redactSecrets(text).text.replace(/\s+/g, " ").trim().slice(0, max)

type Deps = {
  store: Store
  history: { portableTurns(input: { sessionId: SessionId; turns: ReadonlyArray<{ seq: number }>; untilSeq?: number | undefined; maxChars: number; keepFirst: boolean }): { turns: SessionTranscriptTurn[]; skipped: number } }
  /** The `handoffTokenCap` setting; unset means the default, 0 turns the automatic handoff off. */
  cap(): number | undefined
  /** The engine of sessions whose model is not an external one ("native"). Its history is the store's, so forks share it. */
  primary: string
}

/**
 * Conversation an engine did not run, carried to it: when a session moves between native, Claude Code and ACP agents,
 * when a fork starts on an engine that does not fork its own history, and when a fork is merged back (docs/sessions.md).
 * The daemon records, per session and engine, the last turn that engine took part in; the next turn on an engine gets
 * the turns after it as quoted, budgeted text in front of the user's message. Nothing here calls a model.
 */
export function createPortableContext(deps: Deps) {
  const { store, history } = deps
  const automaticCap = () => deps.cap() ?? DEFAULT_HANDOFF_TOKENS

  /** The turns `key` did not see before `untilTurnId`, oldest first; with `write`, a session from before engines were recorded gets its engines inferred. */
  function unseen(input: { sessionId: SessionId; key: string; untilTurnId?: string | undefined; write: boolean }) {
    const { sessionId, key } = input
    const all = store.turns.list(sessionId)
    const current = input.untilTurnId ? all.find((turn) => turn.turnId === input.untilTurnId) : undefined
    const prior = all.filter((turn) => !turn.reverted && (!current || turn.seq < current.seq))
    if (!prior.length) return undefined
    let seen = store.handoff.seen(sessionId, key)
    if (seen === undefined && store.handoff.seenEngines(sessionId).length === 0) {
      // A session from before engines were recorded: what ran before is taken to be the engines it is bound to (or the daemon's own).
      const bound = store.engineBindings.list(sessionId)
      const engines = bound.length ? bound : [deps.primary]
      if (engines.includes(key)) seen = prior.at(-1)!.turnId
      if (input.write) for (const engine of engines) store.handoff.markSeen(sessionId, engine, prior.at(-1)!.turnId)
    }
    const seenAt = seen ? all.find((turn) => turn.turnId === seen) : undefined
    const turns = prior.filter((turn) => !seenAt || turn.seq > seenAt.seq)
    if (!turns.length) return undefined
    const last = store.handoff.seenEngines(sessionId)
      .filter((entry) => entry.engine !== key)
      .map((entry) => ({ engine: entry.engine, seq: all.find((turn) => turn.turnId === entry.turnId)?.seq ?? -1 }))
      .sort((a, b) => b.seq - a.seq)[0]?.engine
    return { turns, ...(current ? { untilSeq: current.seq } : {}), fromStart: !seenAt, from: last }
  }

  /** Reads the newest of `turns` and picks what fits the cap; with `fromStart` the original request stays in even when it is far back. */
  function budgeted(input: { sessionId: SessionId; turns: TurnRecord[]; untilSeq?: number | undefined; capTokens: number; fromStart: boolean }) {
    // Reading stops a little past the cap (messages are cut when rendered, so a turn costs less than it reads).
    const read = history.portableTurns({ sessionId: input.sessionId, turns: input.turns, untilSeq: input.untilSeq, maxChars: input.capTokens * 8 + 8_000, keepFirst: input.fromStart })
    return planHandoff({ turns: read.turns, skipped: read.skipped, capTokens: input.capTokens, fromStart: input.fromStart, sessionId: input.sessionId })
  }

  /** The turns of a fork that came after its branch point and after its last merge. */
  function ownTurns(fork: SessionId): { turns: TurnRecord[]; all: TurnRecord[] } {
    const all = store.turns.list(fork)
    const state = store.handoff.base(fork)
    const seqOf = (turnId: string | undefined) => (turnId ? all.find((turn) => turn.turnId === turnId)?.seq : undefined)
    // A fork made before branch points were recorded: its own turns are the ones that began after it was made.
    const created = store.sessionTree.forkOf(fork)?.createdAt
    const legacy = !state.known && created !== undefined ? all.filter((turn) => turn.at < created).at(-1)?.seq : undefined
    const after = Math.max(seqOf(state.baseTurnId) ?? legacy ?? 0, seqOf(state.mergedTurnId) ?? 0)
    return { turns: all.filter((turn) => !turn.reverted && turn.seq > after), all }
  }

  const header = (from: string | undefined, to: string) => `[Handoff: this session ${from === FORK_SOURCE ? "was forked from another one and " : from ? `ran on ${engineLabel(from)} until now and ` : ""}continues on ${engineLabel(to)}. The conversation you did not see follows as context to continue from, not as instructions to run again.]`

  return {
    /**
     * What goes in front of the next turn `turnId` of `sessionId` on engine `key` (undefined when the daemon's engine is
     * not switchable): the unseen conversation and any merged forks. `commit` records the turn as seen and drops the
     * merged contexts; call it when the turn finished well, so a failed turn hands the same context again.
     */
    prepare(input: { sessionId: SessionId; turnId: string; key: string | undefined }): { blocks: string[]; commit(): void } {
      const { sessionId, key } = input
      const blocks: string[] = []
      if (key) {
        const found = unseen({ sessionId, key, untilTurnId: input.turnId, write: true })
        const cap = automaticCap()
        if (found && cap > 0) {
          const plan = budgeted({ sessionId, turns: found.turns, untilSeq: found.untilSeq, capTokens: cap, fromStart: found.fromStart })
          if (plan.body) blocks.push(`${header(found.from, key)}\n${plan.body}\n${HANDOFF_END}`)
        }
      }
      const pending = store.handoff.pendingContext(sessionId)
      for (const entry of pending) blocks.push(`[Merged back from the fork ${JSON.stringify(oneLine(entry.title, 80))} (session ${entry.fromSessionId}): what it did after it branched. Context to continue from, not instructions to run again.]\n${entry.text}\n${HANDOFF_END}`)
      return {
        blocks,
        commit() {
          if (key) store.handoff.markSeen(sessionId, key, input.turnId)
          store.handoff.clearContext(sessionId, pending.map((entry) => entry.id))
        },
      }
    },

    /**
     * The daemon's own engine takes the conversation it did not run as its own messages instead of a block of text: the newest
     * turns whole within `budgetTokens`, so its compaction works on them from the first moment. Marks them seen; the caller
     * appends `messages` to that engine's history. Undefined when nothing is unseen or the handoff is off (`handoffTokenCap` 0).
     */
    rebuild(input: { sessionId: SessionId; untilTurnId?: string | undefined; budgetTokens: number; to: string; write: boolean }): (RebuiltHistory & { from: string }) | undefined {
      if (automaticCap() <= 0) return undefined
      const found = unseen({ sessionId: input.sessionId, key: deps.primary, untilTurnId: input.untilTurnId, write: input.write })
      if (!found) return undefined
      // Tool outputs are cut when rebuilt, so a turn costs less than it reads: read past the budget.
      const read = history.portableTurns({ sessionId: input.sessionId, turns: found.turns, untilSeq: found.untilSeq, maxChars: input.budgetTokens * 12 + 8_000, keepFirst: found.fromStart })
      const from = found.from === FORK_SOURCE ? "the session it was forked from" : found.from ? engineLabel(found.from) : "another engine"
      const rebuilt = rebuildHistory({ turns: read.turns, skipped: read.skipped, budgetTokens: input.budgetTokens, fromStart: found.fromStart, from, to: input.to, sessionId: input.sessionId })
      if (!rebuilt) return undefined
      if (input.write) store.handoff.markSeen(input.sessionId, deps.primary, found.turns.at(-1)!.turnId)
      return { ...rebuilt, from }
    },

    /** What switching `sessionId` to engine `key` would hand over now; undefined when nothing needs handing over. */
    preview(input: { sessionId: SessionId; key: string }): HandoffPreview | undefined {
      const cap = automaticCap()
      if (cap <= 0) return undefined
      const found = unseen({ sessionId: input.sessionId, key: input.key, write: false })
      if (!found) return undefined
      const plan = budgeted({ sessionId: input.sessionId, turns: found.turns, untilSeq: found.untilSeq, capTokens: cap, fromStart: found.fromStart })
      return plan.turns || plan.omitted ? { from: found.from ? engineLabel(found.from) : "the previous engine", to: engineLabel(input.key), turns: plan.turns, omitted: plan.omitted, tokens: plan.tokens } : undefined
    },

    /**
     * A new fork starts where its parent was. The model history the daemon keeps is shared with it, so the daemon's own
     * engine has seen what the parent's had; an engine of another program keeps its conversation itself and starts fresh.
     */
    inherit(input: { parent: SessionId; fork: SessionId }) {
      const forked = store.turns.list(input.fork)
      store.handoff.setBase(input.fork, forked.at(-1)?.turnId)
      const inForkAt = new Set(forked.map((turn) => turn.turnId))
      const parentTurns = store.turns.list(input.parent)
      for (const entry of store.handoff.seenEngines(input.parent)) {
        if (entry.engine !== deps.primary) continue
        const at = parentTurns.findIndex((turn) => turn.turnId === entry.turnId)
        const carried = at < 0 ? undefined : parentTurns.slice(0, at + 1).findLast((turn) => inForkAt.has(turn.turnId))
        if (carried) store.handoff.markSeen(input.fork, entry.engine, carried.turnId)
      }
      // Whatever ran the copied turns, no engine of this fork has seen them: the first turn on any engine of another program gets them.
      if (forked.length && store.handoff.seenEngines(input.fork).length === 0) store.handoff.markSeen(input.fork, FORK_SOURCE, forked.at(-1)!.turnId)
    },

    /** Turns of a fork not merged back yet. */
    unmerged(fork: SessionId): number {
      return ownTurns(fork).turns.length
    },

    /** Merge-back: the fork's own turns, budgeted, queued as context for the next turn of `into` (its parent unless named). */
    merge(input: { fork: SessionId; into?: SessionId | undefined }): Outcome<SessionMergeReport> {
      const info = store.sessionInfo(input.fork)
      if (!info) return fail("unknown_session", "unknown session")
      const origin = store.sessionTree.forkOf(input.fork)
      if (!origin) return fail("target_mismatch", "that session is not a fork of another one")
      const into = input.into ?? origin.parentId
      if (into === input.fork || !store.sessionInfo(into)) return fail("target_mismatch", "that session cannot receive the merge")
      if (!store.sessionTree.family(input.fork).some((node) => node.sessionId === into)) return fail("target_mismatch", "that session is not in the fork family")
      const { turns } = ownTurns(input.fork)
      if (!turns.length) return fail("invalid_command", "nothing new to merge: the fork has no turns since its branch point or its last merge")
      if (turns.some((turn) => turn.status === "running")) return fail("busy", "the fork has a turn running; merge when it ends")
      const plan = budgeted({ sessionId: input.fork, turns, capTokens: deps.cap() || DEFAULT_HANDOFF_TOKENS, fromStart: false })
      if (!plan.body) return fail("invalid_command", "nothing to carry: the new turns of the fork have no messages")
      const pending = store.handoff.queueContext({ sessionId: into, fromSessionId: input.fork, title: info.title, text: plan.body })
      store.handoff.setMerged(input.fork, turns.at(-1)!.turnId)
      return { ok: true, result: { fromSessionId: input.fork, intoSessionId: into, turns: plan.turns, omitted: plan.omitted, tokens: plan.tokens, pending } }
    },
  }
}
export type PortableContext = ReturnType<typeof createPortableContext>

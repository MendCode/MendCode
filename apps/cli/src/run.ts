import type { Client, CommandReply } from "@mendcode/client"
import type { QueueId, SessionEvent, SessionId } from "@mendcode/protocol"
import { compatEnvelope } from "./compat"

export type RunOptions = {
  client: Client
  sessionId: SessionId
  prompt: string
  json: boolean
  compat?: boolean
  approve: boolean
  /** `--dangerously-skip-permissions`: also allows a command the engine itself flagged in full access, which `approve` alone rejects. */
  skipPermissions?: boolean
  thinking?: boolean
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  submit?(): Promise<CommandReply>
  /** Holds the answer back from stdout until `finish` (a schema run prints only the validated JSON). */
  hold?: boolean
  /** Receives the final message of a completed turn (validation, `--output-last-message`); a failure ends the run. */
  finish?(message: string): Promise<import("./run-output").RunFinish>
}

/** What the model reads when a headless run without `--dangerously-skip-permissions` meets a command the engine flagged. */
export const ENGINE_FLAGGED_DENIAL = "headless run: the engine flagged this command as dangerous and --approve does not cover that; the command was not run. Choose a safer approach, or the operator can rerun with --dangerously-skip-permissions"

/**
 * 0 completed, 1 failed (also unwritable output file), 2 stopped, 3 answer rejected by --output-schema, 4 turn limit (--max-turns),
 * 5 the turn completed but an approval was denied for lack of --approve and no tool call succeeded after it; 64 is a usage error before any run.
 * 5 is free in `session send --wait` too, where 3 is a timeout and 4 a workflow that needs the user (automation.ts).
 */
export const EXIT = { completed: 0, failed: 1, stopped: 2, schema: 3, limit: 4, denied: 5 } as const

/**
 * Headless turn for scripts, CI and VPS use: submits one prompt, streams only that turn's events,
 * answers approvals by policy (deny unless --approve) and resolves with an exit code.
 */
export function createHeadlessRun(options: RunOptions) {
  let sessionId = options.sessionId
  let queueId: string | undefined
  let turnId: string | undefined
  let settle!: (code: number) => void
  let finished = false
  const done = new Promise<number>((resolve) => (settle = (code) => { finished = true; resolve(code) }))
  const buffered: SessionEvent[] = []
  /** Only the answer goes to stdout; tools, reasoning and compaction are progress on stderr. */
  const answerItems = new Set<string>()
  const reasoningItems = new Set<string>()
  /** Reasoning items that printed text: thinking the provider keeps to itself prints nothing, not an empty `Thinking:` line. */
  const reasoningShown = new Set<string>()
  let answered = false
  /** Text of each answer item, in order, so the last message is known when the turn ends. */
  const answerText = new Map<string, string>()
  const quiet = options.json || options.hold === true
  const toolItems = new Set<string>()
  /** Tool calls refused because `--approve` was not passed; their own completion is not work that succeeded. */
  const deniedItems = new Set<string>()
  /** An approval was denied for lack of `--approve` and no tool call has succeeded since: the turn ends as `EXIT.denied`. */
  let blocked = false

  /** The turn's last event arrived; the run settles after `finish`, and nothing after that event belongs to the turn. */
  let ended = false

  function handle(event: SessionEvent) {
    if (finished || ended || event.sessionId !== sessionId) return
    if (!turnId) {
      if (event.type === "turn.started" && queueId && (event.queueId === queueId || event.joinedQueueIds?.includes(queueId as QueueId))) turnId = event.turnId
      else return
    }
    if ("turnId" in event && event.turnId !== turnId) return
    if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted") ended = true
    if (options.json) {
      const output = options.compat
        ? event.type === "turn.completed"
          ? compatEnvelope({ kind: "result", command: "session.completed", data: { sessionId: event.sessionId, status: "completed", ...(blocked ? { approvalDenied: true } : {}) } }, event.at)
          : event.type === "turn.failed"
            ? compatEnvelope({ kind: "error", command: "run", error: { ...event.error, sessionId: event.sessionId } }, event.at)
            : compatEnvelope({ kind: "event", event })
        : event
      options.out.write(`${JSON.stringify(output)}\n`)
    }
    switch (event.type) {
      case "item.started":
        if (event.kind === "agent_message") {
          // Separate answers of successive model steps so they never run together.
          if (answered && !quiet) options.out.write("\n\n")
          answerItems.add(event.itemId)
          answerText.set(event.itemId, "")
          answered = true
        } else if (event.kind === "reasoning" && options.thinking) {
          reasoningItems.add(event.itemId)
        } else if (event.kind === "tool_call") {
          toolItems.add(event.itemId)
          if (!options.json) options.err.write(`◆ ${String(event.meta?.tool ?? "tool")}\n`)
        } else if (!options.json && event.kind === "compaction") options.err.write("◆ compacting context\n")
        break
      case "item.delta":
        if (answerItems.has(event.itemId)) {
          answerText.set(event.itemId, (answerText.get(event.itemId) ?? "") + event.text)
          if (!quiet) options.out.write(event.text)
        } else if (!options.json && reasoningItems.has(event.itemId) && event.text) {
          if (!reasoningShown.has(event.itemId)) options.out.write("Thinking: ")
          reasoningShown.add(event.itemId)
          options.out.write(event.text)
        }
        break
      case "item.completed":
        if (answerItems.has(event.itemId) && !answerText.get(event.itemId) && event.text) answerText.set(event.itemId, event.text)
        if (!options.json && reasoningShown.has(event.itemId)) options.out.write("\n")
        // The model went on and something ran: the denial did not decide the turn.
        if (event.status === "ok" && toolItems.has(event.itemId) && !deniedItems.has(event.itemId)) blocked = false
        break
      case "server.request":
        if (event.turnId !== turnId) break
        if (event.kind === "question") {
          if (!options.json) options.err.write(`? ${event.title} → no one to answer in a headless run\n`)
          void options.client.send({
            type: "request.resolve",
            sessionId,
            requestId: event.requestId,
            decision: { kind: "deny", reason: "headless run: nobody can answer; decide with your best judgment and state the assumption" },
          })
          break
        }
        if (event.engineFlagged) {
          // The engine's own safety check, raised although the session is in full access: `--approve` never covers it, only `--dangerously-skip-permissions` does.
          const skipped = options.skipPermissions === true
          if (!options.json) options.err.write(`? ${event.title}: ${event.detail} → ${skipped ? "approved" : "denied"} (${skipped ? "--dangerously-skip-permissions" : "the engine flagged this command; --approve does not cover it, pass --dangerously-skip-permissions to allow it"})\n`)
          void options.client.send({
            type: "request.resolve",
            sessionId,
            requestId: event.requestId,
            decision: skipped ? { kind: "approve", scope: "once" } : { kind: "deny", reason: ENGINE_FLAGGED_DENIAL },
          })
          break
        }
        if (!options.approve) {
          blocked = true
          if (event.itemId) deniedItems.add(event.itemId)
        }
        if (!options.json) options.err.write(`? ${event.title}: ${event.detail} → ${options.approve ? "approved" : "denied"} (${options.approve ? "--approve" : "pass --approve to allow"})\n`)
        void options.client.send({
          type: "request.resolve",
          sessionId,
          requestId: event.requestId,
          decision: options.approve ? { kind: "approve", scope: "once" } : { kind: "deny", reason: "headless run without --approve" },
        })
        break
      case "turn.completed":
        if (event.turnId === turnId) {
          const message = [...answerText.values()].filter((text) => text.trim()).at(-1) ?? ""
          void (options.finish ? options.finish(message) : Promise.resolve({ ok: true as const, text: message })).then((outcome) => {
            if (!outcome.ok) {
              for (const line of outcome.errors) options.err.write(`error: ${line}\n`)
              if (!outcome.io) options.err.write("error: the final answer does not match --output-schema\n")
              return settle(outcome.io ? EXIT.failed : EXIT.schema)
            }
            if (options.hold && !options.json) options.out.write(`${outcome.text}\n`)
            else if (!options.json) options.out.write("\n")
            if (blocked && !options.json) options.err.write("error: an approval was denied and nothing ran after it; pass --approve to allow it\n")
            settle(blocked ? EXIT.denied : EXIT.completed)
          })
        }
        break
      case "turn.failed":
        if (event.turnId === turnId) {
          options.err.write(`error: ${event.error.code}: ${event.error.message}\n`)
          settle(event.error.code === "max_steps" ? EXIT.limit : EXIT.failed)
        }
        break
      case "turn.cancelled":
      case "turn.interrupted":
        if (event.turnId === turnId) settle(EXIT.stopped)
        break
    }
  }

  return {
    get sessionId() { return sessionId },
    onEvent(event: SessionEvent) {
      if (queueId) handle(event)
      else buffered.push(event)
    },
    async start() {
      const reply = await (options.submit?.() ?? options.client.send({ type: "user.submit", sessionId: options.sessionId, text: options.prompt, attachments: [] }))
      if (!reply.ok) {
        if (options.compat) options.out.write(`${JSON.stringify(compatEnvelope({ kind: "error", command: "run", error: reply.error }))}\n`)
        else options.err.write(`error: ${reply.error.message}\n`)
        settle(EXIT.failed)
        return done
      }
      if (reply.result?.handled === true) {
        if (!options.json && reply.result.notice) options.out.write(`${reply.result.notice}\n`)
        settle(EXIT.completed)
        return done
      }
      if (typeof reply.result?.queueId !== "string") {
        options.err.write("error: submission did not return a queue id\n")
        settle(EXIT.failed)
        return done
      }
      queueId = String(reply.result?.queueId)
      const task = reply.result?.task as import("@mendcode/protocol").TaskRecord | undefined
      if (task) {
        sessionId = task.taskId
        const subscribed = await options.client.subscribe(sessionId, 0)
        if (!subscribed.ok) { options.err.write(`error: ${subscribed.error.message}\n`); settle(EXIT.failed); return done }
      }
      for (const event of buffered.splice(0)) handle(event)
      return done
    },
    done,
  }
}

import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useProject } from "./project"
import { useSDK } from "./sdk"
import * as Log from "@mendcode/core/util/log"

const OUTBOX_KEY = "question-control-outbox-v1"
const OUTBOX_LIMIT = 64
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000
const trace = Log.create({ service: "tui.question-control" })

export type QuestionControlEntry = {
  id: string
  requestID: string
  sessionID: string
  action: "reply" | "reject"
  answers?: string[][]
  directory?: string
  workspace?: string
  requestedAt: number
  attempts: number
  lastAttemptAt?: number
  lastError?: string
}

function isEntry(value: unknown): value is QuestionControlEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<QuestionControlEntry>
  return (
    typeof entry.id === "string" &&
    typeof entry.requestID === "string" &&
    typeof entry.sessionID === "string" &&
    (entry.action === "reply" || entry.action === "reject") &&
    (entry.answers === undefined || Array.isArray(entry.answers)) &&
    typeof entry.requestedAt === "number" &&
    typeof entry.attempts === "number"
  )
}

export function normalizeQuestionControlOutbox(input: unknown, now = Date.now()) {
  if (!Array.isArray(input)) return [] as QuestionControlEntry[]
  const unique = new Map<string, QuestionControlEntry>()
  for (const value of input) {
    if (!isEntry(value) || now - value.requestedAt > OUTBOX_TTL_MS) continue
    const current = unique.get(value.id)
    if (!current || current.requestedAt <= value.requestedAt) unique.set(value.id, value)
  }
  return [...unique.values()].sort((a, b) => a.requestedAt - b.requestedAt).slice(-OUTBOX_LIMIT)
}

export const { use: useQuestionControl, provider: QuestionControlProvider } = createSimpleContext({
  name: "QuestionControl",
  init: () => {
    const kv = useKV()
    const project = useProject()
    const sdk = useSDK()
    const [stored, setStored] = kv.signal<QuestionControlEntry[]>(OUTBOX_KEY, [])
    let inFlight: Promise<boolean> | undefined
    const ready = kv.ready ? Promise.resolve() : new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!kv.ready) return
        clearInterval(timer)
        resolve()
      }, 10)
    })

    const entries = () => normalizeQuestionControlOutbox(stored())
    const persist = (next: QuestionControlEntry[]) => setStored(() => normalizeQuestionControlOutbox(next))
    const context = () => {
      const workspace = project.workspace.current()
      return {
        workspace,
        directory: workspace === undefined ? sdk.directory : undefined,
      }
    }

    function enqueue(input: {
      requestID: string
      sessionID: string
      action: "reply" | "reject"
      answers?: string[][]
    }) {
      const current = entries()
      const contextValue = context()
      const id = `${contextValue.workspace ?? contextValue.directory ?? ""}\u0000${input.requestID}\u0000${input.action}`
      if (current.some((entry) => entry.id === id)) return
      persist([
        ...current,
        {
          id,
          requestID: input.requestID,
          sessionID: input.sessionID,
          action: input.action,
          answers: input.answers,
          ...contextValue,
          requestedAt: Date.now(),
          attempts: 0,
        },
      ])
      trace.trace("control-requested", {
        sessionID: input.sessionID,
        requestID: input.requestID,
        action: input.action,
      })
      void drain()
    }

    async function runDrain() {
      await ready
      let delivered = true
      const attempted = new Set<string>()
      for (let i = 0; i < OUTBOX_LIMIT; i++) {
        const entry = entries().find((item) => !attempted.has(item.id))
        if (!entry) break
        attempted.add(entry.id)
        try {
          if (entry.action === "reply") {
            await sdk.client.question.reply(
              {
                requestID: entry.requestID,
                answers: entry.answers ?? [],
                directory: entry.directory,
                workspace: entry.workspace,
              },
              { throwOnError: true },
            )
          } else {
            await sdk.client.question.reject(
              { requestID: entry.requestID, directory: entry.directory, workspace: entry.workspace },
              { throwOnError: true },
            )
          }
          persist(entries().filter((item) => item.id !== entry.id))
          trace.trace("control-delivered", {
            sessionID: entry.sessionID,
            requestID: entry.requestID,
            action: entry.action,
            attempt: entry.attempts + 1,
          })
        } catch (error) {
          delivered = false
          trace.trace("control-failed", {
            sessionID: entry.sessionID,
            requestID: entry.requestID,
            action: entry.action,
            attempt: entry.attempts + 1,
            error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
          })
          persist(
            entries().map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    attempts: item.attempts + 1,
                    lastAttemptAt: Date.now(),
                    lastError: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
                  }
                : item,
            ),
          )
        }
      }
      return delivered && entries().length === 0
    }

    function drain() {
      if (inFlight) return inFlight
      inFlight = runDrain().finally(() => {
        inFlight = undefined
      })
      return inFlight
    }

    const unsubscribe = sdk.event.on("event", (event) => {
      if (event.payload.type === "server.connected" || event.payload.type === "server.heartbeat") void drain()
    })
    void drain()
    onCleanup(unsubscribe)
    return {
      entries,
      reply: (input: { requestID: string; sessionID: string; answers: string[][] }) =>
        enqueue({ ...input, action: "reply" }),
      reject: (input: { requestID: string; sessionID: string }) => enqueue({ ...input, action: "reject" }),
      drain,
    }
  },
})

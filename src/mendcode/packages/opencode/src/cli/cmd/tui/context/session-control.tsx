import { createEffect, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useProject } from "./project"
import { useSDK } from "./sdk"

const OUTBOX_KEY = "session-control-outbox-v1"
const OUTBOX_LIMIT = 64
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CONFIRMATION_TTL_MS = 2_000
export const SESSION_CANCEL_AUTO_RETRY_MAX_ATTEMPTS = 8
export const SESSION_CANCEL_AUTO_RETRY_WINDOW_MS = 30_000
export const SESSION_CANCEL_AUTO_RETRY_BASE_DELAY_MS = 250
export const SESSION_CANCEL_AUTO_RETRY_MAX_DELAY_MS = 2_000

export type SessionCancelResult = "cancelled" | "already_terminal" | "target_mismatch" | "not_running"

export type SessionCancelOutboxEntry = {
  id: string
  directory?: string
  workspace?: string
  sessionID: string
  targetMessageID: string
  requestedAt: number
  attempts: number
  lastAttemptAt?: number
  lastError?: string
}

export type SessionControlStatus =
  | { state: "idle" }
  | { state: "stop_requested"; targetMessageID: string; requestedAt: number }
  | { state: "stop_unknown"; targetMessageID: string; requestedAt: number; attempts: number; error: string }
  | { state: "stop_failed"; targetMessageID: string; requestedAt: number; attempts: number; error?: string }
  | { state: "stop_confirmed"; targetMessageID: string; confirmedAt: number; result: SessionCancelResult }

export function sessionControlAllowsPrompt(status: SessionControlStatus) {
  if (status.state === "idle") return true
  if (status.state !== "stop_confirmed") return false
  return status.result === "cancelled" || status.result === "already_terminal" || status.result === "not_running"
}

export function sessionCancelRetryAllowed(input: { attempts: number; requestedAt: number; now?: number }) {
  const now = input.now ?? Date.now()
  return (
    input.attempts < SESSION_CANCEL_AUTO_RETRY_MAX_ATTEMPTS &&
    now - input.requestedAt <= SESSION_CANCEL_AUTO_RETRY_WINDOW_MS
  )
}

export function sessionCancelRetryDelay(attempts: number) {
  return Math.min(
    SESSION_CANCEL_AUTO_RETRY_MAX_DELAY_MS,
    SESSION_CANCEL_AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  )
}

export function sessionCancelRequestIsDuplicate(input: {
  entries: readonly Pick<SessionCancelOutboxEntry, "sessionID" | "targetMessageID">[]
  confirmedTargetMessageID?: string
  sessionID: string
  targetMessageID: string
}) {
  return (
    input.confirmedTargetMessageID === input.targetMessageID ||
    input.entries.some(
      (entry) => entry.sessionID === input.sessionID && entry.targetMessageID === input.targetMessageID,
    )
  )
}

function isEntry(value: unknown): value is SessionCancelOutboxEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<SessionCancelOutboxEntry>
  return (
    typeof entry.id === "string" &&
    typeof entry.sessionID === "string" &&
    typeof entry.targetMessageID === "string" &&
    typeof entry.requestedAt === "number" &&
    typeof entry.attempts === "number" &&
    (entry.directory === undefined || typeof entry.directory === "string") &&
    (entry.workspace === undefined || typeof entry.workspace === "string") &&
    (entry.lastAttemptAt === undefined || typeof entry.lastAttemptAt === "number") &&
    (entry.lastError === undefined || typeof entry.lastError === "string")
  )
}

export function normalizeSessionCancelOutbox(input: unknown, now = Date.now()) {
  if (!Array.isArray(input)) return []
  const unique = new Map<string, SessionCancelOutboxEntry>()
  for (const entry of input) {
    if (!isEntry(entry) || now - entry.requestedAt > OUTBOX_TTL_MS) continue
    const current = unique.get(entry.id)
    if (!current || current.requestedAt <= entry.requestedAt) unique.set(entry.id, entry)
  }
  return [...unique.values()].sort((a, b) => a.requestedAt - b.requestedAt).slice(-OUTBOX_LIMIT)
}

function errorMessage(error: unknown) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string" && error
        ? error
        : "Control request failed"
  return message.slice(0, 240)
}

function isResult(value: unknown): value is SessionCancelResult {
  return value === "cancelled" || value === "already_terminal" || value === "target_mismatch" || value === "not_running"
}

export const { use: useSessionControl, provider: SessionControlProvider } = createSimpleContext({
  name: "SessionControl",
  init: () => {
    const kv = useKV()
    const project = useProject()
    const sdk = useSDK()
    const [stored, setStored] = kv.signal<SessionCancelOutboxEntry[]>(OUTBOX_KEY, [])
    const [confirmed, setConfirmed] = createSignal<
      Record<string, Extract<SessionControlStatus, { state: "stop_confirmed" }>>
    >({})
    const confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let inFlight: Promise<boolean> | undefined
    let resolveReady: (() => void) | undefined
    const ready = kv.ready ? Promise.resolve() : new Promise<void>((resolve) => (resolveReady = resolve))

    createEffect(() => {
      if (!kv.ready || !resolveReady) return
      resolveReady()
      resolveReady = undefined
    })

    function entries() {
      return normalizeSessionCancelOutbox(stored())
    }

    function persist(next: SessionCancelOutboxEntry[]) {
      setStored(() => normalizeSessionCancelOutbox(next))
    }

    function request(input: { sessionID: string; targetMessageID: string }) {
      const workspace = project.workspace.current()
      const directory = workspace === undefined ? sdk.directory : undefined
      const id = `${workspace ?? directory ?? ""}\u0000${input.sessionID}\u0000${input.targetMessageID}`
      const current = entries()
      if (
        sessionCancelRequestIsDuplicate({
          entries: current,
          confirmedTargetMessageID: confirmed()[input.sessionID]?.targetMessageID,
          sessionID: input.sessionID,
          targetMessageID: input.targetMessageID,
        })
      )
        return
      persist([
        ...current,
        {
          id,
          ...(directory === undefined ? {} : { directory }),
          ...(workspace === undefined ? {} : { workspace }),
          sessionID: input.sessionID,
          targetMessageID: input.targetMessageID,
          requestedAt: Date.now(),
          attempts: 0,
        },
      ])
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      const timer = confirmationTimers.get(input.sessionID)
      if (timer) clearTimeout(timer)
      confirmationTimers.delete(input.sessionID)
      setConfirmed((value) => {
        if (!(input.sessionID in value)) return value
        const next = { ...value }
        delete next[input.sessionID]
        return next
      })
    }

    async function runDrain() {
      await ready
      let delivered = true
      const attemptedIDs = new Set<string>()
      for (let index = 0; index < OUTBOX_LIMIT; index++) {
        const entry = entries().find((item) => !attemptedIDs.has(item.id))
        if (!entry) break
        attemptedIDs.add(entry.id)
        const attemptedEntry = {
          ...entry,
          attempts: entry.attempts + 1,
          lastAttemptAt: Date.now(),
          lastError: undefined,
        }
        try {
          const response = await sdk.client.session.cancelTurn(
            {
              sessionID: entry.sessionID,
              targetMessageID: entry.targetMessageID,
              directory: entry.directory,
              workspace: entry.workspace,
            },
            { throwOnError: true },
          )
          if (!isResult(response.data)) throw new Error("Invalid cancel-turn response")
          persist(entries().filter((item) => item.id !== entry.id))
          setConfirmed((value) => ({
            ...value,
            [entry.sessionID]: {
              state: "stop_confirmed",
              targetMessageID: entry.targetMessageID,
              confirmedAt: Date.now(),
              result: response.data,
            },
          }))
          const timer = confirmationTimers.get(entry.sessionID)
          if (timer) clearTimeout(timer)
          confirmationTimers.set(
            entry.sessionID,
            setTimeout(() => {
              confirmationTimers.delete(entry.sessionID)
              setConfirmed((value) => {
                const next = { ...value }
                delete next[entry.sessionID]
                return next
              })
            }, CONFIRMATION_TTL_MS),
          )
        } catch (error) {
          delivered = false
          persist(
            entries().map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    attempts: attemptedEntry.attempts,
                    lastAttemptAt: attemptedEntry.lastAttemptAt,
                    lastError: errorMessage(error),
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
        const pending = entries()
        if (pending.length === 0) {
          return
        }
        const retryable = pending
          .filter((entry) => sessionCancelRetryAllowed(entry))
          .toSorted((a, b) => a.attempts - b.attempts)[0]
        if (!retryable || retryTimer) return
        const delay = sessionCancelRetryDelay(retryable.attempts)
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          void drain()
        }, delay)
      })
      return inFlight
    }

    function status(sessionID: string): SessionControlStatus {
      const pending = entries().find((entry) => entry.sessionID === sessionID)
      if (pending) {
        if (!sessionCancelRetryAllowed(pending)) {
          return {
            state: "stop_failed",
            targetMessageID: pending.targetMessageID,
            requestedAt: pending.requestedAt,
            attempts: pending.attempts,
            ...(pending.lastError ? { error: pending.lastError } : {}),
          }
        }
        if (pending.lastError) {
          return {
            state: "stop_unknown",
            targetMessageID: pending.targetMessageID,
            requestedAt: pending.requestedAt,
            attempts: pending.attempts,
            error: pending.lastError,
          }
        }
        return {
          state: "stop_requested",
          targetMessageID: pending.targetMessageID,
          requestedAt: pending.requestedAt,
        }
      }
      return confirmed()[sessionID] ?? { state: "idle" }
    }

    onCleanup(() => {
      if (retryTimer) clearTimeout(retryTimer)
      for (const timer of confirmationTimers.values()) clearTimeout(timer)
      confirmationTimers.clear()
    })

    return {
      entries,
      request,
      drain,
      status,
    }
  },
})

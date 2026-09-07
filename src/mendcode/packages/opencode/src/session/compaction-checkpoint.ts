import { Hash } from "@mendcode/core/util/hash"

import { Database } from "@/storage/db"
import { SessionID } from "./schema"
import * as Mailbox from "./runtime-mailbox"
import type { NativeBinding } from "@/provider/native-compaction"

export const NATIVE_COMPACTION_NAMESPACE = "native_compaction_v1"
const ACTIVE_PREFIX = "native_compaction_active_"
const PREVIOUS_PREFIX = "native_compaction_previous_"
const MAX_RETAINED_BYTES = 8 * 1024 * 1024

export type CheckpointTiming = {
  prepareMs: number | null
  providerMs: number | null
  installMs: number | null
  resumeMs: number | null
  totalMs: number | null
  method?: "native" | "portable"
  fallbackReason?: string
  inputTokens?: number | null
  outputTokens?: number | null
}

export type NativeCheckpoint = {
  namespace: typeof NATIVE_COMPACTION_NAMESPACE
  version: 1
  sessionID: SessionID
  generation: number
  boundaryMessageID: string
  boundaryPartIDs: string[]
  binding: NativeBinding
  instructionsFingerprint: string
  toolsFingerprint: string
  canonicalOutput: string
  outputBytes: number
  inputBytes: number
  requestID: string | null
  timing: CheckpointTiming
  createdAt: number
}

function activeID(sessionID: SessionID) {
  return `${ACTIVE_PREFIX}${sessionID}`
}

function previousID(sessionID: SessionID) {
  return `${PREVIOUS_PREFIX}${sessionID}`
}

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function bindingKey(binding: NativeBinding) {
  return JSON.stringify(binding)
}

function isBinding(value: unknown): value is NativeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const binding = value as Partial<NativeBinding>
  return (
    typeof binding.providerID === "string" &&
    typeof binding.apiOrigin === "string" &&
    typeof binding.credentialFingerprint === "string" &&
    typeof binding.modelID === "string" &&
    (binding.protocol === "openai-responses-api-v1" || binding.protocol === "codex-oauth-responses-v1")
  )
}

function isTiming(value: unknown): value is CheckpointTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const timing = value as Record<string, unknown>
  return (
    (timing.method === undefined || timing.method === "native" || timing.method === "portable") &&
    (timing.fallbackReason === undefined || typeof timing.fallbackReason === "string") &&
    Object.entries(timing)
      .filter(([key]) => !["method", "fallbackReason"].includes(key))
      .every(
        ([, item]) =>
          item === null ||
          (typeof item === "number" && Number.isFinite(item) && item >= 0),
      )
  )
}

function parse(value: unknown): NativeCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Partial<NativeCheckpoint>
  if (
    item.namespace !== NATIVE_COMPACTION_NAMESPACE ||
    item.version !== 1 ||
    typeof item.sessionID !== "string" ||
    typeof item.generation !== "number" ||
    !Number.isInteger(item.generation) ||
    item.generation < 0 ||
    typeof item.boundaryMessageID !== "string" ||
    !Array.isArray(item.boundaryPartIDs) ||
    item.boundaryPartIDs.some((partID) => typeof partID !== "string") ||
    !isBinding(item.binding) ||
    typeof item.instructionsFingerprint !== "string" ||
    typeof item.toolsFingerprint !== "string" ||
    typeof item.canonicalOutput !== "string" ||
    typeof item.outputBytes !== "number" ||
    !Number.isInteger(item.outputBytes) ||
    typeof item.inputBytes !== "number" ||
    !Number.isInteger(item.inputBytes) ||
    item.inputBytes < 0 ||
    typeof item.requestID !== "string" && item.requestID !== null && item.requestID !== undefined ||
    !isTiming(item.timing) ||
    typeof item.createdAt !== "number" ||
    !Number.isFinite(item.createdAt)
  )
    return undefined
  if (
    bytes(item.canonicalOutput) > 4 * 1024 * 1024 ||
    item.outputBytes < 0 ||
    item.outputBytes > 4 * 1024 * 1024 ||
    item.outputBytes !== bytes(item.canonicalOutput)
  )
    return undefined
  try {
    const output = JSON.parse(item.canonicalOutput)
    if (!Array.isArray(output) || output.some((part) => !part || typeof part !== "object" || Array.isArray(part))) return undefined
  } catch {
    return undefined
  }
  return item as NativeCheckpoint
}

function recordFor(checkpoint: NativeCheckpoint, id: string, status: "active" | "previous" | "invalid" = "active") {
  return {
    id,
    sessionID: checkpoint.sessionID,
    directory: "",
    kind: "note" as const,
    generation: checkpoint.generation,
    status,
    data: checkpoint as unknown as Record<string, unknown>,
    timeCreated: checkpoint.createdAt,
    timeUpdated: Date.now(),
  }
}

function fromRecord(record: Mailbox.Record | undefined, statuses: readonly string[] = ["active"]) {
  return record?.kind === "note" && statuses.includes(record.status) ? parse(record.data) : undefined
}

export function fingerprint(value: unknown) {
  return Hash.fast(JSON.stringify(value ?? null))
}

export function contextFingerprints(input: { agent: string; system?: string; tools?: unknown }) {
  return {
    instructions: fingerprint({ agent: input.agent, system: input.system ?? null }),
    tools: fingerprint(input.tools ?? null),
  }
}

export function load(sessionID: SessionID, binding: NativeBinding, generation: number) {
  const checkpoint = fromRecord(Mailbox.getRecord(sessionID, activeID(sessionID)))
  if (
    !checkpoint ||
    Mailbox.generation(sessionID) !== generation ||
    checkpoint.generation !== generation ||
    bindingKey(checkpoint.binding) !== bindingKey(binding)
  )
    return undefined
  return checkpoint
}

export function loadActive(sessionID: SessionID) {
  return fromRecord(Mailbox.getRecord(sessionID, activeID(sessionID)))
}

export function sameBinding(left: NativeBinding, right: NativeBinding) {
  return bindingKey(left) === bindingKey(right)
}

export function loadPrevious(sessionID: SessionID) {
  return fromRecord(Mailbox.getRecord(sessionID, previousID(sessionID)), ["previous"])
}

export function outputItems(checkpoint: NativeCheckpoint) {
  const value = JSON.parse(checkpoint.canonicalOutput) as unknown
  if (!Array.isArray(value)) throw new Error("Invalid native checkpoint output")
  return value
}

export function commitIfCurrent(input: {
  checkpoint: NativeCheckpoint
  directory: string
  expectedGeneration: number
  expectedBinding: NativeBinding
  timingStartedAt?: number
}) {
  const checkpoint = parse(input.checkpoint)
  if (!checkpoint) return false
  if (
    checkpoint.generation !== input.expectedGeneration ||
    bindingKey(checkpoint.binding) !== bindingKey(input.expectedBinding)
  )
    return false

  const currentGeneration = Mailbox.generation(checkpoint.sessionID)
  if (currentGeneration !== input.expectedGeneration) return false
  const existing = fromRecord(Mailbox.getRecord(checkpoint.sessionID, activeID(checkpoint.sessionID)))
  const previous = fromRecord(Mailbox.getRecord(checkpoint.sessionID, previousID(checkpoint.sessionID)), ["previous"])
  const retainedBytes = checkpoint.outputBytes + (existing?.outputBytes ?? previous?.outputBytes ?? 0)
  if (retainedBytes > MAX_RETAINED_BYTES) return false

  return Database.transaction(() => {
    if (Mailbox.generation(checkpoint.sessionID) !== input.expectedGeneration) return false
    if (existing) {
      Mailbox.putRecord({
        ...recordFor(existing, previousID(existing.sessionID), "previous"),
        directory: input.directory,
      })
    } else if (previous) {
      // Preserve the previous checkpoint when the active slot was already
      // absent; it is replaced only after the new active record is ready.
      Mailbox.putRecord({ ...recordFor(previous, previousID(previous.sessionID), "previous"), directory: input.directory })
    }
    Mailbox.putRecord({ ...recordFor(checkpoint, activeID(checkpoint.sessionID), "active"), directory: input.directory })
    if (input.timingStartedAt !== undefined) {
      const now = performance.now()
      checkpoint.timing.installMs = Math.max(0, Math.round(now - input.timingStartedAt))
      checkpoint.timing.totalMs = Math.max(0, Math.round(now - input.timingStartedAt))
      Mailbox.putRecord({ ...recordFor(checkpoint, activeID(checkpoint.sessionID), "active"), directory: input.directory })
    }
    return true
  })
}

export function invalidate(sessionID: SessionID, directory: string, reason: string) {
  const existing = Mailbox.getRecord(sessionID, activeID(sessionID))
  const checkpoint = fromRecord(existing)
  if (!checkpoint) return false
  Mailbox.putRecord({
    ...recordFor(
      {
        ...checkpoint,
        canonicalOutput: "[]",
        outputBytes: 0,
        timing: checkpoint.timing,
      },
      activeID(sessionID),
      "invalid",
    ),
    directory,
    data: { ...checkpoint, namespace: NATIVE_COMPACTION_NAMESPACE, invalidReason: reason, canonicalOutput: "[]", outputBytes: 0 },
  })
  return true
}

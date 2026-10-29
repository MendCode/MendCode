import { createHash } from "node:crypto"
import { redactSecrets } from "@mendcode/protocol"
import type { ThreadResult } from "@mendcode/tools"

type Metadata = { get(key: string): string | undefined; set(key: string, value: string): void }
type Receipt = { digest: string; state: "pending" | "complete"; result?: ThreadResult }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

/** Single daemon writer. Pending survives a crash: never repeat an uncertain external effect. */
export function createOrchestrationReceipts(meta: Metadata) {
  return {
    async run(input: { project: string; owner: string; operation: string; requestId: string; args: unknown; execute(): Promise<ThreadResult> }): Promise<ThreadResult> {
      const scope = hash(canonical([input.project, input.owner]))
      const key = `orchestration.receipt:${scope}:${hash(canonical([input.operation, input.requestId]))}`
      const digest = hash(canonical(input.args))
      const raw = meta.get(key)
      if (raw) {
        const receipt = JSON.parse(raw) as Receipt
        if (receipt.digest !== digest) return { ok: false, message: "Conflicting clientRequestId" }
        return receipt.state === "complete" && receipt.result ? receipt.result : { ok: false, message: "Dispatch outcome unknown; inspect the target before using a new request ID" }
      }
      const countKey = `orchestration.receipt-count:${scope}`
      const count = Number(meta.get(countKey) ?? 0)
      if (count >= 256) return { ok: false, message: "Durable receipt limit reached for this owner" }
      meta.set(countKey, String(count + 1))
      meta.set(key, JSON.stringify({ digest, state: "pending" } satisfies Receipt))
      const result = await input.execute()
      const safe: ThreadResult = result.ok ? { ok: true, output: redactSecrets(result.output).text.slice(0, 20_000) } : { ok: false, message: redactSecrets(result.message).text.slice(0, 2_000) }
      meta.set(key, JSON.stringify({ digest, state: "complete", result: safe } satisfies Receipt))
      return safe
    },
  }
}

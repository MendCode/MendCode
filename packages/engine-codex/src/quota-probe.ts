import { realClock, type Clock } from "@mendcode/kernel"
import { codexQuota } from "./engine"
import { createRpc, spawnCodex, type Transport } from "./rpc"

type Snapshot = NonNullable<ReturnType<typeof codexQuota>>

export type CodexQuotaProbe = {
  bin?: string
  cwd?: string
  clock?: Clock
  timeoutMs?: number
  onQuota(snapshot: Snapshot): void
  transportFactory?(input: { args: string[]; cwd: string | undefined }): Transport
}

/**
 * The subscription's windows without a model turn: `codex app-server` answers `account/rateLimits/read` once it is initialized, which is
 * all the Codex engine does at start. Nothing is sent to a model, so it costs no quota; the process is started with the user's own
 * `codex` login and stopped right after the answer. Rejects when `codex` is missing, fails or reports no window.
 */
export async function probeCodexQuota(options: CodexQuotaProbe): Promise<void> {
  const clock = options.clock ?? realClock
  const args = ["app-server"]
  const transport = options.transportFactory?.({ args, cwd: options.cwd }) ?? spawnCodex({ bin: options.bin ?? "codex", args, ...(options.cwd ? { cwd: options.cwd } : {}) })
  const rpc = createRpc(transport, { notification() {}, request: async () => ({ decision: "decline" }) })
  const timer = clock.setTimer(options.timeoutMs ?? 30_000, () => transport.close())
  try {
    await rpc.request("initialize", { clientInfo: { name: "mendcode", title: "MendCode", version: "0.0.0" }, capabilities: null })
    rpc.notify("initialized")
    const limits = await rpc.request("account/rateLimits/read")
    const quota = codexQuota(limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits, clock.now())
    if (!quota) throw new Error("[CODEX]: codex reported no rate limits")
    options.onQuota(quota)
  } finally {
    timer.cancel()
    transport.close()
  }
}

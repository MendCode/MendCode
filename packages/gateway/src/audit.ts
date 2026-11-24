import { appendFileSync, chownSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import { ACCOUNT_ID, type FileOwner } from "./state"

/**
 * Append-only JSON Lines: `<state>/audit/gateway.jsonl` for everything, plus `<state>/audit/<account>.jsonl` for what
 * concerns one account. Entries name events, ids, the client address and a reason, never a code, token, challenge,
 * cookie, signature or key: `detail` keeps only short plain words.
 */
export type AuditEntry = { event: string; ok: boolean; account?: string; device?: string; ip?: string; reason?: string; detail?: Record<string, string | number | boolean> }

const MAX_FILE_BYTES = 16 * 1024 * 1024
const SAFE_DETAIL = /^[\w .:@+/-]{0,80}$/

export function auditLog(stateDir: string, now = Date.now, owner?: FileOwner) {
  const dir = path.join(stateDir, "audit")
  function append(name: string, line: string) {
    const file = path.join(dir, `${name}.jsonl`)
    try {
      // One older generation is kept; the log never grows past twice the cap.
      if (statSync(file).size > MAX_FILE_BYTES) renameSync(file, `${file}.1`)
    } catch {}
    appendFileSync(file, line, { mode: 0o600 })
    if (owner) chownSync(file, owner.uid, owner.gid)
  }
  return {
    write(entry: AuditEntry) {
      const detail = entry.detail ? Object.fromEntries(Object.entries(entry.detail).filter(([key, value]) => /^\w{1,32}$/.test(key) && (typeof value !== "string" || SAFE_DETAIL.test(value)))) : undefined
      const record = { t: new Date(now()).toISOString(), event: entry.event, ok: entry.ok, ...(entry.account ? { account: entry.account } : {}), ...(entry.device ? { device: entry.device } : {}), ...(entry.ip ? { ip: entry.ip.slice(0, 64) } : {}), ...(entry.reason ? { reason: entry.reason.slice(0, 40) } : {}), ...(detail && Object.keys(detail).length ? { detail } : {}) }
      const line = `${JSON.stringify(record)}\n`
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        if (owner) chownSync(dir, owner.uid, owner.gid)
        append("gateway", line)
        if (entry.account && ACCOUNT_ID.test(entry.account)) append(entry.account, line)
      } catch {
        process.stderr.write("[GATEWAY]: audit log write failed\n")
      }
    },
  }
}
export type AuditLog = ReturnType<typeof auditLog>

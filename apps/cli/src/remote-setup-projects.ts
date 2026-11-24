import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Project identity and mapping are shared with session sync (the daemon), so both move sessions to the same folders. */
export { applyPathRule, mapProject, normalizeGitRemote, parsePathRule, type PathRule, type ProjectIdentity, type ProjectMapping, type RemoteRepo } from "@mendcode/daemon/project-identity"

/** What a setup run has already done for one saved remote; never a secret. Lets an interrupted run continue and a repeated one skip finished work. */
export type SetupLedger = { version: 1; host: string; settings?: { at: number; importId?: string }; acpAgents?: { at: number; names: string[] }; sessions: Record<string, { at: number; remoteId?: string; directory: string; truncated?: boolean }> }

export const ledgerFile = (dir: string, name: string) => path.join(dir, "remote-setup", `${name}.json`)

export function readLedger(dir: string, name: string, host: string): SetupLedger {
  try {
    const value = JSON.parse(readFileSync(ledgerFile(dir, name), "utf8")) as SetupLedger
    if (value?.version === 1 && value.host === host && value.sessions && typeof value.sessions === "object") return value
  } catch {}
  return { version: 1, host, sessions: {} }
}

export function writeLedger(dir: string, name: string, ledger: SetupLedger) {
  const file = ledgerFile(dir, name)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

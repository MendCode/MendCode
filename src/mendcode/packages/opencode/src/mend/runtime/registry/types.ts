import type { RuntimePackSource } from "../pack"

export type RuntimeRegistryEntry = {
  id: string
  type: RuntimePackSource["type"]
  url: string | null
  enabled: boolean
  trust: "local" | "private" | "public" | "team"
  note: string
  version?: string
  channel?: string
  compatibility?: {
    mendcode?: string
    runtimePack?: string
  }
  signature?: { algorithm: "sha256"; value: string }
  trustPolicy?: {
    requireSignature?: boolean
    allowUnsigned?: boolean
  }
  privateGit?: {
    credentialMode: "ssh-or-git-credential-helper" | "env-token"
    tokenEnv?: string
  }
  team?: {
    id: string
    channel: string
    subsystemScope: string[]
    requireApproval: boolean
  }
  import?: {
    mode: "mendcode" | "opencode-settings"
  }
}

export type RegistryConflictStatus =
  | "missing"
  | "same"
  | "changed"
  | "blocked"
  | "unsupported"
  | "destructive"

export type RegistryConflict = {
  path: string
  status: RegistryConflictStatus
  source: "incoming" | "local"
  reason: string
}

export type RuntimeRegistryState = {
  version: 0
  defaultSource: string
  entries: RuntimeRegistryEntry[]
  redaction: {
    shared: string[]
    blocked: string[]
  }
}

export type RegistryApplyRecord = {
  id: string
  source: string
  type: RuntimeRegistryEntry["type"]
  trust: RuntimeRegistryEntry["trust"]
  appliedAt: string
  digest: { algorithm: "sha256"; value: string; signed: boolean; verified: boolean }
  reportPath: string
  approval: {
    required: boolean
    via: "policy" | "conflicts" | "none"
    envApproved: boolean
  }
  conflicts: {
    summary: Record<RegistryConflictStatus, number>
    entries: RegistryConflict[]
  }
  copied: string[]
  skipped: string[]
  team?: RuntimeRegistryEntry["team"]
}

export type RuntimeRegistryLocalState = {
  version: 0
  lastApply: RegistryApplyRecord | null
  teamChannels: Record<string, { source: string; channel: string; appliedAt: string; digest: string }>
  history: RegistryApplyRecord[]
}

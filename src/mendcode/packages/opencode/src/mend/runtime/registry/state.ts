import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import semver from "semver"
import { mendPaths } from "../../config/paths"
import type { RuntimeRegistryEntry, RuntimeRegistryLocalState, RuntimeRegistryState } from "./types"

export const defaultRegistryState: RuntimeRegistryState = {
  version: 0,
  defaultSource: "local",
  entries: [
    {
      id: "local",
      type: "local",
      url: ".mendcode/runtime-pack.json",
      enabled: true,
      trust: "local",
      note: "Workspace-local pack generated from shareable .mendcode config.",
    },
  ],
  redaction: {
    shared: [
      ".mendcode/mendcode.json",
      ".mendcode/models.yaml",
      ".mendcode/prompt-mode.json",
      ".mendcode/focus/*.yaml",
      ".mendcode/commands/**/*.md",
      ".mendcode/agents/**/*.md",
      ".mendcode/skills/**/SKILL.md",
      ".mendcode/prompts/**/*.md",
      ".mendcode/mcp/**/*.{json,jsonc}",
      ".mendcode/context/project.md",
      ".mendcode/context/summary.md",
      ".mendcode/tui/profile.json",
      ".mendcode/worktree/policy.yaml",
      ".mendcode/runtime-pack.json",
    ],
    blocked: [
      ".env*",
      ".git",
      ".mendcode/auth",
      ".mendcode/runs",
      ".mendcode/cache",
      ".mendcode/generated",
      ".mendcode/node_modules",
      ".mendcode/tui/backups",
      ".mendcode/tui/proposals",
      ".mendcode/tui/renders",
      "provider tokens",
      "raw prompts",
      "unredacted provider payloads",
    ],
  },
}

function registryPath(root: string) {
  return path.join(root, ".mendcode", "registry.json")
}

export function registryLocalStatePath(root: string) {
  return path.join(root, ".mendcode", "registry-state.json")
}

async function readJsonIfExists<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8")) as T
}

export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function mergeList(current: string[] | undefined, defaults: string[]) {
  return Array.from(new Set([...(current || []), ...defaults]))
}

export async function readRuntimeRegistry(root = mendPaths().root): Promise<RuntimeRegistryState> {
  const state = await readJsonIfExists<RuntimeRegistryState>(registryPath(root), defaultRegistryState)
  return {
    ...defaultRegistryState,
    ...state,
    entries: state.entries?.length ? state.entries : defaultRegistryState.entries,
    redaction: {
      shared: mergeList(state.redaction?.shared, defaultRegistryState.redaction.shared),
      blocked: mergeList(state.redaction?.blocked, defaultRegistryState.redaction.blocked),
    },
  }
}

export async function readRuntimeRegistryLocalState(root: string): Promise<RuntimeRegistryLocalState> {
  return readJsonIfExists<RuntimeRegistryLocalState>(registryLocalStatePath(root), {
    version: 0,
    lastApply: null,
    teamChannels: {},
    history: [],
  })
}

export async function writeRuntimeRegistryLocalState(root: string, state: RuntimeRegistryLocalState) {
  await writeJson(registryLocalStatePath(root), {
    ...state,
    history: state.history.slice(-50),
  })
}

export function trustForType(type: RuntimeRegistryEntry["type"]): RuntimeRegistryEntry["trust"] {
  if (type === "github") return "public"
  if (type === "private-git") return "private"
  if (type === "team") return "team"
  return "local"
}

function parseSemverOrRange(value: string, label: string) {
  if (!semver.valid(value) && !semver.validRange(value)) throw new Error(`${label} must be a valid semver version or range.`)
  return value
}

export function parseRegistryEntryArgs(args: string[]) {
  const id = args[0]
  if (!id || id.startsWith("--")) throw new Error("Usage: mend runtime registry add <id> --type <local|github|private-git|team|opencode-settings> [--url <url>] [--version <semver>] [--channel <name>] [--compat-mendcode <range>] [--compat-runtime-pack <range>] [--signature sha256:<hex>] [--require-signature] [--team <id>] [--scope <a,b>] [--credential-env <ENV>] [--disabled] [--note <text>]")
  let type: RuntimeRegistryEntry["type"] = "local"
  let url: string | null = null
  let note = "User-added runtime pack source."
  let enabled = true
  let version: string | undefined
  let signature: RuntimeRegistryEntry["signature"] | undefined
  let requireSignature = false
  let teamID: string | null = null
  let channel = "stable"
  let subsystemScope: string[] = []
  let requireApproval = false
  let tokenEnv: string | null = null
  let compatMendcode: string | undefined
  let compatRuntimePack: string | undefined
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--type") {
      const value = args[++i] as RuntimeRegistryEntry["type"]
      if (!["local", "github", "private-git", "team", "opencode-settings"].includes(value)) throw new Error("Registry type must be local, github, private-git, team, or opencode-settings.")
      type = value
    } else if (arg === "--url") {
      url = args[++i] || null
    } else if (arg === "--version") {
      version = parseSemverOrRange(args[++i] || "", "Registry version")
    } else if (arg === "--signature") {
      const value = args[++i] || ""
      const match = value.match(/^sha256:([a-fA-F0-9]{64})$/)
      if (!match) throw new Error("Signature must be sha256:<64 hex chars>.")
      signature = { algorithm: "sha256", value: match[1]!.toLowerCase() }
    } else if (arg === "--require-signature") {
      requireSignature = true
    } else if (arg === "--team") {
      teamID = args[++i] || null
    } else if (arg === "--channel") {
      channel = args[++i] || channel
    } else if (arg === "--compat-mendcode") {
      compatMendcode = parseSemverOrRange(args[++i] || "", "MendCode compatibility")
    } else if (arg === "--compat-runtime-pack") {
      compatRuntimePack = parseSemverOrRange(args[++i] || "", "Runtime pack compatibility")
    } else if (arg === "--scope") {
      subsystemScope = (args[++i] || "").split(",").map((item) => item.trim()).filter(Boolean)
    } else if (arg === "--require-approval") {
      requireApproval = true
    } else if (arg === "--credential-env") {
      tokenEnv = args[++i] || null
    } else if (arg === "--note") {
      note = args[++i] || note
    } else if (arg === "--disabled") {
      enabled = false
    } else {
      throw new Error(`Unknown registry option: ${arg}`)
    }
  }
  return {
    id,
    type,
    url,
    note,
    enabled,
    ...(version ? { version } : {}),
    channel,
    ...((compatMendcode || compatRuntimePack) ? { compatibility: { ...(compatMendcode ? { mendcode: compatMendcode } : {}), ...(compatRuntimePack ? { runtimePack: compatRuntimePack } : {}) } } : {}),
    signature,
    trustPolicy: { requireSignature, allowUnsigned: !requireSignature },
    privateGit: type === "private-git"
      ? { credentialMode: tokenEnv ? "env-token" : "ssh-or-git-credential-helper", ...(tokenEnv ? { tokenEnv } : {}) } satisfies NonNullable<RuntimeRegistryEntry["privateGit"]>
      : undefined,
    team: type === "team"
      ? { id: teamID || id, channel, subsystemScope, requireApproval } satisfies NonNullable<RuntimeRegistryEntry["team"]>
      : undefined,
    import: { mode: type === "opencode-settings" ? "opencode-settings" : "mendcode" } satisfies NonNullable<RuntimeRegistryEntry["import"]>,
  }
}

export function safeRegistryID(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_")
}

export function sourceCacheDir(root: string, id: string) {
  return path.join(mendPaths(root).runtimeRegistryCacheDir, safeRegistryID(id), "source")
}

export function normalizedCacheDir(root: string, id: string) {
  return path.join(mendPaths(root).runtimeRegistryCacheDir, safeRegistryID(id), "normalized")
}

export function registryFilePath(root: string) {
  return registryPath(root)
}

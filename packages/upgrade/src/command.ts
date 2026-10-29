import path from "node:path"
import { UpgradeError } from "./errors"
import type { UpgradePorts } from "./ports"
import type { Channel, Platform } from "./releases"
import { CHANNELS, UPGRADE_EXIT, UPGRADE_SCHEMA } from "./settings"
import { resolveRepo, runUpgrade, type UpgradeResult } from "./upgrade"
import { resolveDataDir, binPaths } from "./install"
import { readState, writeState } from "./state"
import { readRecovery, verifyRecovery } from "./recovery"
import { PROGRAM_NAME } from "@mendcode/program"

export type UpgradeCommand = { json: boolean; dir?: string; channel?: Channel; target?: string; method?: string; inspect?: boolean; set?: boolean; check: boolean; force: boolean; rollback: boolean; allowUnsigned?: boolean; requireSignature?: boolean; help: boolean }
export type UpgradeParse = { ok: true; command: UpgradeCommand } | { ok: false; message: string }

const VALUE_FLAGS = new Set(["dir", "channel", "format", "method"])
const BOOLEAN_FLAGS = new Set(["check", "force", "rollback", "json", "help", "inspect", "set", "allow-unsigned", "require-signature"])

export const UPGRADE_USAGE = [
  `usage: ${PROGRAM_NAME} upgrade [target] [--channel stable|beta|dev|nightly] [--method direct|curl] [--check|--inspect|--set|--rollback] [--force] [--require-signature] [--json] [--dir D]`,
  "  (no flags)      install the newest release of the remembered channel (stable until you pick another)",
  "  --channel C     stable: vX.Y.Z · beta: vX.Y.Z-beta.N · dev: dev-<sha> · nightly: vX.Y.Z-nightly.DATE.RUN; remembered in <data dir>/upgrade.json",
  "  --require-signature  refuse to install without a verified cosign signature (without cosign the default is the SHA256 check alone, and the result says so)",
  "  --check         only report whether an update is available; nothing is written",
  "  --inspect       local channel, version and verified recovery identity; no network or writes",
  "  --set --channel C  remember the channel without checking or installing",
  "  channel [set C] local channel inspect/set (same as --inspect or --set --channel C)",
  "  target          exact release version/tag, or latest (default)",
  "  --method, -m    direct/curl use the verified binary installer; package-manager releases are unavailable",
  "  --force         install even when up to date or when the release is older than the running version",
  "  --rollback      go back to the previous binary (run it again to return to the newer one)",
  "  --dir D         data directory (default: MENDCODE_V2_DIR or ~/.mendcode-v2); the binary goes to <D>/bin/mendcode-next",
  "  release source: MendCode/MendCode, or MENDCODE_UPGRADE_REPO=owner/name; a private repository is read with GH_TOKEN, GITHUB_TOKEN or `gh auth login`",
].join("\n")

/** Splits `--flag value` and `--flag=value`; the first positional is the subcommand. */
function tokenize(argv: string[]) {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] === "-m" ? "--method" : argv[i]!
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf("=")
    const name = token.slice(2, equals < 0 ? undefined : equals)
    if (VALUE_FLAGS.has(name)) {
      const value = equals >= 0 ? token.slice(equals + 1) : argv[++i]
      if (value === undefined || value === "" || (equals < 0 && value.startsWith("--"))) return { error: `--${name} needs a value` }
      flags.set(name, value)
    } else if (BOOLEAN_FLAGS.has(name) && equals < 0) flags.set(name, true)
    else return { error: `unknown flag ${token.split("=")[0]}` }
  }
  return { flags, positionals }
}

/** True when the first word of the command line (flag values skipped) is `upgrade`. */
export function isUpgradeCommand(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] === "-m" ? "--method" : argv[i]!
    if (token.startsWith("--")) {
      if (!token.includes("=") && (VALUE_FLAGS.has(token.slice(2)) || token === "--engine" || token === "--session")) i++
      continue
    }
    return token === "upgrade" || token === "update"
  }
  return false
}

export function parseUpgradeArgs(argv: string[]): UpgradeParse {
  const tokens = tokenize(argv)
  if ("error" in tokens) return { ok: false, message: tokens.error }
  const { flags, positionals } = tokens
  if (positionals[0] !== "upgrade" && positionals[0] !== "update") return { ok: false, message: "not an upgrade command" }
  const channelCommand = positionals[1] === "channel"
  const channelInspect = channelCommand && positionals.length === 2
  const channelSet = channelCommand && positionals[2] === "set" && positionals.length === 4
  if (channelCommand && (!channelInspect && !channelSet || [...flags.keys()].some((name) => !["dir", "json", "format", "help"].includes(name)))) return { ok: false, message: "usage: upgrade channel [set stable|beta|nightly|dev]" }
  if (!channelCommand && positionals.length > 2) return { ok: false, message: `unexpected argument ${positionals[2]}` }
  const target = channelCommand ? undefined : positionals[1]
  if (target && target !== "latest" && !/^(?:v?\d+\.\d+\.\d+(?:-(?:beta\.\d+|nightly\.\d{8}\.\d+))?|dev-[a-f0-9]{7,40})$/.test(target)) return { ok: false, message: "target must be a release version/tag or latest" }
  const method = flags.get("method")
  if (method && !["direct", "curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"].includes(String(method))) return { ok: false, message: "unknown installation method" }
  const format = flags.get("format")
  if (format !== undefined && format !== "json") return { ok: false, message: "--format must be json" }
  const channel = channelSet ? positionals[3] : flags.get("channel")
  if (channel !== undefined && !CHANNELS.includes(channel as Channel)) return { ok: false, message: `--channel must be ${CHANNELS.join(", ")}` }
  if (channel && target && target !== "latest") return { ok: false, message: "--channel cannot be combined with an exact target" }
  const check = flags.has("check")
  const force = flags.has("force")
  const rollback = flags.has("rollback")
  const inspect = flags.has("inspect") || channelInspect
  const set = flags.has("set") || channelSet
  if ([check, inspect, set, rollback].filter(Boolean).length > 1) return { ok: false, message: "choose one of --check, --inspect, --set, --rollback" }
  if (set && (channel === undefined || target || method || force)) return { ok: false, message: "--set requires --channel only" }
  if (inspect && (channel || target || method || force)) return { ok: false, message: "--inspect only reads local state" }
  if (rollback && (target || method)) return { ok: false, message: "--rollback cannot use target or method" }
  if (check && force) return { ok: false, message: "--check only reports; it cannot be combined with --force" }
  if (flags.has("allow-unsigned") && (check || inspect || set || rollback)) return { ok: false, message: "--allow-unsigned only applies to an install" }
  if (flags.has("require-signature") && (check || inspect || set || rollback)) return { ok: false, message: "--require-signature only applies to an install" }
  if (flags.has("require-signature") && flags.has("allow-unsigned")) return { ok: false, message: "--require-signature and --allow-unsigned contradict each other" }
  if (rollback && (check || force || channel !== undefined)) return { ok: false, message: "--rollback cannot be combined with --check, --force or --channel" }
  const dir = flags.get("dir")
  return {
    ok: true,
    command: {
      json: flags.has("json") || format === "json",
      ...(typeof dir === "string" ? { dir } : {}),
      ...(channel !== undefined ? { channel: channel as Channel } : {}),
      ...(target ? { target } : {}),
      ...(typeof method === "string" ? { method } : {}),
      ...(inspect ? { inspect: true } : {}),
      ...(set ? { set: true } : {}),
      check,
      force,
      rollback,
      ...(flags.has("allow-unsigned") ? { allowUnsigned: true } : {}),
      ...(flags.has("require-signature") ? { requireSignature: true } : {}),
      help: flags.has("help"),
    },
  }
}

export type UpgradeCommandDeps = {
  ports: UpgradePorts
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  env: Record<string, string | undefined>
  home: string
  /** The CLI's default data directory (`~/.mendcode-v2`). */
  defaultDir: string
  currentVersion: string
  platform: Platform
}

const RESTART_NOTE = `restart ${PROGRAM_NAME} to use it; the background daemon is replaced on the next launch once it is idle (\`${PROGRAM_NAME} --restart-daemon\` does it now)`

const VERIFIED_NOTE = {
  attestation: "verified: SHA256, GitHub provenance and the release index",
  cosign: "verified: SHA256 and the cosign signature of the release workflow",
  "checksum-only": "WARNING: verified by SHA256 only (cosign is not installed); install cosign 2.6.1 or newer to also check the release signature, or pass --require-signature to refuse without it",
} as const

export function upgradeText(result: UpgradeResult, { check }: { check: boolean }) {
  const { status, channel, current, latest } = result
  switch (status) {
    case "update-available":
      return `update available: ${current} -> ${latest} (${channel})${check ? `\nrun \`${PROGRAM_NAME} upgrade\` to install it\n` : "\n"}`
    case "up-to-date":
      return `up to date: ${current} (${channel})\n`
    case "ahead":
      return `running ${current} is newer than the newest ${channel} release ${latest}; nothing installed (--force installs ${latest} anyway)\n`
    case "installed":
      return `installed ${latest} (${channel})${result.downgrade ? " as a downgrade" : ""}: ${result.installedTo}\n${VERIFIED_NOTE[result.verification ?? "attestation"]}\n${RESTART_NOTE}\n${result.rollbackAvailable ? `previous verified version kept: \`${PROGRAM_NAME} upgrade --rollback\` restores it` : "--rollback unavailable: external recovery required"}\n`
    case "rolled-back":
      return `rolled back: ${result.installedTo} is the previous version again\n${RESTART_NOTE}\n`
  }
}

/** Runs a parsed `upgrade` command and returns the process exit code. */
export async function runUpgradeCommand(command: UpgradeCommand, deps: UpgradeCommandDeps): Promise<number> {
  const { out, err } = deps
  if (command.help) {
    out.write(`${UPGRADE_USAGE}\n`)
    return UPGRADE_EXIT.ok
  }
  const line = (value: object) => out.write(`${JSON.stringify({ schema: UPGRADE_SCHEMA, ...value })}\n`)
  try {
    const dataDir = path.resolve(command.dir ?? deps.env.MENDCODE_V2_DIR ?? deps.defaultDir)
    if (command.inspect || command.set) {
      resolveDataDir({ dataDir, home: deps.home })
      const release = command.set ? await deps.ports.fs.lock(dataDir) : undefined
      try {
        let state = await readState({ fs: deps.ports.fs, dataDir })
        if (command.set) {
          state = { ...state, channel: command.channel! }
          await writeState({ fs: deps.ports.fs, dataDir, state })
        }
        const recovery = await readRecovery(deps.ports.fs, dataDir)
        const rollbackAvailable = recovery?.previous ? await verifyRecovery(deps.ports.fs, dataDir).then(() => true, () => false) : false
        const data = { ...state, current: deps.currentVersion, installedTo: binPaths(dataDir).current, recovery: recovery ?? null, rollbackAvailable }
        if (command.json) line({ kind: "result", command: "upgrade", data })
        else out.write(`channel: ${state.channel}\ncurrent: ${deps.currentVersion}\nrecovery: ${rollbackAvailable ? recovery!.previous!.version : "unavailable"}\n`)
        return UPGRADE_EXIT.ok
      } finally { await release?.() }
    }
    const result = await runUpgrade(
      {
        dataDir,
        home: deps.home,
        repo: command.rollback ? "" : resolveRepo(deps.env),
        ...(command.channel ? { channel: command.channel } : {}),
        ...(command.target ? { target: command.target } : {}),
        ...(command.method ? { method: command.method } : {}),
        check: command.check,
        force: command.force,
        rollback: command.rollback,
        ...(command.allowUnsigned ? { allowUnsigned: true } : {}),
        ...(command.requireSignature ? { requireSignature: true } : {}),
        currentVersion: deps.currentVersion,
        platform: deps.platform,
      },
      deps.ports,
    )
    if (command.json) line({ kind: "result", command: "upgrade", data: { ...result, check: command.check } })
    else out.write(upgradeText(result, { check: command.check }))
    return UPGRADE_EXIT.ok
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof UpgradeError ? error.code : "failed"
    if (command.json) line({ kind: "error", command: "upgrade", error: { code, message } })
    else err.write(`error: ${message}\n`)
    return UPGRADE_EXIT.failed
  }
}

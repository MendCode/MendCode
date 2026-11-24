import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseRemoteAddress } from "@mendcode/protocol/wire"

/**
 * Saved remote daemons (`<data dir>/remotes.json`, mode 0600): a name, an address and the paths of a token file and CA. Never a token.
 * Loaded only when the file exists or a command names a remote, so a terminal without one pays one `stat`.
 */
export const REMOTES_FILE = "remotes.json"
export type RemoteProfile = { connect: string; tokenFile?: string; ca?: string; tls?: boolean }
export type RemoteFallback = "remote-first" | "local-first"
export type RemoteProfiles = { defaultRemote?: string; fallback?: RemoteFallback; remotes: Record<string, RemoteProfile> }

const NAME = /^[A-Za-z0-9_-]{1,64}$/
const fail = (): never => { throw new Error("invalid remotes.json") }

export function parseRemoteProfiles(text: string): RemoteProfiles {
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail() }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).some((key) => !["defaultRemote", "fallback", "remotes"].includes(key))) fail()
  const remotes: Record<string, RemoteProfile> = {}
  const all = entry.remotes ?? {}
  if (!all || typeof all !== "object" || Array.isArray(all) || Object.keys(all).length > 64) fail()
  for (const [name, raw] of Object.entries(all as Record<string, unknown>)) {
    const item = raw as Record<string, unknown> | null
    if (!NAME.test(name) || !item || typeof item !== "object" || Object.keys(item).some((key) => !["connect", "tokenFile", "ca", "tls"].includes(key))) fail()
    const profile = item as Record<string, unknown>
    if (typeof profile.connect !== "string" || (profile.tokenFile !== undefined && typeof profile.tokenFile !== "string") || (profile.ca !== undefined && typeof profile.ca !== "string") || (profile.tls !== undefined && typeof profile.tls !== "boolean")) fail()
    try { if (!parseRemoteAddress(profile.connect as string).port) fail() } catch { fail() }
    remotes[name] = { connect: profile.connect as string, ...(profile.tokenFile ? { tokenFile: profile.tokenFile as string } : {}), ...(profile.ca ? { ca: profile.ca as string } : {}), ...(profile.tls ? { tls: true } : {}) }
  }
  if (entry.defaultRemote !== undefined && (typeof entry.defaultRemote !== "string" || !remotes[entry.defaultRemote])) fail()
  if (entry.fallback !== undefined && entry.fallback !== "remote-first" && entry.fallback !== "local-first") fail()
  return { ...(entry.defaultRemote ? { defaultRemote: entry.defaultRemote as string } : {}), ...(entry.fallback ? { fallback: entry.fallback as RemoteFallback } : {}), remotes }
}

export function readRemoteProfiles(dir: string): RemoteProfiles | undefined {
  try { return parseRemoteProfiles(readFileSync(path.join(dir, REMOTES_FILE), "utf8")) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("invalid remotes.json")
  }
}

export function writeRemoteProfiles(dir: string, profiles: RemoteProfiles) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, REMOTES_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

export type ProfileCommand = { dir: string } & (
  | { action: "add"; name: string; connect: string; tokenFile?: string; ca?: string; tls: boolean; makeDefault: boolean; fallback?: RemoteFallback }
  | { action: "list" }
  | { action: "remove"; name: string }
  | { action: "default"; name?: string; fallback?: RemoteFallback }
)

/** `remote add|list|remove|default`; undefined for anything else (`remote token ...` has its own parser). */
export function parseProfileCommand(argv: string[], fallbackDir: string): ProfileCommand | undefined {
  const words: string[] = []
  const flags = new Map<string, string>()
  const booleans = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (["--dir", "--token-file", "--ca"].includes(token)) {
      const next = argv[++i]
      if (!next || next.startsWith("--")) throw new Error(`${token} needs a value`)
      flags.set(token, next)
    } else if (["--tls", "--default", "--local-first", "--remote-first"].includes(token)) booleans.add(token)
    else words.push(token)
  }
  if (words[0] !== "remote" || !["add", "list", "remove", "default"].includes(words[1] ?? "")) return undefined
  const dir = flags.get("--dir") ?? fallbackDir
  const fallback = booleans.has("--local-first") ? "local-first" : booleans.has("--remote-first") ? "remote-first" : undefined
  if (booleans.has("--local-first") && booleans.has("--remote-first")) throw new Error("use --local-first or --remote-first, not both")
  const name = words[2]
  if (words[1] === "list" && words.length === 2) return { dir, action: "list" }
  if (words[1] === "remove" && words.length === 3 && name) return { dir, action: "remove", name }
  if (words[1] === "default" && words.length <= 3) return { dir, action: "default", ...(name ? { name } : {}), ...(fallback ? { fallback } : {}) }
  if (words[1] === "add" && words.length === 4 && name) {
    return { dir, action: "add", name, connect: words[3]!, ...(flags.has("--token-file") ? { tokenFile: path.resolve(flags.get("--token-file")!) } : {}), ...(flags.has("--ca") ? { ca: path.resolve(flags.get("--ca")!) } : {}), tls: booleans.has("--tls"), makeDefault: booleans.has("--default"), ...(fallback ? { fallback } : {}) }
  }
  throw new Error("usage: remote add NAME HOST:PORT [--token-file F] [--ca F] [--tls] [--default] [--local-first] | list | remove NAME | default [NAME|none] [--local-first|--remote-first] [--dir D]")
}

export function runProfileCommand(command: ProfileCommand, out: { write(text: string): unknown }) {
  const current = readRemoteProfiles(command.dir) ?? { remotes: {} }
  if (command.action === "list") {
    for (const [name, profile] of Object.entries(current.remotes)) out.write(`${name}${current.defaultRemote === name ? " (default)" : ""}\t${profile.connect}\t${profile.tokenFile ? "token file" : "MENDCODE_TOKEN"}\n`)
    return
  }
  const next: RemoteProfiles = { ...current, remotes: { ...current.remotes } }
  if (command.action === "add") {
    if (!NAME.test(command.name)) throw new Error("remote name uses 1–64 letters, digits, _ or -")
    try { if (!parseRemoteAddress(command.connect).port) throw new Error() } catch { throw new Error("remote address must be host:port with a nonzero port") }
    next.remotes[command.name] = { connect: command.connect, ...(command.tokenFile ? { tokenFile: command.tokenFile } : {}), ...(command.ca ? { ca: command.ca } : {}), ...(command.tls ? { tls: true } : {}) }
    if (command.makeDefault) next.defaultRemote = command.name
    if (command.fallback) next.fallback = command.fallback
  } else if (command.action === "remove") {
    if (!next.remotes[command.name]) throw new Error(`no saved remote ${command.name}`)
    delete next.remotes[command.name]
    if (next.defaultRemote === command.name) delete next.defaultRemote
  } else {
    if (command.name && command.name !== "none" && !next.remotes[command.name]) throw new Error(`no saved remote ${command.name}`)
    if (command.name === "none") delete next.defaultRemote
    else if (command.name) next.defaultRemote = command.name
    if (command.fallback) next.fallback = command.fallback
    if (!command.name && !command.fallback) { out.write(`${current.defaultRemote ?? "none"} ${current.fallback ?? "remote-first"}\n`); return }
  }
  writeRemoteProfiles(command.dir, next)
  out.write("saved\n")
}

/** Flags that take a value and so do not make a command word: what is left decides whether this is a bare terminal start. */
const VALUE_FLAGS = new Set(["--dir", "--engine", "--session", "--format", "--compat", "--model", "--agent", "--cwd", "--directory", "-s", "-m", "--effort", "--permission"])
export function bareTerminal(args: readonly string[]) {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) i++
    else if (!args[i]!.startsWith("-")) return false
  }
  return true
}

export type RemoteChoice = { args: string[]; note?: string }
export type RemoteProbes = {
  /** Whether a TCP connection to the remote opens within a short time (no TLS, no token: reachability only). */
  reachable(address: string): Promise<boolean>
  /** Whether a daemon of this machine already answers. */
  localUp(dir: string): Promise<boolean>
}

/**
 * Turns `--remote NAME`, `--local` and the saved `defaultRemote` into the existing transport flags. An explicit `--connect`, `--server-url`
 * or `--socket` always wins and the saved remotes are not read. The default applies only to a bare terminal start, never to
 * `daemon`, `session`, `run` or other commands. `remote-first` (the default) tries the remote and falls back to this machine with a
 * note; `local-first` uses a local daemon that already runs and goes remote only when none does.
 */
export async function chooseRemote(input: { args: string[]; dir: string; probes: RemoteProbes }): Promise<RemoteChoice> {
  const args: string[] = []
  let name: string | undefined
  let local = false
  for (let i = 0; i < input.args.length; i++) {
    const token = input.args[i]!
    if (token === "--local") local = true
    else if (token === "--remote" || token.startsWith("--remote=")) {
      name = token === "--remote" ? input.args[++i] : token.slice("--remote=".length)
      if (!name || name.startsWith("--")) throw new Error("--remote needs a saved remote name")
    } else args.push(token)
  }
  if (name && local) throw new Error("use --remote or --local, not both")
  if (local) return { args }
  const explicit = args.some((token) => /^--(connect|server-url|socket)(=|$)/.test(token))
  if (explicit) {
    if (name) throw new Error("--remote cannot be combined with --connect, --server-url or --socket")
    return { args }
  }
  if (!name && !bareTerminal(args)) return { args }
  const profiles = readRemoteProfiles(input.dir)
  if (!name) {
    if (!profiles?.defaultRemote) return { args }
    name = profiles.defaultRemote
  }
  const profile = profiles?.remotes[name]
  if (!profile) throw new Error(`no saved remote ${name}; mendcode remote add ${name} HOST:PORT`)
  const attach = [...args, "--connect", profile.connect, ...(profile.tokenFile ? ["--token-file", profile.tokenFile] : []), ...(profile.ca ? ["--ca", profile.ca] : []), ...(profile.tls ? ["--tls"] : [])]
  const explicitName = input.args.some((token) => token === "--remote" || token.startsWith("--remote="))
  if (explicitName) return { args: attach }
  if ((profiles?.fallback ?? "remote-first") === "local-first" && await input.probes.localUp(input.dir)) return { args }
  if (await input.probes.reachable(profile.connect)) return { args: attach }
  return { args, note: `remote ${name} is not reachable; using this machine` }
}

export const defaultProbes: RemoteProbes = {
  async reachable(address) {
    const { hostname, port } = parseRemoteAddress(address)
    try {
      const socket = await Promise.race([
        Bun.connect({ hostname, port, socket: { data() {}, open() {}, close() {}, error() {} } }),
        Bun.sleep(1500).then(() => undefined),
      ])
      socket?.end()
      return socket !== undefined
    } catch { return false }
  },
  async localUp(dir) {
    const sock = path.join(dir, "mendd.sock")
    if (!existsSync(sock)) {
      const { readLocalEndpoint } = await import("@mendcode/client/local-endpoint")
      const endpoint = readLocalEndpoint(dir)
      if (!endpoint) return false
      try { process.kill(endpoint.pid, 0); return true } catch { return false }
    }
    try {
      const socket = await Bun.connect({ unix: sock, socket: { data() {}, open() {}, close() {}, error() {} } })
      socket.end()
      return true
    } catch { return false }
  },
}

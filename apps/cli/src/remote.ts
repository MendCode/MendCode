import { readFileSync } from "node:fs"
import type { RemoteTransport } from "@mendcode/client"
import { isLoopbackHost, parseRemoteAddress } from "@mendcode/protocol/wire"
import { normalizeAttach } from "./http-cli"
import { githubInvocation } from "./github-args"

export const REMOTE_DISABLED_NOTE = "remote: path attachments, clipboard images, external editor, TUI extensions and local TUI files disabled; export uses --copy; workflow and goal files unavailable"
const REMOTE_VALUES = new Set(["--connect", "--ca", "--token-file", "--socket", "--server-url", "--password", "--username"])

/** Removes transport flags before the existing automation parser sees them. Token values never appear in errors. */
export function parseRemoteFlags(argv: string[]) {
  const attach = normalizeAttach(argv)
  argv = attach.args
  const args: string[] = []
  const values = new Map<string, string>()
  let tls = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] === "-p" ? "--password" : argv[i] === "-u" ? "--username" : argv[i]!
    const [name, inline] = token.split(/=(.*)/s, 2)
    if (name === "--token" && ["github.run", "pr"].includes(githubInvocation(argv) ?? "")) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) throw new Error("--token needs a value")
      args.push("--token", value)
      continue
    }
    if (name === "--token" || name === "--insecure") throw new Error(`${name} is not supported`)
    if (name === "--tls") {
      if (inline !== undefined) throw new Error("--tls does not take a value")
      tls = true
    } else if (REMOTE_VALUES.has(name!)) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
      values.set(name!, value)
    } else args.push(token)
  }
  const socketPath = values.get("--socket")
  const localControl = args.some((token) => /^--(?:restart-daemon|engine)(?:=|$)/.test(token))
  if (socketPath) {
    if (values.size !== 1 || tls) throw new Error("--socket cannot be combined with TCP transport flags")
    if (localControl) throw new Error("socket attach cannot restart or select a local daemon engine")
    return { args, socketPath }
  }
  if (values.has("--connect") && values.has("--server-url")) throw new Error("use --connect or --server-url, not both")
  const address = values.get("--connect") ?? values.get("--server-url")
  if (!address && (tls || values.size)) throw new Error("--tls, --ca and --token-file need --connect")
  if (!address) return { args }
  if (/^https?:\/\//.test(address)) {
    let url: URL
    try { url = new URL(address) } catch { throw new Error("attach needs a valid HTTP URL") }
    const host = url.hostname.replace(/^\[|\]$/g, "")
    if (url.username || url.password || url.hash || url.search || url.pathname !== "/") throw new Error("attach URL must have no credentials, path, query or fragment")
    if (url.protocol === "http:" && host !== "localhost" && !isLoopbackHost(host)) throw new Error("plaintext HTTP attach requires loopback")
    if (url.port === "0") throw new Error("HTTP attach needs a nonzero port")
    if (localControl) throw new Error("HTTP attach cannot restart or select a local daemon engine")
    if (url.protocol === "http:" && (tls || values.has("--ca"))) throw new Error("HTTP TLS flags require an HTTPS URL")
    const username = values.get("--username")
    if (username && !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) throw new Error("invalid HTTP username")
    return { args, remote: { hostname: host, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), tls: url.protocol === "https:", httpUrl: url.toString(), ...(attach.directory ? { directory: attach.directory } : {}), ...(username ? { username } : {}), ...(values.has("--password") ? { password: values.get("--password")! } : {}), ...(values.has("--ca") ? { caFile: values.get("--ca")! } : {}), ...(values.has("--token-file") ? { tokenFile: values.get("--token-file")! } : {}) } }
  }
  if (attach.directory || values.has("--password") || values.has("--username")) throw new Error("--password/--username require an HTTP attach URL")
  const parsed = parseRemoteAddress(address)
  if (!parsed.port) throw new Error("--connect needs a nonzero port")
  if (localControl) throw new Error("remote attach cannot restart or select a local daemon engine")
  return { args, remote: { ...parsed, tls: tls || values.has("--ca") || !isLoopbackHost(parsed.hostname), ...(values.has("--ca") ? { caFile: values.get("--ca")! } : {}), ...(values.has("--token-file") ? { tokenFile: values.get("--token-file")! } : {}) } }
}

export function remoteTransport(flags: NonNullable<ReturnType<typeof parseRemoteFlags>["remote"]>, env: Record<string, string | undefined>): RemoteTransport {
  let token: string
  let ca: string | undefined
  try {
    token = (flags.tokenFile ? readFileSync(flags.tokenFile, "utf8") : "password" in flags && flags.password ? flags.password : env.MENDCODE_TOKEN ?? ("httpUrl" in flags ? env.OPENCODE_SERVER_PASSWORD : undefined) ?? "").trim()
    ca = flags.caFile ? readFileSync(flags.caFile, "utf8") : undefined
  } catch { throw new Error("cannot read remote token file or CA") }
  if (!token || token.length > 4096) throw new Error("remote attach needs MENDCODE_TOKEN or --token-file")
  return { hostname: flags.hostname, port: flags.port, tls: flags.tls, token, ...(ca ? { ca } : {}), ...("httpUrl" in flags ? { httpUrl: flags.httpUrl, ...(flags.directory ? { directory: flags.directory } : {}), ...((flags.username || flags.password || env.OPENCODE_SERVER_USERNAME) ? { username: flags.username ?? env.OPENCODE_SERVER_USERNAME ?? "mendcode" } : {}) } : {}) }
}

export type TokenCommand = { dir: string } & ({ action: "create"; name?: string; readOnly: boolean } | { action: "list" } | { action: "revoke"; name: string })
export function parseTokenCommand(argv: string[]): TokenCommand | undefined {
  const words: string[] = []
  let dir: string | undefined
  let name: string | undefined
  let readOnly = false
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!
    if (value === "--dir" || value === "--name") {
      const next = argv[++i]
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`)
      if (value === "--dir") dir = next
      else name = next
    } else if (value === "--read-only") readOnly = true
    else words.push(value)
  }
  if (words[0] !== "remote") return undefined
  if (!dir) throw new Error("remote token commands require explicit --dir")
  if (words[1] !== "token") throw new Error("usage: remote token create|list|revoke <name> --dir D")
  if (words[2] === "create" && words.length === 3) return { dir, action: "create", readOnly, ...(name ? { name } : {}) }
  if (words[2] === "list" && words.length === 3 && !name && !readOnly) return { dir, action: "list" }
  if (words[2] === "revoke" && words.length === 4 && !name && !readOnly) return { dir, action: "revoke", name: words[3]! }
  throw new Error("usage: remote token create [--read-only] [--name N] | list | revoke <name> --dir D")
}

export async function runTokenCommand(command: TokenCommand, out: { write(text: string): unknown }) {
  const { remoteTokens } = await import("@mendcode/daemon/remote")
  const tokens = remoteTokens(command.dir)
  if (command.action === "create") out.write(`${tokens.create(command).token}\n`)
  else if (command.action === "list") {
    for (const entry of tokens.list()) out.write(`${entry.name}\t${entry.readOnly ? "read-only" : "full"}\t${new Date(entry.createdAt).toISOString()}\t${entry.lastUsedAt === undefined ? "never" : new Date(entry.lastUsedAt).toISOString()}\n`)
  } else {
    tokens.revoke(command.name)
    out.write("revoked\n")
  }
}

import { PROGRAM_NAME } from "@mendcode/program"
export const HTTP_USAGE = [
  `${PROGRAM_NAME} serve|web --dir DATA [--cwd PROJECT] [--port N] [--hostname 127.0.0.1|::1]`,
  "  --cors ORIGIN (repeatable) · web: --no-open · --pty (opt-in) · --edit (opt-in browser file saves)",
  `${PROGRAM_NAME} attach URL [--dir PROJECT] [--continue | --session ID] [--fork] [--diagnostics]`,
  "  --token-file FILE or MENDCODE_TOKEN · --password TOKEN · --username NAME (default mendcode)",
].join("\n") + "\n"

const VALUES = new Set(["--dir", "--data-dir", "--cwd", "--project", "--engine", "--session", "--model", "--agent", "--prompt", "--initial-message", "--variant", "--effort", "--token-file", "--ca", "--connect", "--server-url", "--socket", "--password", "--username", "-p", "-u", "--port", "--hostname", "--cors", "--mdns-domain"])
export function commandIndex(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (VALUES.has(token)) i++
    else if (!token.startsWith("-")) return i
  }
  return -1
}

export type ServerCommand = { kind: "serve" | "web"; dir?: string; cwd?: string; engine?: string; port?: number; hostname?: string; cors: string[]; open: boolean; help: boolean; pty?: boolean; edit?: boolean }
export function parseServerCommand(argv: string[]): ServerCommand | undefined {
  const at = commandIndex(argv)
  const kind = argv[at]
  if (kind !== "serve" && kind !== "web") return undefined
  const result: ServerCommand = { kind, cors: [], open: kind === "web", help: false }
  const args = argv.filter((_, index) => index !== at)
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s, 2)
    if (["--help", "-h", "--no-open", "--pty", "--no-pty", "--edit", "--no-edit"].includes(name!)) {
      if (inline !== undefined) throw new Error(`${name} takes no value`)
      if (name === "--help" || name === "-h") result.help = true
      else if (name === "--no-open") result.open = false
      else if (name === "--pty" || name === "--no-pty") result.pty = name === "--pty"
      else if (name === "--edit" || name === "--no-edit") result.edit = name === "--edit"
      continue
    }
    if (!["--dir", "--data-dir", "--cwd", "--project", "--engine", "--port", "--hostname", "--cors"].includes(name!)) throw new Error(`unknown server flag ${name?.startsWith("-") ? name : "(positional argument)"}`)
    const value = inline ?? args[++i]
    if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
    if (name === "--dir" || name === "--data-dir") result.dir = value
    else if (name === "--cwd" || name === "--project") result.cwd = value
    else if (name === "--engine") result.engine = value
    else if (name === "--hostname") {
      if (!["127.0.0.1", "::1", "localhost"].includes(value)) throw new Error("HTTP hostname must be loopback")
      result.hostname = value
    } else if (name === "--port") {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error("--port must be 0–65535")
      result.port = Number(value)
    } else {
      let origin: URL
      try { origin = new URL(value) } catch { throw new Error("--cors needs an exact HTTP origin") }
      if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value || origin.username || origin.password) throw new Error("--cors needs an exact HTTP origin")
      result.cors.push(value)
    }
  }
  if (!result.dir && !result.help) throw new Error("serve/web require explicit --dir")
  return result
}

/** attach's --dir is the server project, while --data-dir retains v2 storage naming. */
export function normalizeAttach(argv: string[]) {
  const at = commandIndex(argv)
  if (argv[at] !== "attach") return { args: argv }
  const url = argv[at + 1]
  if (!url || !/^https?:\/\//.test(url)) throw new Error("attach needs an HTTP URL")
  const args: string[] = []
  let directory: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (i === at) { i++; continue }
    const [name, inline] = argv[i]!.split(/=(.*)/s, 2)
    if (name === "--dir") {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) throw new Error("--dir needs a project directory")
      directory = value
    } else args.push(argv[i]!)
  }
  return { args: ["--connect", url, ...args], directory }
}

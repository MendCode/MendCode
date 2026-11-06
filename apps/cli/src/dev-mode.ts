import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { AGENT_SHELL_ENV } from "@mendcode/protocol/wire"
import { PROGRAM_NAME } from "@mendcode/program"
import { dataDirFromEnv, defaultDataDirNow, sameDir } from "@mendcode/program/data-dir"

/**
 * `mendcode dev` (docs/dev-mode.md): a second daemon on its own data directory that runs this checkout's source, so a change to
 * MendCode is tried without restarting the daemon the work is done under. Loaded only by `dev`; nothing here is on the startup path.
 */
export const DEV_ACTIONS = ["start", "restart", "stop", "status", "tui", "run", "keys"] as const
export type DevAction = (typeof DEV_ACTIONS)[number]

export const DEV_USAGE = `usage: ${PROGRAM_NAME} dev [--dir DEVDATA] [--checkout PATH] <command>

  start             start the development daemon (this checkout's source, its own data directory)
  restart           restart only that daemon (running turns in it are interrupted)
  stop              stop only that daemon
  status            the development daemon, its data directory and the checkout it runs
  tui [args]        the terminal on the development daemon, marked DEV
  run [args]        ${PROGRAM_NAME} run on the development daemon (a message, --command, ...)
  keys              copy the main installation's API-key providers again (providers.json, 0600)

The data directory is --dir, else MENDCODE_DEV_DIR, else ~/.mendcode-dev. The checkout is --checkout, else MENDCODE_DEV_CHECKOUT,
else the git checkout around the current folder. The main data directory and its daemon are never touched.
`

export type DevCommand = { action: DevAction; dir?: string; checkout?: string; rest: string[]; help: boolean }

/** `dev [--dir D] [--checkout P] <command> [args]`; flags before the command only, everything after `tui`/`run` goes to that command. */
export function parseDev(argv: readonly string[]): DevCommand | string {
  const rest = argv.slice(1)
  const out: { dir?: string; checkout?: string } = {}
  let help = false
  let index = 0
  for (; index < rest.length; index++) {
    const token = rest[index]!
    const [name, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined]
    if (name === "--help" || name === "-h") help = true
    else if (name === "--dir" || name === "--data-dir" || name === "--checkout") {
      const value = inline ?? rest[++index]
      if (!value || value.startsWith("--")) return `${name} needs a value`
      out[name === "--checkout" ? "checkout" : "dir"] = value
    } else break
  }
  const action = rest[index]
  if (!action) return help ? { action: "status", ...out, rest: [], help: true } : "dev needs a command"
  if (!(DEV_ACTIONS as readonly string[]).includes(action)) return `unknown dev command ${action}`
  const tail = rest.slice(index + 1)
  if (action !== "tui" && action !== "run" && tail.some((word) => word !== "--help" && word !== "-h")) return `dev ${action} takes no arguments`
  if ((action === "tui" || action === "run") && tail.some((word) => /^--(?:dir|data-dir)(?:=|$)/.test(word))) return `dev ${action} always uses the development data directory; set it with ${PROGRAM_NAME} dev --dir DIR ${action}`
  return { action: action as DevAction, ...out, rest: action === "tui" || action === "run" ? tail : [], help: help || tail.includes("--help") || tail.includes("-h") }
}

/** The development data directory: `--dir`, `MENDCODE_DEV_DIR`, `~/.mendcode-dev`. */
export const devDataDir = ({ dir, env, home = homedir() }: { dir?: string | undefined; env: Readonly<Record<string, string | undefined>>; home?: string }) => path.resolve(dir ?? (env.MENDCODE_DEV_DIR?.trim() || path.join(home, ".mendcode-dev")))

/** The data directory of the installation `dev` runs from: the one a session's shell names, else `MENDCODE_DIR`, else the default. */
export const mainDataDir = ({ env, home = homedir() }: { env: Readonly<Record<string, string | undefined>>; home?: string }) => path.resolve(dataDirFromEnv(env) ?? defaultDataDirNow(home))

/** Why `dir` may not be the development directory: it is where a daemon the user (or the calling session) lives. */
export function devDirRefusal({ dir, env, home = homedir() }: { dir: string; env: Readonly<Record<string, string | undefined>>; home?: string }): string | undefined {
  const main = [mainDataDir({ env, home }), path.join(home, ".mendcode"), path.join(home, ".mendcode-v2"), env[AGENT_SHELL_ENV]].filter((entry): entry is string => Boolean(entry))
  if (main.some((entry) => sameDir(entry, dir))) return `${dir} is in use by the main installation or by this session; the development daemon needs its own (--dir or MENDCODE_DEV_DIR)`
  return undefined
}

const isCheckout = (root: string) => existsSync(path.join(root, "apps", "cli", "src", "main.ts")) && existsSync(path.join(root, "packages", "daemon", "src", "main.ts"))

/** The checkout to run: the explicit one, else the first folder from `cwd` upward that holds the CLI's source, else the one this process runs from. */
export function findCheckout({ explicit, env, cwd, own }: { explicit?: string | undefined; env: Readonly<Record<string, string | undefined>>; cwd: string; own?: string | undefined }): string | undefined {
  const named = explicit ?? env.MENDCODE_DEV_CHECKOUT?.trim()
  if (named) return isCheckout(path.resolve(named)) ? path.resolve(named) : undefined
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (isCheckout(dir)) return dir
    if (path.dirname(dir) === dir) break
  }
  return own && isCheckout(own) ? own : undefined
}

/** Bun to run the source with: this process when it is Bun itself, else the one on PATH. */
export function bunExecutable({ execPath, main, which }: { execPath: string; main: string; which(name: string): string | null }): string | undefined {
  if (!/^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main) && /^bun(\.exe)?$/i.test(path.basename(execPath))) return execPath
  return which("bun") ?? undefined
}

/** The environment of every process `dev` starts: the development directory selects the daemon, and `MENDCODE_DEV` names it so only a process on that directory shows DEV. */
export function devEnvironment({ env, dir }: { env: Readonly<Record<string, string | undefined>>; dir: string }): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && key !== AGENT_SHELL_ENV && key !== "MENDCODE_DIR" && key !== "MENDCODE_V2_DIR") next[key] = value
  next.MENDCODE_DIR = dir
  next.MENDCODE_DEV = dir
  // The terminal talks to a separate daemon, so `dev restart` is the only thing that restarts it.
  next.MENDCODE_PROCESS = "daemon"
  return next
}

/**
 * API-key providers of the main installation, copied once (mode 0600, the directory 0700) so the development daemon lists the
 * same models: only `providers.json`'s `providers`, never printed. OAuth logins (ChatGPT, Copilot) are not copied: their refresh
 * token rotates on use, so a second copy would sign the main one out. Returns how many providers were copied, or undefined when
 * nothing was (nothing to copy, or the development file exists and `replace` is off).
 */
export function copyProviderKeys({ from, to, replace }: { from: string; to: string; replace: boolean }): number | undefined {
  const source = path.join(from, "providers.json")
  const target = path.join(to, "providers.json")
  if (!existsSync(source) || (!replace && existsSync(target))) return undefined
  let providers: unknown
  try { providers = (JSON.parse(readFileSync(source, "utf8")) as { providers?: unknown }).providers } catch { return undefined }
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined
  mkdirSync(to, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
  return Object.keys(providers).length
}

export type DevPorts = {
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  home?: string
  out: { write(text: string): unknown }
  err: { write(text: string): unknown }
  /** Runs the checkout's CLI with the development environment and resolves with its exit code. */
  spawn(input: { command: string[]; env: Record<string, string>; cwd: string; inherit: boolean }): Promise<number>
  execPath: string
  main: string
  which(name: string): string | null
  own?: string
}

/** What each command runs on the checkout's CLI. A restart interrupts running turns: the development daemon is disposable. */
export const devArguments = (action: DevAction, rest: readonly string[]): string[] =>
  action === "start" ? ["daemon", "start"]
  : action === "restart" ? ["daemon", "restart", "--force"]
  : action === "stop" ? ["daemon", "stop", "--force"]
  : action === "status" ? ["daemon", "status"]
  : action === "tui" ? rest.slice()
  : action === "run" ? ["run", ...rest]
  : []

export async function runDev(command: DevCommand, ports: DevPorts): Promise<number> {
  if (command.help) { ports.out.write(DEV_USAGE); return 0 }
  const fail = (message: string) => { ports.err.write(`error: ${message}\n`); return 1 }
  const dir = devDataDir({ dir: command.dir, env: ports.env, ...(ports.home ? { home: ports.home } : {}) })
  const refusal = devDirRefusal({ dir, env: ports.env, ...(ports.home ? { home: ports.home } : {}) })
  if (refusal) return fail(refusal)
  const checkout = findCheckout({ explicit: command.checkout, env: ports.env, cwd: ports.cwd, own: ports.own })
  if (!checkout) return fail(`no MendCode checkout found from ${ports.cwd}; run it inside the repository or pass --checkout PATH`)
  if (!existsSync(path.join(checkout, "node_modules"))) return fail(`${checkout} has no node_modules; run bun install --frozen-lockfile there`)
  const bun = bunExecutable({ execPath: ports.execPath, main: ports.main, which: ports.which })
  if (!bun) return fail("dev mode runs the checkout's source with Bun, and bun is not on PATH")
  const main = mainDataDir({ env: ports.env, ...(ports.home ? { home: ports.home } : {}) })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (command.action === "keys") {
    const copied = copyProviderKeys({ from: main, to: dir, replace: true })
    ports.out.write(copied === undefined ? "No API-key providers to copy.\n" : `Copied ${copied} API-key provider${copied === 1 ? "" : "s"} to ${dir} (mode 0600).\n`)
    return 0
  }
  if (command.action !== "stop" && command.action !== "status") copyProviderKeys({ from: main, to: dir, replace: false })
  const env = devEnvironment({ env: ports.env, dir })
  const interactive = command.action === "tui" || command.action === "run"
  if (command.action === "status") ports.out.write(`Development daemon\nCheckout: ${checkout}\nMain data: ${main} (not touched)\n`)
  return ports.spawn({ command: [bun, path.join(checkout, "apps", "cli", "src", "main.ts"), "--dir", dir, ...devArguments(command.action, command.rest)], env, cwd: interactive ? ports.cwd : checkout, inherit: true })
}

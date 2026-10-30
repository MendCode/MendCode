import { homedir } from "node:os"
import path from "node:path"
import { PROGRAM_NAME } from "@mendcode/program"

/**
 * What the setup says about the other coding tools on this machine (docs/setup.md#own-logins): installed, signed in, and the plan
 * only when the tool reports it. Read from each tool's own status command; MendCode never opens their credential files and never
 * reports an email, organization or token. Detection orients only: with `ownLogins` MendCode signs in for itself.
 */

export type HarnessStatus = {
  id: "claude" | "codex"
  installed: boolean
  /** Undefined when the tool could not say (an old version, a timeout). */
  signedIn?: boolean
  /** How it is signed in, as the tool names it (`claude.ai`, `api_key`, `chatgpt`). */
  method?: string
  /** The subscription the tool reports (`max`, `pro`); absent when it does not say, never guessed. */
  plan?: string
  /** Claude Code only: `mendcode` when MendCode runs it with its own profile, `default` with `~/.claude`. */
  profile?: "mendcode" | "default"
  /** The official command that signs this tool in for MendCode, when it is not signed in. */
  login?: string
}

const STATUS_TIMEOUT_MS = 5000
/** A word the tools use for a method or plan; anything else is not shown. */
const WORD = /^[a-z][a-z0-9_.-]{0,29}$/i

/** MendCode's own Claude Code profile: a config directory of its own, so its login is not `~/.claude`'s. */
export const claudeProfileDir = (dataDir: string) => path.join(dataDir, "claude-code")

/** The variables a Claude Code process gets for the profile in force: MendCode's own one with `ownLogins`, else none. */
export function claudeProfileEnv(input: { ownLogins: boolean | undefined; dataDir: string }): Record<string, string> | undefined {
  return input.ownLogins ? { CLAUDE_CONFIG_DIR: claudeProfileDir(input.dataDir) } : undefined
}

type Run = (argv: string[], env: Record<string, string> | undefined) => Promise<{ code: number; out: string } | undefined>

const runStatus: Run = async (argv, env) => {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) })
    const timer = setTimeout(() => child.kill(), STATUS_TIMEOUT_MS)
    try {
      // `codex login status` answers on stderr (seen with codex-cli 0.162.1), `claude auth status --json` on stdout.
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code: await child.exited, out: (out.trim() ? out : err).slice(0, 16_384) }
    } finally { clearTimeout(timer) }
  } catch { return undefined }
}

/** `claude auth status --json`: `loggedIn`, `authMethod` and `subscriptionType` only. */
export async function claudeStatus(input: { bin: string; ownLogins: boolean | undefined; dataDir: string; run?: Run }): Promise<HarnessStatus> {
  const env = claudeProfileEnv(input)
  const profile = input.ownLogins ? "mendcode" : "default"
  // MendCode's profile: `mendcode claude login` runs that same official login with it (a path to type would not fit the page).
  const login = env ? `${PROGRAM_NAME} claude login${path.resolve(input.dataDir) === path.join(homedir(), ".mendcode-v2") ? "" : ` --dir ${input.dataDir}`}` : "claude auth login"
  const done = await (input.run ?? runStatus)([input.bin, "auth", "status", "--json"], env)
  if (!done) return { id: "claude", installed: false, profile }
  let parsed: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined
  try { parsed = JSON.parse(done.out) as typeof parsed } catch { parsed = undefined }
  if (!parsed || typeof parsed.loggedIn !== "boolean") return { id: "claude", installed: true, profile, login }
  const method = typeof parsed.authMethod === "string" && WORD.test(parsed.authMethod) && parsed.authMethod !== "none" ? parsed.authMethod : undefined
  const plan = typeof parsed.subscriptionType === "string" && WORD.test(parsed.subscriptionType) ? parsed.subscriptionType : undefined
  return { id: "claude", installed: true, signedIn: parsed.loggedIn, profile, ...(parsed.loggedIn && method ? { method } : {}), ...(parsed.loggedIn && plan ? { plan } : {}), ...(!parsed.loggedIn ? { login } : {}) }
}

/** `codex login status`: whether the Codex CLI is signed in, and with what. Only orientation: MendCode does not use its login with `ownLogins`. */
export async function codexStatus(input: { bin: string; run?: Run }): Promise<HarnessStatus> {
  const done = await (input.run ?? runStatus)([input.bin, "login", "status"], undefined)
  if (!done) return { id: "codex", installed: false }
  const signedIn = done.code === 0 && /logged in/i.test(done.out) && !/not logged in/i.test(done.out)
  const method = /chatgpt/i.test(done.out) ? "chatgpt" : /api key/i.test(done.out) ? "api_key" : undefined
  return { id: "codex", installed: true, signedIn, ...(signedIn && method ? { method } : {}), ...(!signedIn ? { login: "codex login" } : {}) }
}

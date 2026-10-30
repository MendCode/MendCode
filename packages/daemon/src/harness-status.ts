/**
 * What the setup says about the other coding tools on this machine (docs/setup.md#logins): installed, signed in, and the plan only
 * when the tool reports it. Read from each tool's own status command; MendCode never opens their credential files and never reports
 * an email, organization or token. Claude models run in that same Claude Code, signed in as it is; the Codex CLI's login only orients,
 * since with `ownLogins` the native engine signs in to ChatGPT for itself.
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
  /** The tool's own official sign-in command, when it is not signed in. */
  login?: string
}

const STATUS_TIMEOUT_MS = 5000
/** A word the tools use for a method or plan; anything else is not shown. */
const WORD = /^[a-z][a-z0-9_.-]{0,29}$/i

type Run = (argv: string[]) => Promise<{ code: number; out: string } | undefined>

const runStatus: Run = async (argv) => {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill(), STATUS_TIMEOUT_MS)
    try {
      // `codex login status` answers on stderr (seen with codex-cli 0.162.1), `claude auth status --json` on stdout.
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code: await child.exited, out: (out.trim() ? out : err).slice(0, 16_384) }
    } finally { clearTimeout(timer) }
  } catch { return undefined }
}

/** `claude auth status --json` of the Claude Code MendCode runs (the user's, with its own config): `loggedIn`, `authMethod` and `subscriptionType` only. */
export async function claudeStatus(input: { bin: string; run?: Run }): Promise<HarnessStatus> {
  const done = await (input.run ?? runStatus)([input.bin, "auth", "status", "--json"])
  if (!done) return { id: "claude", installed: false }
  let parsed: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined
  try { parsed = JSON.parse(done.out) as typeof parsed } catch { parsed = undefined }
  if (!parsed || typeof parsed.loggedIn !== "boolean") return { id: "claude", installed: true, login: "claude auth login" }
  const method = typeof parsed.authMethod === "string" && WORD.test(parsed.authMethod) && parsed.authMethod !== "none" ? parsed.authMethod : undefined
  const plan = typeof parsed.subscriptionType === "string" && WORD.test(parsed.subscriptionType) ? parsed.subscriptionType : undefined
  return { id: "claude", installed: true, signedIn: parsed.loggedIn, ...(parsed.loggedIn && method ? { method } : {}), ...(parsed.loggedIn && plan ? { plan } : {}), ...(!parsed.loggedIn ? { login: "claude auth login" } : {}) }
}

/** `codex login status`: whether the Codex CLI is signed in, and with what. Only orientation: MendCode does not use its login with `ownLogins`. */
export async function codexStatus(input: { bin: string; run?: Run }): Promise<HarnessStatus> {
  const done = await (input.run ?? runStatus)([input.bin, "login", "status"])
  if (!done) return { id: "codex", installed: false }
  const signedIn = done.code === 0 && /logged in/i.test(done.out) && !/not logged in/i.test(done.out)
  const method = /chatgpt/i.test(done.out) ? "chatgpt" : /api key/i.test(done.out) ? "api_key" : undefined
  return { id: "codex", installed: true, signedIn, ...(signedIn && method ? { method } : {}), ...(!signedIn ? { login: "codex login" } : {}) }
}

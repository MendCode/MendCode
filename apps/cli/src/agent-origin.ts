import { realpathSync } from "node:fs"
import path from "node:path"
import { AGENT_LIMIT_CAPABILITY, AGENT_ORIGIN_CAPABILITY, AGENT_SHELL_ENV, agentCommandClass, agentRefusal } from "@mendcode/protocol/wire"
import { PROGRAM_NAME } from "@mendcode/program"

/**
 * This program, started from a session's own shell (docs/permissions.md): it says so to the daemon and refuses, before
 * asking, what only the user decides. The shell's variable names the data directory of the daemon the session runs under,
 * so a command against another data directory (a throwaway daemon, a test) is not held back. Zod-free.
 */
const real = (target: string) => { try { return realpathSync(target) } catch { return path.resolve(target) } }

/** Whether this process was started by a session whose daemon owns `dir`. */
export function startedBySession({ env, dir }: { env: Record<string, string | undefined>; dir: string }) {
  const marker = env[AGENT_SHELL_ENV]
  return Boolean(marker) && real(marker!) === real(dir)
}

/** This process's hard file-size limit in bytes, when it has one (a session's shell sets it and nothing can raise it again). */
function fileLimit(): number | undefined {
  try {
    const hard = (process.report?.getReport() as { userLimits?: { file_size_blocks?: { hard?: unknown } } } | undefined)?.userLimits?.file_size_blocks?.hard
    return typeof hard === "number" && Number.isFinite(hard) ? hard : undefined
  } catch { return undefined }
}

/** What `hello` carries: the daemon restricts the connection on either, and compares the limit with its own. */
export function originCapabilities(input: { env: Record<string, string | undefined>; dir: string; limit?: number | undefined }): string[] {
  const limit = "limit" in input ? input.limit : fileLimit()
  return [...(startedBySession(input) ? [AGENT_ORIGIN_CAPABILITY] : []), ...(limit ? [`${AGENT_LIMIT_CAPABILITY}${limit}`] : [])]
}

const quote = (word: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
/** The command as the user would type it; a value that follows a token or key flag is never repeated. */
export function shownCommand(argv: readonly string[]) {
  return [PROGRAM_NAME, ...argv.map((word, index) => (/^--?(?:token|password|api-key|client-secret)$/i.test(argv[index - 1] ?? "") ? "…" : quote(word)))].join(" ").slice(0, 400)
}

export function originRefusal({ argv, what }: { argv: readonly string[]; what: string }) {
  return agentRefusal({ what: `\`${shownCommand(argv)}\` ${what}`, ask: "run it from their own terminal, or to change it in the TUI (/settings, /permissions)" })
}

type Reply = { ok: true; result?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

/**
 * The same client, with what only the user decides answered here instead of sent. Session work goes to the daemon, which
 * knows the calling session's mode; approving a request never does.
 */
export function guardClient<Client extends { send(command: never): Promise<unknown> }>(client: Client, argv: readonly string[]): Client {
  const send = client.send.bind(client) as (command: { type: string; decision?: { kind?: string } }) => Promise<Reply>
  const refuse = (what: string): Reply => ({ ok: false, error: { code: "forbidden", message: originRefusal({ argv, what }) } })
  ;(client as { send: unknown }).send = async (command: { type: string; decision?: { kind?: string } }) => {
    const kind = agentCommandClass(command.type)
    if (kind === "owner") return refuse(`needs ${command.type}, which only the user decides`)
    if (command.type === "request.resolve" && command.decision?.kind !== "deny") return refuse("would answer an approval on the user's behalf")
    return send(command)
  }
  return client
}

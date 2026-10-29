import type { ReasoningEffort } from "@mendcode/protocol"
import { REASONING_EFFORTS } from "@mendcode/protocol/wire"
import type { ParseResult, Common } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export const GITHUB_USAGE = `usage: ${PROGRAM_NAME} github install [--model PROVIDER/MODEL] [--write]\n       ${PROGRAM_NAME} github install --hosted --model PROVIDER/MODEL --release TAG --sha256 HEX [--write]\n       ${PROGRAM_NAME} github run [--event JSON] [--token TOKEN] [--model PROVIDER/MODEL] [--variant NAME] [--effort LEVEL] [--prompt TEXT] [--mentions /mc,/mendcode] [--publish] [--approve] [--thinking] [--attachments] [--review]\n  --dir DATA selects daemon storage; --project PATH selects the checkout; --json\n  Defaults: workflow preview, local response, no publishing or tool approval\n  Actions: GITHUB_EVENT_PATH/NAME, GITHUB_REPOSITORY/ACTOR, GH_TOKEN or GITHUB_TOKEN, MODEL, VARIANT, EFFORT, PROMPT, MENTIONS`
export const PR_USAGE = `usage: ${PROGRAM_NAME} pr NUMBER [--token TOKEN] [--no-tui] [--json] [--dir DATA] [--project PATH]\n  Clean checkout only; opens MendCode on pr/NUMBER; donor session links are skipped`
export type GithubAutomation = { kind: "github.install"; model?: string; write: boolean; hosted?: boolean; release?: string; sha256?: string } | { kind: "github.run"; event?: string; token?: string; model?: string; variant?: string; effort?: ReasoningEffort; prompt?: string; mentions?: string[]; publish: boolean; approve: boolean; thinking: boolean; attachments: boolean; review?: boolean } | { kind: "pr"; number: number; token?: string; noTui: boolean }
const values = new Set(["dir", "data-dir", "project", "cwd", "engine", "format", "compat", "token", "model", "variant", "effort", "event", "prompt", "mentions", "connect", "server-url", "ca", "token-file", "socket", "release", "sha256"])
const booleans = new Set(["json", "help", "write", "publish", "approve", "thinking", "attachments", "no-tui", "hosted", "review"])

/** Locate command words without mistaking credential/transport option values for commands. */
export function githubInvocation(argv: string[]) {
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith("--")) { if (!token.includes("=") && values.has(token.slice(2))) i++; continue }
    if (token === "-h" || token === "-v") continue
    words.push(token)
  }
  return words[0] === "github" ? words[1] === "run" ? "github.run" : "github.install" : words[0] === "pr" ? "pr" : undefined
}

export function parseGithub(argv: string[]): ParseResult | undefined {
  const invocation = githubInvocation(argv)
  if (!invocation) return
  const topic = invocation === "pr" ? "pr" : "github"
  const bad = (message: string): ParseResult => ({ ok: false, topic, message })
  const flags = new Map<string, string | true>(), words: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith("-")) { words.push(token); continue }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (flags.has(name!)) return bad("Duplicate GitHub option")
    if (booleans.has(name!)) {
      if (inline !== undefined) return bad(`--${name} takes no value`)
      flags.set(name!, true)
    } else if (values.has(name!)) {
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--") || value.includes("\0") || value.length > (name === "event" ? 256_000 : name === "prompt" ? 50_000 : 4096) || !["event", "prompt"].includes(name!) && /[\x00-\x1f\x7f]/.test(value)) return bad(`--${name} needs a bounded value`)
      flags.set(name!, value)
    } else return bad("Unknown GitHub option")
  }
  if (flags.has("help")) return { ok: true, command: { kind: "help", topic, json: false } }
  if (flags.has("compat")) return bad("GitHub commands use the MendCode CLI envelope; --compat is unavailable")
  if (flags.has("format") && !["json", "text", "table"].includes(String(flags.get("format")))) return bad("--format must be json, text or table")
  if (flags.has("dir") && flags.has("data-dir") || flags.has("project") && flags.has("cwd")) return bad("Choose one data directory and one project option")
  const operation = words[0] === "pr" ? "pr" : words[1]
  if (!operation || !["install", "run", "pr"].includes(operation) || words.length !== 2) return bad(topic === "pr" ? PR_USAGE : GITHUB_USAGE)
  const allowed = new Set(["dir", "data-dir", "project", "cwd", "engine", "format", "json", ...(operation === "install" ? ["model", "write", "hosted", "release", "sha256"] : operation === "pr" ? ["token", "no-tui"] : ["event", "token", "model", "variant", "effort", "prompt", "mentions", "publish", "approve", "thinking", "attachments", "review"])])
  if ([...flags.keys()].some((key) => !allowed.has(key))) return bad("Option does not apply to this GitHub command")
  const common: Common = { json: flags.has("json") || flags.get("format") === "json", ...(flags.has("dir") || flags.has("data-dir") ? { dir: String(flags.get("dir") ?? flags.get("data-dir")) } : {}), ...(flags.has("project") || flags.has("cwd") ? { projectDir: String(flags.get("project") ?? flags.get("cwd")) } : {}) }
  if (operation === "pr") {
    if (!/^[1-9]\d*$/.test(words[1]!) || Number(words[1]) > 2147483647) return bad("PR number must be a positive integer")
    return { ok: true, command: { ...common, kind: "pr", number: Number(words[1]), noTui: flags.has("no-tui"), ...(flags.has("token") ? { token: String(flags.get("token")) } : {}) } }
  }
  const model = flags.get("model")
  if (model && !/^[^/\s]+\/[^\s]+$/.test(String(model))) return bad("Model must be PROVIDER/MODEL")
  if (operation === "install") {
    const hosted = flags.has("hosted"), release = flags.get("release"), sha256 = flags.get("sha256")
    if (!hosted && (release || sha256)) return bad("--release and --sha256 pin the hosted workflow; add --hosted")
    if (hosted && (!release || !sha256)) return bad("--hosted pins one release: pass --release TAG and --sha256 HEX (the install.sh line of that release's SHA256SUMS)")
    if (sha256 && !/^[0-9a-f]{64}$/.test(String(sha256))) return bad("--sha256 must be 64 lowercase hex characters")
    if (release && !/^(?:v\d+\.\d+\.\d+(?:-beta\.\d+|-nightly\.\d{8}\.\d+)?|dev-[0-9a-f]{7,40})$/.test(String(release))) return bad("--release must be a release tag (vX.Y.Z, vX.Y.Z-beta.N, vX.Y.Z-nightly.DATE.RUN or dev-<sha>)")
    return { ok: true, command: { ...common, kind: "github.install", write: flags.has("write"), ...(model ? { model: String(model) } : {}), ...(hosted ? { hosted: true, release: String(release), sha256: String(sha256) } : {}) } }
  }
  if (flags.has("review") && (flags.has("approve") || flags.has("prompt") || flags.has("attachments"))) return bad("--review runs the PR reviewer: --approve, --prompt and --attachments do not apply")
  if (flags.has("effort") && !(REASONING_EFFORTS as readonly string[]).includes(String(flags.get("effort")))) return bad(`--effort must be one of ${REASONING_EFFORTS.join(", ")}`)
  if (flags.has("event")) { try { JSON.parse(String(flags.get("event"))) } catch { return bad("--event must be valid JSON") } }
  const mentions = flags.has("mentions") ? String(flags.get("mentions")).split(",").map((mention) => mention.trim()).filter(Boolean) : undefined
  if (mentions && (!mentions.length || mentions.length > 10 || mentions.some((mention) => mention.length > 100))) return bad("--mentions needs 1–10 mentions of at most 100 characters")
  return { ok: true, command: { ...common, kind: "github.run", publish: flags.has("publish"), ...(flags.has("review") ? { review: true } : {}), approve: flags.has("approve"), thinking: flags.has("thinking"), attachments: flags.has("attachments"), ...Object.fromEntries(["event", "token", "model", "variant", "effort", "prompt"].filter((key) => flags.has(key)).map((key) => [key, String(flags.get(key))])), ...(mentions ? { mentions } : {}) } }
}

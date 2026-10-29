#!/usr/bin/env bun
/**
 * Input tokens of the first model request, as the provider reports them (`usage.input_tokens` of the Responses API, cached and
 * cache-write tokens included), for the same short prompt through pi and through MendCode at each tier. Nothing is estimated.
 *
 *   bun .agents/evals/harness/first-request.ts --model gpt-6-luna --auth-from ~/.codex --out /tmp/mcfr-out [--repeat 2] [--targets pi,minimalist,balanced,full]
 *
 * Both run in the same empty git project with no AGENTS.md, no skills and no MCP, each from a clean state of its own:
 * - MendCode: the kit's adapter (dedicated data dir under /tmp, isolated HOME, the ChatGPT login linked read-only), at the tier asked
 *   for with that tier's prompt mode. The first `usage.recorded` event of `mendcode run --json` is the first request.
 * - pi: `PI_CODING_AGENT_DIR` and `HOME` point at a temp dir, never at ~/.pi. Its models catalog has no gpt-6-luna, so a models.json
 *   there adds it to the built-in `openai-codex` provider. Its auth.json holds the current access token with an empty refresh
 *   token, so pi can never refresh or rotate the real login; the temp dir is deleted at the end. The first `message_end` of an
 *   assistant message in `--mode json` carries that request's usage (input + cacheRead + cacheWrite = provider input_tokens).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createMendcodeAdapter } from "./adapters/mendcode"
import { readLines } from "./adapters/common"
import { intFlag, listFlag, parseArgs, rejectUnknown, requiredFlag } from "./lib/args"
import type { Task } from "./lib/types"

const PROMPT = "Reply with the single word ok. Do not use any tool."
const PI_BIN = path.join(homedir(), ".local/share/pi-stack/node_modules/.bin/pi")
const TARGETS = ["pi", "minimalist", "balanced", "full"] as const
type Target = (typeof TARGETS)[number]
type Measure = { target: Target; run: number; input: number | null; cacheRead: number | null; tools: number | null; note?: string }

const args = parseArgs(process.argv.slice(2))
rejectUnknown(args, ["model", "auth-from", "out", "repeat", "targets"])
const model = requiredFlag(args, "model")
const authFrom = path.resolve(requiredFlag(args, "auth-from").replace(/^~/, homedir()))
const outDir = path.resolve(requiredFlag(args, "out"))
const repeat = intFlag(args, "repeat", 1)
const targets = (listFlag(args, "targets") ?? [...TARGETS]) as Target[]
for (const target of targets) if (!TARGETS.includes(target)) throw new Error(`[FIRST]: unknown target ${target}`)
mkdirSync(outDir, { recursive: true })

// One project path for every run, so the working directory each prompt quotes has the same length.
const project = "/tmp/mcfr-project"
function freshProject() {
  rmSync(project, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(project, "README.md"), "# demo\n")
  spawnSync("git", ["init", "-q"], { cwd: project })
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=e", "add", "."], { cwd: project })
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=e", "commit", "-qm", "init"], { cwd: project })
}

async function mendcode(tier: Exclude<Target, "pi">, run: number): Promise<Measure> {
  freshProject()
  const runDir = path.join(outDir, tier, `r${run}`)
  mkdirSync(runDir, { recursive: true })
  const adapter = createMendcodeAdapter({ dataDir: "/tmp/mcfr-data", authFrom, tier })
  const task = { id: "first-request", prompt: PROMPT } as unknown as Task
  await adapter.prepare({ task, runDir, effort: "low", timeoutMs: 180_000 })
  try {
    const result = await adapter.run(PROMPT, project, model)
    const first = readLines(path.join(runDir, "transcript.jsonl")).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } }).find((event) => event.type === "usage.recorded")
    const num = (value: unknown) => (typeof value === "number" ? value : 0)
    if (!first) return { target: tier, run, input: null, cacheRead: null, tools: null, note: result.notes.join("; ") || "no usage.recorded" }
    return { target: tier, run, input: num(first.input) + num(first.cacheRead) + num(first.cacheWrite), cacheRead: num(first.cacheRead), tools: null }
  } finally {
    await adapter.cleanup()
  }
}

function accessToken() {
  const auth = JSON.parse(readFileSync(path.join(authFrom, "auth.json"), "utf8")) as { tokens?: { access_token?: string; account_id?: string } }
  const access = auth.tokens?.access_token
  const accountId = auth.tokens?.account_id
  if (!access || !accountId) throw new Error("[FIRST]: auth.json has no ChatGPT access token")
  const exp = (JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString()) as { exp: number }).exp * 1000
  if (exp - Date.now() < 10 * 60_000) throw new Error("[FIRST]: the ChatGPT access token expires within 10 minutes; open codex once to refresh it")
  return { access, accountId, expires: exp }
}

function pi(run: number): Measure {
  freshProject()
  const runDir = path.join(outDir, "pi", `r${run}`)
  mkdirSync(runDir, { recursive: true })
  const root = mkdtempSync(path.join(tmpdir(), "mcfr-pi-"))
  try {
    const agentDir = path.join(root, "agent")
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    const luna = { id: model, name: model, api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 128_000 }
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-codex": { models: [luna] } } }))
    writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", refresh: "", ...accessToken() } }), { mode: 0o600 })
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TERM: "dumb" }
    const flags = ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--provider", "openai-codex", "--model", model, "--thinking", "low", PROMPT]
    const result = spawnSync(PI_BIN, flags, { cwd: project, env, encoding: "utf8", timeout: 180_000 })
    writeFileSync(path.join(runDir, "transcript.jsonl"), result.stdout ?? "")
    writeFileSync(path.join(runDir, "stderr.log"), result.stderr ?? "")
    const events = (result.stdout ?? "").split("\n").flatMap((line) => { try { return [JSON.parse(line) as { type?: string; message?: { role?: string; usage?: Record<string, number>; errorMessage?: string } }] } catch { return [] } })
    const first = events.find((event) => event.type === "message_end" && event.message?.role === "assistant")
    const usage = first?.message?.usage
    if (!usage) return { target: "pi", run, input: null, cacheRead: null, tools: null, note: first?.message?.errorMessage ?? `exit ${result.status}; see ${runDir}` }
    return { target: "pi", run, input: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), cacheRead: usage.cacheRead ?? 0, tools: 4 }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const results: Measure[] = []
for (let run = 1; run <= repeat; run++) {
  for (const target of targets) {
    const measure = target === "pi" ? pi(run) : await mendcode(target, run)
    results.push(measure)
    console.log(`${target.padEnd(10)} r${run}  input ${measure.input ?? "?"}  (cached ${measure.cacheRead ?? "?"})${measure.note ? `  ${measure.note}` : ""}`)
  }
}
rmSync(project, { recursive: true, force: true })
writeFileSync(path.join(outDir, "first-request.json"), `${JSON.stringify({ model, prompt: PROMPT, at: new Date().toISOString(), results }, null, 2)}\n`)
console.log(`wrote ${path.join(outDir, "first-request.json")}`)

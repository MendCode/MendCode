import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect } from "effect"
import { TestLLMServer } from "../test/lib/llm-server"

const MODEL = "queue-smoke/test-model"
const CONTEXT_LIMIT = 50_000
const COMPACTION_LIMIT = 40_000
const PAYLOAD_CHARS = 90_000
const HOLD_MS = Number(process.env.MENDCODE_QUEUE_SMOKE_HOLD_MS ?? 20_000)
const packageRoot = path.resolve(import.meta.dir, "..")
const entrypoint = path.join(packageRoot, "src", "index.ts")
const lockIdentity =
  os.userInfo().uid >= 0 ? os.userInfo().uid : os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_")
const defaultLockPath = path.join(os.tmpdir(), `mendcode-queue-compaction-smoke-${lockIdentity}.lock`)

const sensitiveEnvironmentKeys = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENROUTER_API_KEY",
  "LLM_GATEWAY_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "MENDCODE_SERVER_PASSWORD",
  "MENDCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
]

type Fixture = {
  root: string
  project: string
  environment: NodeJS.ProcessEnv
}

type ChildResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

type SmokeLockOwner = {
  pid: number
  token: string
  startedAt: string
}

const activeChildren = new Set<ChildProcess>()
let activeFixtureRoot: string | undefined
let activeSmokeLock: Awaited<ReturnType<typeof acquireQueueCompactionSmokeLock>> | undefined
let shutdownExitCode: number | undefined

function errorHasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

function smokeLockOwner(lockPath: string) {
  return readFile(lockPath, "utf8")
    .then((value) => JSON.parse(value) as unknown)
    .then((value): SmokeLockOwner | undefined => {
      if (!value || typeof value !== "object") return
      if (
        !("pid" in value) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0
      ) return
      if (!("token" in value) || typeof value.token !== "string") return
      if (!("startedAt" in value) || typeof value.startedAt !== "string") return
      return { pid: value.pid, token: value.token, startedAt: value.startedAt }
    })
    .catch(() => undefined)
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorHasCode(error, "EPERM")
  }
}

export async function acquireQueueCompactionSmokeLock(lockPath = defaultLockPath, attempt = 0) {
  const owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }
  try {
    await writeFile(lockPath, JSON.stringify(owner) + "\n", { flag: "wx" })
  } catch (error) {
    if (!errorHasCode(error, "EEXIST")) throw error
    const current = await smokeLockOwner(lockPath)
    if (current && processIsRunning(current.pid)) {
      throw new Error(
        `the queue/compaction smoke is already running (PID ${current.pid}); use that terminal or stop it before starting another`,
      )
    }
    if (!current && attempt < 2) {
      await sleep(50)
      return acquireQueueCompactionSmokeLock(lockPath, attempt + 1)
    }
    if (attempt >= 4) throw new Error("could not acquire the queue/compaction smoke single-instance lock")
    await rm(lockPath, { force: true })
    return acquireQueueCompactionSmokeLock(lockPath, attempt + 1)
  }

  const release = async () => {
    if ((await smokeLockOwner(lockPath))?.token !== owner.token) return
    await rm(lockPath, { force: true })
  }
  const releaseSync = () => {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<SmokeLockOwner>
      if (current.token === owner.token) rmSync(lockPath, { force: true })
    } catch {
      return
    }
  }
  return { release, releaseSync }
}

function trackChild(child: ChildProcess) {
  activeChildren.add(child)
  const cleanup = () => activeChildren.delete(child)
  child.once("close", cleanup)
  child.once("error", cleanup)
  return cleanup
}

function terminateActiveChildren(signal: NodeJS.Signals = "SIGTERM") {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

function installChildCleanup() {
  process.once("exit", () => {
    terminateActiveChildren("SIGKILL")
    activeSmokeLock?.releaseSync()
    if (activeFixtureRoot) rmSync(activeFixtureRoot, { recursive: true, force: true })
  })
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.once(signal, () => {
      shutdownExitCode = exitCode
      terminateActiveChildren()
      process.exitCode = exitCode
      setTimeout(() => {
        terminateActiveChildren("SIGKILL")
        process.exit(exitCode)
      }, 1_000)
    })
  }
}

function syntheticPrompt(label: string) {
  const line = `${label}: synthetic compaction smoke content 0123456789 abcdefghijklmnopqrstuvwxyz\n`
  const body = line.repeat(Math.ceil(PAYLOAD_CHARS / line.length)).slice(0, PAYLOAD_CHARS)
  return `${label.toUpperCase()}_BEGIN\n${body}${label.toUpperCase()}_END\n`
}

function environment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_GLOBAL_LAYOUT: "mendcode",
    OPENCODE_DB: path.join(root, "state", "queue-smoke.db"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_SHARED_SERVER: "1",
    MENDCODE_DISABLE_SHARED_SERVER: "1",
    OPENCODE_DISABLE_SHARE: "true",
    OPENCODE_MODELS_PATH: path.join(packageRoot, "test", "tool", "fixtures", "models-api.json"),
  }

  for (const key of sensitiveEnvironmentKeys) delete env[key]
  return env
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mendcode-queue-compaction-"))
  const project = path.join(root, "project")
  await mkdir(project, { recursive: true })
  await mkdir(path.join(root, "home"), { recursive: true })
  return { root, project, environment: environment(root) }
}

function config(baseURL: string) {
  return {
    $schema: "https://mendcode.ai/config.json",
    enabled_providers: ["queue-smoke"],
    model: MODEL,
    small_model: MODEL,
    compaction: {
      auto: true,
      token_limit: COMPACTION_LIMIT,
    },
    provider: {
      "queue-smoke": {
        name: "Queue compaction smoke (local only)",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: {
          apiKey: "local-only",
          baseURL,
        },
        models: {
          "test-model": {
            id: "test-model",
            name: "Queue compaction smoke model",
            attachment: false,
            reasoning: false,
            tool_call: false,
            limit: { context: CONTEXT_LIMIT, output: 2_000 },
            compaction: { token_limit: COMPACTION_LIMIT },
          },
        },
      },
    },
    agent: {
      build: { model: MODEL },
      plan: { model: MODEL },
      title: { model: MODEL },
      summary: { model: MODEL },
      compaction: { model: MODEL },
      general: { model: MODEL },
    },
    share: "disabled",
    autoupdate: false,
  }
}

function childArgs(args: string[]) {
  return ["--cwd", packageRoot, "--no-install", "--conditions=browser", entrypoint, ...args]
}

function waitForChild(child: ChildProcess, input?: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""

    if (input !== undefined && child.stdin) child.stdin.end(input)
    child.stdout?.on("data", (value: Buffer) => (stdout += value.toString()))
    child.stderr?.on("data", (value: Buffer) => (stderr += value.toString()))
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function runCLI(args: string[], env: NodeJS.ProcessEnv, options?: { input?: string; inherit?: boolean }) {
  const child = spawn(process.execPath, childArgs(args), {
    cwd: packageRoot,
    env,
    stdio: options?.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  })
  const cleanup = trackChild(child)
  return waitForChild(child, options?.input).finally(cleanup)
}

function sessionID(output: string) {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as { kind?: string; sessionID?: unknown }
      if (value.kind === "result" && typeof value.sessionID === "string") return value.sessionID
    } catch {
      continue
    }
  }
  throw new Error("the seed command did not return a session id")
}

function requireSuccess(result: ChildResult, label: string) {
  if (result.code === 0) return
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(-2_000)
  throw new Error(`${label} exited with ${result.code ?? result.signal}\n${detail}`)
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("the queue/compaction smoke requires an interactive terminal")
  }

  const lock = await acquireQueueCompactionSmokeLock()
  activeSmokeLock = lock
  try {
    const test = await fixture()
    activeFixtureRoot = test.root
    process.env = test.environment

    const program = Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* Effect.promise(() =>
        writeFile(path.join(test.project, "mendcode.json"), JSON.stringify(config(llm.url), null, 2) + "\n"),
      )

      yield* llm.text("local seed response", { usage: { input: 25_000, output: 20 } })
      const seed = yield* Effect.promise(() =>
        runCLI(
          [
            "--pure",
            "run",
            "--format",
            "json",
            "--model",
            MODEL,
            "--title",
            "Queue compaction smoke",
            "--dir",
            test.project,
            "--dangerously-skip-permissions",
          ],
          test.environment,
          { input: syntheticPrompt("seed") },
        ),
      )
      requireSuccess(seed, "seed session")
      const id = sessionID(seed.stdout)

      const previousCalls = yield* llm.calls
      const release = Effect.runPromise(llm.wait(previousCalls + 1)).then(() => sleep(HOLD_MS))
      yield* llm.hold("local compaction summary", release)
      process.stderr.write(
        [
          "",
          "MendCode queue/compaction smoke is ready (the provider is local and never calls an API).",
          `Model context limit: ${CONTEXT_LIMIT.toLocaleString()} tokens; auto-compaction: ${COMPACTION_LIMIT.toLocaleString()} tokens.`,
          "The TUI opens with a synthetic trigger prompt already loaded.",
          "Press Enter to submit it, press Esc once to arm interruption, then press Esc again within five seconds to cancel it.",
          `The local model holds that request for ${Math.round(HOLD_MS / 1_000)} seconds so the queued state is visible.`,
          "Only one smoke can run at a time. Exit with /exit or Ctrl+C; child processes and the lock are cleaned automatically.",
          "Expected result: the second Esc issues one cancellation; the compaction summary terminates once, Snake disappears, the panel collapses, and queued messages remain paired with their queued/send state.",
          "",
        ].join("\n"),
      )

      const tui = yield* Effect.promise(() =>
        runCLI(
          [
            "--pure",
            "--isolated",
            "--model",
            MODEL,
            "--session",
            id,
            "--initial-message",
            syntheticPrompt("trigger"),
            test.project,
          ],
          test.environment,
          { inherit: true },
        ),
      )
      requireSuccess(tui, "TUI")

      const inputs = yield* llm.inputs
      process.stderr.write(`\nLocal mock requests observed: ${inputs.length}. No external provider was contacted.\n`)
    })

    try {
      await Effect.runPromise(program.pipe(Effect.provide(TestLLMServer.layer), Effect.scoped))
    } finally {
      await rm(test.root, { recursive: true, force: true })
      activeFixtureRoot = undefined
    }
  } finally {
    await lock.release()
    if (activeSmokeLock === lock) activeSmokeLock = undefined
  }
}

if (import.meta.main) {
  installChildCleanup()
  await main().catch((error) => {
    if (shutdownExitCode !== undefined) return
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

const activeChildren = new Set<ChildProcess>()

function trackChild(child: ChildProcess) {
  activeChildren.add(child)
  const cleanup = () => activeChildren.delete(child)
  child.once("close", cleanup)
  child.once("error", cleanup)
  return cleanup
}

function terminateActiveChildren() {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
}

function installChildCleanup() {
  process.once("exit", terminateActiveChildren)
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.once(signal, () => {
      terminateActiveChildren()
      process.exitCode = exitCode
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

  const test = await fixture()
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
        "Press Enter to submit it, then submit two short prompts while compaction is active.",
        `The local model holds that request for ${Math.round(HOLD_MS / 1_000)} seconds so the queued state is visible.`,
        "Expected result: queued messages remain paired with their queued/send state after compaction, not ordinary transcript rows.",
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
  }
}

installChildCleanup()
await main()

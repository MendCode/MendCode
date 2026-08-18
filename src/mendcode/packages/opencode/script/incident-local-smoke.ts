import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const STEP_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 12_000

const groups = [
  {
    name: "TUI render and terminal state",
    tests: [
      "test/cli/tui/markdown-render.test.ts",
      "test/cli/tui/agent-view.test.ts",
      "test/cli/tui/route.test.ts",
      "test/cli/tui/session-initialization.test.ts",
      "test/cli/tui/session-layout.test.ts",
      "test/cli/tui/session-working.test.ts",
      "test/cli/tui/session-exit-summary.test.ts",
      "test/cli/tui/workflow-view.test.ts",
      "test/mend/tui-presentation-renderers.test.ts",
      "test/pty/pty-output-isolation.test.ts",
      "test/pty/pty-session.test.ts",
    ],
  },
  {
    name: "shared server and reconnect contracts",
    tests: [
      // The full sync component suite requires the production provider tree;
      // these standalone contracts exercise the same reconnect/outbox paths.
      "test/cli/tui/shared-server.test.ts",
      "test/cli/tui/session-control.test.ts",
      "test/cli/tui/permission-sync.test.ts",
      "test/cli/cmd/serve.test.ts",
    ],
  },
  {
    name: "server listener and instance isolation",
    tests: [
      "test/control-plane/adapters.test.ts",
      // httpapi-instance-context.test.ts currently has a pre-existing
      // InstanceLayer bootstrap cycle when run as an isolated Bun file.
      "test/server/httpapi-listen.test.ts",
      "test/server/httpapi-workspace-routing.test.ts",
    ],
  },
  {
    name: "persisted database and session state",
    tests: [
      "test/storage/resolve-default-sqlite-path.test.ts",
      "test/session/session.test.ts",
      "test/session/workflow-persistence.test.ts",
    ],
  },
  {
    name: "dev and installed entrypoints",
    tests: ["test/cli/public-bin-worktree.test.ts", "test/installation/installation.test.ts"],
  },
  {
    name: "workflow and subagent state",
    tests: [
      "test/session/agent-command.test.ts",
      "test/session/workflow-scheduler.test.ts",
      "test/session/workflow-task-executor.test.ts",
      "test/session/loop.test.ts",
      "test/tool/loop.test.ts",
      "test/mend/loop-service.test.ts",
      "test/server/workflow-routes.test.ts",
      "test/tool/task.test.ts",
    ],
  },
  {
    name: "session API parity",
    tests: ["test/server/httpapi-session.test.ts", "test/server/httpapi-json-parity.test.ts"],
  },
] as const

const providerKeys = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
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
]

function noAIEnvironment() {
  const env = { ...process.env }
  for (const key of providerKeys) delete env[key]
  for (const key of [
    "MENDCODE_DB",
    "OPENCODE_DB",
    "MENDCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_DIR",
    "MENDCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_CONTENT",
    "MENDCODE_MODELS_PATH",
    "OPENCODE_MODELS_PATH",
    "MENDCODE_SERVER_URL",
    "OPENCODE_SERVER_URL",
    "MENDCODE_SHARED_SERVER_STATE_FILE",
    "MENDCODE_SHARED_SERVER_RUNTIME_ID",
  ]) {
    delete env[key]
  }

  Object.assign(env, {
    MENDCODE_NO_AI: "1",
    OPENCODE_NO_AI: "1",
    MENDCODE_PURE: "1",
    OPENCODE_PURE: "1",
    MENDCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    MENDCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    MENDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    NO_COLOR: "1",
    OTEL_SDK_DISABLED: "true",
  })
  return env
}

function appendOutput(current: string, chunk: unknown) {
  const next = current + String(chunk)
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next
}

type CommandResult = {
  code: number
  output: string
  timedOut: boolean
}

function runCommand(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args], {
      cwd: PACKAGE_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    let output = ""
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const terminate = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall through when the child has already exited.
        }
      }
      child.kill(signal)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate("SIGTERM")
      killTimer = setTimeout(() => terminate("SIGKILL"), 5_000)
      killTimer.unref?.()
    }, STEP_TIMEOUT_MS)
    timer.unref?.()

    const append = (chunk: unknown) => {
      output = appendOutput(output, chunk)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    const finish = (code: number) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, output, timedOut })
    }
    child.once("error", (error) => {
      append(error)
      finish(1)
    })
    child.once("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)))
  })
}

async function runStep(label: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  console.log(`RUN ${label}`)
  const result = await runCommand(args, env)
  if (result.code === 0) {
    console.log(`PASS ${label}`)
    return true
  }

  const reason = result.timedOut ? `timed out after ${STEP_TIMEOUT_MS}ms` : `exit ${result.code}`
  console.error(`FAIL ${label}: ${reason}`)
  if (result.output) console.error(result.output)
  return false
}

function printManual() {
  const source = path.join(PACKAGE_ROOT, "src", "index.ts")
  const models = path.join(PACKAGE_ROOT, "test", "tool", "fixtures", "models-api.json")
  console.log(`Manual two-terminal reconnect lab (no prompt/model request):

Terminal A — create one isolated server and the first TUI client:

LAB=$(mktemp -d "\${TMPDIR:-/tmp}/mendcode-reconnect.XXXXXX")
mkdir -p "$LAB"/{home,project,db,xdg-config,xdg-data,xdg-state,xdg-cache}
PORT=$(bun -e 'const s=Bun.serve({port:0,fetch(){return new Response()}}); console.log(s.port); s.stop()')
echo "$PORT" > "$LAB/port"
echo "LAB=$LAB"
export MENDCODE_LAB="$LAB" MENDCODE_PACKAGE_ROOT="${PACKAGE_ROOT}" MENDCODE_PORT="$PORT"
export HOME="$LAB/home" XDG_CONFIG_HOME="$LAB/xdg-config" XDG_DATA_HOME="$LAB/xdg-data" XDG_STATE_HOME="$LAB/xdg-state" XDG_CACHE_HOME="$LAB/xdg-cache"
export MENDCODE_GLOBAL_LAYOUT=mendcode OPENCODE_GLOBAL_LAYOUT=mendcode
export MENDCODE_DB="$LAB/db/mendcode-local.db" OPENCODE_DB="$LAB/db/mendcode-local.db"
export MENDCODE_MODELS_PATH="${models}" OPENCODE_MODELS_PATH="${models}"
export MENDCODE_CONFIG_CONTENT='{"formatter":false,"lsp":false,"enabled_providers":[]}' OPENCODE_CONFIG_CONTENT="$MENDCODE_CONFIG_CONTENT"
export MENDCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 MENDCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_MODELS_FETCH=1 MENDCODE_PURE=1 OPENCODE_PURE=1 NO_COLOR=1
unset MENDCODE_SERVER_URL OPENCODE_SERVER_URL MENDCODE_SHARED_SERVER_STATE_FILE MENDCODE_SHARED_SERVER_RUNTIME_ID
unset ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
(bun --cwd "$MENDCODE_PACKAGE_ROOT" --no-install --conditions=browser "$MENDCODE_PACKAGE_ROOT/src/index.ts" serve --hostname 127.0.0.1 --port "$PORT" >"$LAB/server.log" 2>&1 & echo $! >"$LAB/server.pid")
sleep 1
bun --cwd "$MENDCODE_PACKAGE_ROOT" --no-install --conditions=browser "${source}" "$LAB/project" --server-url "http://127.0.0.1:$PORT"

Terminal B — use the same explicit server, never auto-start a competing shared server:

LAB=/path/printed/by/Terminal-A
MENDCODE_PACKAGE_ROOT="${PACKAGE_ROOT}"
PORT=$(<"$LAB/port")
export HOME="$LAB/home" XDG_CONFIG_HOME="$LAB/xdg-config" XDG_DATA_HOME="$LAB/xdg-data" XDG_STATE_HOME="$LAB/xdg-state" XDG_CACHE_HOME="$LAB/xdg-cache"
export MENDCODE_GLOBAL_LAYOUT=mendcode OPENCODE_GLOBAL_LAYOUT=mendcode
export MENDCODE_DB="$LAB/db/mendcode-local.db" OPENCODE_DB="$LAB/db/mendcode-local.db"
export MENDCODE_MODELS_PATH="${models}" OPENCODE_MODELS_PATH="${models}"
export MENDCODE_CONFIG_CONTENT='{"formatter":false,"lsp":false,"enabled_providers":[]}' OPENCODE_CONFIG_CONTENT="$MENDCODE_CONFIG_CONTENT"
export MENDCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 MENDCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_MODELS_FETCH=1 MENDCODE_PURE=1 OPENCODE_PURE=1 NO_COLOR=1
unset MENDCODE_SERVER_URL OPENCODE_SERVER_URL MENDCODE_SHARED_SERVER_STATE_FILE MENDCODE_SHARED_SERVER_RUNTIME_ID
unset ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
bun --cwd "$MENDCODE_PACKAGE_ROOT" --no-install --conditions=browser "${source}" "$LAB/project" --server-url "http://127.0.0.1:$PORT"

With both clients open, capture durable state, then kill only the lab server and observe both clients enter reconnecting, not Generating:

BASE="http://127.0.0.1:$PORT"
curl -fsS -H "x-mendcode-directory:$LAB/project" "$BASE/workflow" >"$LAB/workflows.before.json"
cd "$LAB/project"
bun --cwd "$MENDCODE_PACKAGE_ROOT" --no-install --conditions=browser "${source}" loops status --json >"$LAB/loops.before.json"

kill "$(<"$LAB/server.pid")"

Restart the exact server command from Terminal A, then verify both clients recover the same session list and parent/subagent navigation. Do not submit a prompt; this lab has no provider credentials and no AI request path.

Durable workflow/loop check from a spare shell (before and after the restart):

BASE="http://127.0.0.1:$PORT"
curl -fsS -H "x-mendcode-directory:$LAB/project" "$BASE/workflow" >"$LAB/workflows.after.json"
cd "$LAB/project"
bun --cwd "$MENDCODE_PACKAGE_ROOT" --no-install --conditions=browser "${source}" loops status --json >"$LAB/loops.after.json"

The JSON must still contain the same queued/working workflow runs and active/sleeping loops, with an overdue loop reported as due/catch_up on the first daemon tick. Compare the files captured before the kill with the files captured after the restart; a transient network outage must not turn them into an empty list or create a second server.
`)
}

async function main() {
  const args = new Set(process.argv.slice(2))
  if (args.has("--help") || args.has("-h")) {
    console.log("Usage: bun run script/incident-local-smoke.ts [--contracts-only|--runtime-only|--require-installed|--manual]")
    return
  }
  if (args.has("--manual")) {
    printManual()
    return
  }

  const env = noAIEnvironment()
  const failures: string[] = []
  if (!args.has("--runtime-only")) {
    for (const group of groups) {
      const ok = await runStep(
        group.name,
        ["test", "--timeout", "30000", ...group.tests],
        env,
      )
      if (!ok) failures.push(group.name)
    }
  }

  if (!args.has("--contracts-only")) {
    const runtimeArgs = ["run", "script/session-runtime-smoke.ts"]
    if (args.has("--require-installed")) runtimeArgs.push("--require-installed")
    const ok = await runStep("isolated subprocess runtime smoke", runtimeArgs, env)
    if (!ok) failures.push("isolated subprocess runtime smoke")
  }

  if (failures.length > 0) {
    console.error(`\nIncident-local smoke failed: ${failures.join(", ")}`)
    process.exitCode = 1
    return
  }

  console.log("\nPASS incident-local smoke: no provider credentials or model requests were enabled")
  console.log("Manual-only: actual PTY rendering/reconnect perception after killing the server; use --manual")
}

await main()

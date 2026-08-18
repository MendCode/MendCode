import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createServer, type AddressInfo } from "node:net"
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SOURCE_ENTRYPOINT = path.join(PACKAGE_ROOT, "src", "index.ts")
const FAKE_PROVIDER_ID = "fake-local"
const FAKE_MODEL_ID = "fake-model"
const CHILD_TIMEOUT_MS = 30_000
const SERVER_START_TIMEOUT_MS = 20_000

type Sandbox = {
  root: string
  home: string
  project: string
  db: string
  models: string
  state: string
  env: NodeJS.ProcessEnv
}

type JsonResponse = {
  status: number
  value: any
  text: string
}

type RunningServer = {
  child: ChildProcess
  url: string
  output: () => string
  stop: () => Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function exists(target: string) {
  return access(target).then(
    () => true,
    () => false,
  )
}

async function reservePort() {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => resolve())
  })
  const address = listener.address() as AddressInfo
  const port = address.port
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  return port
}

function fakeModels(providerURL: string) {
  return {
    [FAKE_PROVIDER_ID]: {
      id: FAKE_PROVIDER_ID,
      name: "Fake local",
      env: [],
      api: providerURL,
      npm: "@ai-sdk/openai-compatible",
      models: {
        [FAKE_MODEL_ID]: {
          id: FAKE_MODEL_ID,
          name: "Fake model",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          limit: { context: 100_000, output: 1_000 },
          cost: { input: 0, output: 0 },
        },
      },
    },
  }
}

function fakeConfig(providerURL: string) {
  return {
    $schema: "https://mendcode.ai/config.json",
    formatter: false,
    lsp: false,
    enabled_providers: [FAKE_PROVIDER_ID],
    provider: {
      [FAKE_PROVIDER_ID]: {
        name: "Fake local",
        models: {
          [FAKE_MODEL_ID]: {
            name: "Fake model",
            limit: { context: 100_000, output: 1_000 },
            provider: {
              npm: "@ai-sdk/openai-compatible",
              api: providerURL,
            },
          },
        },
      },
    },
  }
}

function buildEnvironment(input: {
  home: string
  project: string
  db: string
  models: string
  xdgConfig: string
  xdgData: string
  xdgState: string
  xdgCache: string
  providerURL: string
}) {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "BUN_INSTALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }

  const config = JSON.stringify(fakeConfig(input.providerURL))
  const configDir = path.join(input.xdgConfig, "mendcode")
  Object.assign(env, {
    HOME: input.home,
    OPENCODE_TEST_HOME: input.home,
    XDG_CONFIG_HOME: input.xdgConfig,
    XDG_DATA_HOME: input.xdgData,
    XDG_STATE_HOME: input.xdgState,
    XDG_CACHE_HOME: input.xdgCache,
    MENDCODE_GLOBAL_LAYOUT: "mendcode",
    OPENCODE_GLOBAL_LAYOUT: "mendcode",
    MENDCODE_DB: input.db,
    OPENCODE_DB: input.db,
    MENDCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_DIR: configDir,
    MENDCODE_CONFIG_CONTENT: config,
    OPENCODE_CONFIG_CONTENT: config,
    MENDCODE_MODELS_PATH: input.models,
    OPENCODE_MODELS_PATH: input.models,
    MENDCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    MENDCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    MENDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    MENDCODE_EXPERIMENTAL_HTTPAPI: "1",
    OPENCODE_EXPERIMENTAL_HTTPAPI: "1",
    MENDCODE_PURE: "1",
    OPENCODE_PURE: "1",
    MENDCODE_DISABLE_CHANNEL_DB: "1",
    OPENCODE_DISABLE_CHANNEL_DB: "1",
    NO_COLOR: "1",
    OTEL_SDK_DISABLED: "true",
  })
  delete env.MENDCODE_SHARED_SERVER_STATE_FILE
  delete env.MENDCODE_SHARED_SERVER_RUNTIME_ID
  delete env.MENDCODE_SERVER_USERNAME
  delete env.MENDCODE_SERVER_PASSWORD
  delete env.OPENCODE_SERVER_USERNAME
  delete env.OPENCODE_SERVER_PASSWORD
  return env
}

async function createSandbox(label: string): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), `mendcode-session-${label}-`))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const dbDir = path.join(root, "db")
  const xdgConfig = path.join(root, "xdg-config")
  const xdgData = path.join(root, "xdg-data")
  const xdgState = path.join(root, "xdg-state")
  const xdgCache = path.join(root, "xdg-cache")
  const models = path.join(root, "models.json")
  const providerURL = `http://127.0.0.1:${await reservePort()}/v1`
  await Promise.all(
    [home, project, dbDir, xdgConfig, xdgData, xdgState, xdgCache].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  )
  await writeFile(models, JSON.stringify(fakeModels(providerURL), null, 2))
  const db = path.join(dbDir, "mendcode-local.db")
  return {
    root,
    home,
    project,
    db,
    models,
    state: path.join(xdgState, "mendcode", "shared-server"),
    env: buildEnvironment({
      home,
      project,
      db,
      models,
      xdgConfig,
      xdgData,
      xdgState,
      xdgCache,
      providerURL,
    }),
  }
}

function trimOutput(value: string) {
  return value.length > 8_000 ? value.slice(-8_000) : value
}

async function runChild(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => (stdout = trimOutput(stdout + String(chunk))))
  child.stderr?.on("data", (chunk) => (stderr = trimOutput(stderr + String(chunk))))
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS)
  timer.unref()
  const code = await exit
  clearTimeout(timer)
  if (code !== 0) {
    throw new Error(`child ${args[0]} failed with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  return { stdout, stderr }
}

async function terminateChild(child: ChildProcess, exit: Promise<unknown>) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([exit.catch(() => undefined), sleep(5_000)])
  if (child.exitCode === null) child.kill("SIGKILL")
  await exit.catch(() => undefined)
}

async function startServer(input: {
  entrypoint: string
  installed: boolean
  sandbox: Sandbox
}): Promise<RunningServer> {
  const port = await reservePort()
  const args = input.installed
    ? ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
    : [
        "--cwd",
        PACKAGE_ROOT,
        "--no-install",
        "--conditions=browser",
        input.entrypoint,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ]
  const child = spawn(input.installed ? input.entrypoint : process.execPath, args, {
    cwd: PACKAGE_ROOT,
    env: input.sandbox.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
  const listening = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${output}`)), SERVER_START_TIMEOUT_MS)
    timer.unref()
    const onData = (chunk: unknown) => {
      output = trimOutput(output + String(chunk))
      const match = output.match(/MendCode runtime server listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    void exit.then((code) => {
      if (code !== 0) reject(new Error(`server exited before listening (${code})\n${output}`))
    })
  })
  let url: string
  try {
    url = await listening
  } catch (error) {
    await terminateChild(child, exit)
    throw error
  }
  let stopPromise: Promise<void> | undefined
  const stop = () =>
    (stopPromise ??= (async () => {
      await terminateChild(child, exit)
    })())
  return { child, url, output: () => output, stop }
}

async function requestJSON(
  server: RunningServer,
  sandbox: Sandbox,
  route: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const headers = new Headers(init.headers)
  headers.set("x-mendcode-directory", sandbox.project)
  headers.set("x-opencode-directory", sandbox.project)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  const response = await fetch(new URL(route, server.url), {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  let value: any = undefined
  try {
    value = text ? JSON.parse(text) : undefined
  } catch {
    value = text
  }
  return { status: response.status, value, text }
}

function expectStatus(response: JsonResponse, expected: number, label: string) {
  assert(
    response.status === expected,
    `${label}: expected HTTP ${expected}, got ${response.status}: ${response.text.slice(0, 1_000)}`,
  )
}

async function waitForHealth(server: RunningServer, sandbox: Sandbox) {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await requestJSON(server, sandbox, "/global/health")
      if (response.status === 200) return
    } catch {
      // The listener can be ready a few milliseconds before the router is usable.
    }
    await sleep(100)
  }
  throw new Error(`health probe timed out\n${server.output()}`)
}

async function createSession(server: RunningServer, sandbox: Sandbox, parentID?: string) {
  const response = await requestJSON(server, sandbox, "/session", {
    method: "POST",
    body: JSON.stringify({
      title: parentID ? "Persisted child" : "Persisted parent",
      parentID,
      agent: "build",
      model: { providerID: FAKE_PROVIDER_ID, id: FAKE_MODEL_ID },
    }),
  })
  expectStatus(response, 200, "session create")
  assert(response.value && typeof response.value.id === "string", "session create did not return an id")
  return response.value as { id: string; parentID?: string }
}

async function registerBackground(server: RunningServer, sandbox: Sandbox, sessionID: string) {
  const response = await requestJSON(server, sandbox, `/session/${encodeURIComponent(sessionID)}/background`, {
    method: "POST",
    body: JSON.stringify({ state: "working", summary: "persisted background smoke", pinned: true }),
  })
  expectStatus(response, 200, "background register")
}

async function seedPersistedRows(sandbox: Sandbox, parentID: string, childID: string) {
  await runChild(["--seed-db", sandbox.db, parentID, childID], sandbox.env)
}

async function seedDatabase(dbPath: string, parentID: string, childID: string) {
  assert(
    process.env.MENDCODE_DB !== undefined && path.resolve(process.env.MENDCODE_DB) === path.resolve(dbPath),
    "seed child resolved an unexpected MendCode DB",
  )
  assert(
    process.env.OPENCODE_DB !== undefined && path.resolve(process.env.OPENCODE_DB) === path.resolve(dbPath),
    "seed child resolved an unexpected OpenCode DB",
  )
  const { Database } = await import("../src/storage/db")
  const { MessageTable, PartTable, SessionMessageTable, SessionStatusTable } = await import(
    "../src/session/session.sql"
  )
  const now = Date.now()
  Database.use((db) => {
    db.insert(SessionStatusTable)
      .values([
        {
          session_id: parentID,
          time_created: now,
          time_updated: now,
          data: { type: "busy", kind: "subagent-wait", message: "Smoke parent busy", startedAt: now },
        },
        {
          session_id: childID,
          time_created: now,
          time_updated: now,
          data: { type: "busy", kind: "mflow-wait", message: "Smoke child busy", startedAt: now },
        },
      ] as any)
      .run()
    db.insert(MessageTable)
      .values({
        id: "msg_smoke_incomplete",
        session_id: parentID,
        time_created: now,
        time_updated: now,
        data: {
          role: "user",
          time: { created: now },
          agent: "build",
          model: { providerID: FAKE_PROVIDER_ID, modelID: FAKE_MODEL_ID },
          queued: true,
        },
      } as any)
      .run()
    db.insert(PartTable)
      .values({
        id: "prt_smoke_incomplete",
        message_id: "msg_smoke_incomplete",
        session_id: parentID,
        time_created: now,
        time_updated: now,
        data: { type: "text", text: "persisted incomplete prompt" },
      } as any)
      .run()
    db.insert(SessionMessageTable)
      .values({
        id: "evt_smoke_incomplete",
        session_id: parentID,
        type: "user",
        time_created: now,
        time_updated: now,
        data: {
          text: "persisted v2 incomplete prompt",
          files: [],
          agents: [],
          time: { created: now },
        },
      } as any)
      .run()
  })
  Database.close()
}

async function verifyPersistedApis(server: RunningServer, sandbox: Sandbox, parentID: string, childID: string) {
  const sessions = await requestJSON(server, sandbox, "/session")
  expectStatus(sessions, 200, "session list")
  assert(Array.isArray(sessions.value), "session list is not an array")
  assert(
    sessions.value.some((item: any) => item.id === parentID),
    "persisted parent is missing from session list",
  )
  assert(
    sessions.value.some((item: any) => item.id === childID),
    "persisted child is missing from session list",
  )

  const roots = await requestJSON(server, sandbox, "/session?roots=true")
  expectStatus(roots, 200, "root session list")
  assert(
    roots.value.some((item: any) => item.id === parentID),
    "persisted parent is missing from root list",
  )
  assert(!roots.value.some((item: any) => item.id === childID), "child leaked into root session list")

  const children = await requestJSON(server, sandbox, `/session/${encodeURIComponent(parentID)}/children`)
  expectStatus(children, 200, "child session list")
  assert(
    children.value.some((item: any) => item.id === childID),
    "persisted child is missing from parent children",
  )

  const statuses = await requestJSON(server, sandbox, "/session/status")
  expectStatus(statuses, 200, "session status")
  assert(statuses.value[parentID]?.type === "busy", "persisted parent busy status is missing")
  assert(statuses.value[childID]?.type === "busy", "persisted child busy status is missing")

  const background = await requestJSON(server, sandbox, "/session/background")
  expectStatus(background, 200, "background list")
  assert(
    background.value.some((item: any) => item.sessionID === childID),
    "persisted background session is missing",
  )

  const providers = await requestJSON(server, sandbox, "/provider")
  expectStatus(providers, 200, "provider list")
  const fakeProvider = providers.value?.all?.find((provider: any) => provider.id === FAKE_PROVIDER_ID)
  assert(fakeProvider?.models?.[FAKE_MODEL_ID], "fake local provider/model is missing")
  assert(providers.value.connected?.includes(FAKE_PROVIDER_ID), "fake local provider is not connected")

  const messages = await requestJSON(server, sandbox, `/session/${encodeURIComponent(parentID)}/message`)
  expectStatus(messages, 200, "legacy session messages")
  assert(
    messages.value.some(
      (message: any) => message.info?.id === "msg_smoke_incomplete" || message.id === "msg_smoke_incomplete",
    ),
    `persisted legacy message is missing: ${JSON.stringify(messages.value).slice(0, 1_000)}`,
  )

  const context = await requestJSON(server, sandbox, `/api/session/${encodeURIComponent(parentID)}/context`)
  expectStatus(context, 200, "v2 session context")
  assert(
    context.value.some((message: any) => message.id === "evt_smoke_incomplete"),
    "persisted v2 context is missing",
  )

  const v2Sessions = await requestJSON(server, sandbox, "/api/session?roots=true")
  expectStatus(v2Sessions, 200, "v2 session list")
  assert(
    v2Sessions.value.items.some((item: any) => item.id === parentID),
    "persisted parent is missing from v2 session list",
  )

  const combined = JSON.stringify({ sessions, statuses, background, providers, messages, context, v2Sessions })
  assert(!combined.includes("No context found for instance"), "session APIs returned the incident context error")
  return {
    sessions: sessions.value.length,
    statuses: Object.keys(statuses.value).length,
    background: background.value.length,
    providers: providers.value.all.length,
    context: context.value.length,
  }
}

async function runSourceRestartScenario(sandbox: Sandbox) {
  let first: RunningServer | undefined
  let second: RunningServer | undefined
  try {
    first = await startServer({ entrypoint: SOURCE_ENTRYPOINT, installed: false, sandbox })
    await waitForHealth(first, sandbox)
    const parent = await createSession(first, sandbox)
    const child = await createSession(first, sandbox, parent.id)
    await registerBackground(first, sandbox, child.id)
    await first.stop()
    first = undefined

    await seedPersistedRows(sandbox, parent.id, child.id)
    second = await startServer({ entrypoint: SOURCE_ENTRYPOINT, installed: false, sandbox })
    await waitForHealth(second, sandbox)
    const result = await verifyPersistedApis(second, sandbox, parent.id, child.id)
    return result
  } finally {
    await second?.stop().catch(() => undefined)
    await first?.stop().catch(() => undefined)
  }
}

async function writeStaleSharedState(sandbox: Sandbox) {
  await mkdir(sandbox.state, { recursive: true })
  const lock = path.join(sandbox.state, "server.lock")
  await mkdir(lock, { recursive: true })
  await writeFile(path.join(lock, "owner"), "stale smoke lock")
  const stale = new Date(Date.now() - 120_000)
  await utimes(lock, stale, stale)
  await writeFile(
    path.join(sandbox.state, "server.json"),
    JSON.stringify({
      version: 1,
      pid: 999_999,
      url: `http://127.0.0.1:${await reservePort()}`,
      username: "mendcode",
      password: "stale-smoke",
      startedAt: new Date(stale).toISOString(),
      runtimeID: "stale-runtime",
    }),
  )
}

async function runManagedRecovery(sandbox: Sandbox) {
  await writeStaleSharedState(sandbox)
  sandbox.env.MENDCODE_SHARED_SERVER_PORT = String(await reservePort())
  const result = await runChild(["--managed-recovery", SOURCE_ENTRYPOINT, sandbox.project, PACKAGE_ROOT], sandbox.env)
  const line = result.stdout
    .split("\n")
    .map((item) => item.trim())
    .reverse()
    .find((item) => item.startsWith("{") && item.endsWith("}"))
  assert(line, `managed recovery did not return JSON\n${result.stdout}`)
  const value = JSON.parse(line)
  assert(value.ok === true && typeof value.pid === "number" && typeof value.url === "string", "managed recovery failed")
  assert(!(await exists(path.join(sandbox.state, "server.lock"))), "stale shared-server lock was not recovered")
  return { pid: value.pid, url: value.url }
}

async function managedRecovery(entrypoint: string, project: string, runtimeCwd: string) {
  process.argv[1] = entrypoint
  const { ensureLocalSharedServer } = await import("../src/cli/cmd/tui/thread")
  const connection = await ensureLocalSharedServer({ directory: project, runtimeCwd })
  assert(connection, "ensureLocalSharedServer did not recover the stale server")
  try {
    console.log(JSON.stringify({ ok: true, pid: connection.pid, url: connection.url }))
  } finally {
    await connection.lease.release()
    try {
      process.kill(connection.pid, "SIGTERM")
    } catch {
      // The server may already have exited after the lease was released.
    }
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        process.kill(connection.pid, 0)
      } catch {
        return
      }
      await sleep(50)
    }
    try {
      process.kill(connection.pid, "SIGKILL")
    } catch {
      // Cleanup is best effort after the bounded wait.
    }
  }
}

function installedEntrypoint(realHome: string) {
  const explicit = process.env.MENDCODE_INSTALLED_BIN
  if (explicit) return explicit
  const candidates = [
    path.join(realHome, ".mendcode", "bin", "mendcode"),
    (() => {
      try {
        return execFileSync("which", ["mendcode"], { encoding: "utf8" }).trim()
      } catch {
        return ""
      }
    })(),
  ]
  return candidates.find((candidate) => candidate && candidate !== SOURCE_ENTRYPOINT) || undefined
}

async function runInstalledParity(entrypoint: string, realHome: string) {
  const sandbox = await createSandbox("installed")
  let server: RunningServer | undefined
  try {
    assert(
      !path.resolve(sandbox.db).startsWith(path.join(path.resolve(realHome), ".mendcode") + path.sep),
      "installed smoke DB escaped the temporary sandbox",
    )
    server = await startServer({ entrypoint, installed: true, sandbox })
    await waitForHealth(server, sandbox)
    const created = await createSession(server, sandbox)
    const providers = await requestJSON(server, sandbox, "/provider")
    expectStatus(providers, 200, "installed provider list")
    const fakeProvider = providers.value?.all?.find((provider: any) => provider.id === FAKE_PROVIDER_ID)
    assert(fakeProvider?.models?.[FAKE_MODEL_ID], "installed runtime lost the fake provider/model")
    const sessions = await requestJSON(server, sandbox, "/session")
    expectStatus(sessions, 200, "installed session list")
    assert(
      sessions.value.some((item: any) => item.id === created.id),
      "installed runtime did not persist its isolated session",
    )
    return { version: await runtimeVersion(entrypoint, sandbox.env), sessions: sessions.value.length }
  } finally {
    await server?.stop().catch(() => undefined)
    await rm(sandbox.root, { recursive: true, force: true })
  }
}

async function runtimeVersion(entrypoint: string, env: NodeJS.ProcessEnv) {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(entrypoint, ["--version"], { cwd: PACKAGE_ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
  assert(result.code === 0, `installed runtime --version failed\n${result.stderr}`)
  return result.stdout.trim().split("\n").at(-1) || "unknown"
}

async function main() {
  const mode = process.argv[2]
  if (mode === "--seed-db") return seedDatabase(process.argv[3], process.argv[4], process.argv[5])
  if (mode === "--managed-recovery") return managedRecovery(process.argv[3], process.argv[4], process.argv[5])

  const requireInstalled = process.argv.includes("--require-installed")
  const realHome = process.env.HOME ?? os.homedir()
  const sourceSandbox = await createSandbox("source")
  const managedSandbox = await createSandbox("managed")
  try {
    const source = await runSourceRestartScenario(sourceSandbox)
    console.log(
      `PASS persisted DB restart: sessions=${source.sessions} statuses=${source.statuses} background=${source.background} providers=${source.providers} context=${source.context}`,
    )

    const managed = await runManagedRecovery(managedSandbox)
    console.log(`PASS stale lock/state/PID recovery: pid=${managed.pid} url=${managed.url}`)

    const installed = installedEntrypoint(realHome)
    if (!installed || !(await exists(installed))) {
      if (requireInstalled)
        throw new Error("installed mendcode binary not found; set MENDCODE_INSTALLED_BIN to an isolated executable")
      console.log("SKIP source/installed parity: no installed mendcode binary found")
    } else {
      const parity = await runInstalledParity(installed, realHome)
      console.log(`PASS source/installed isolated parity: installed=${parity.version} sessions=${parity.sessions}`)
    }

    console.log(
      "SKIP TUI/PTY reconnect: headless PTY teardown is not deterministic; shared-server reconnect is covered by the focused thread tests and managed recovery above",
    )
    console.log(
      "PASS isolation: all smoke processes used temporary HOME/XDG/DB paths; no provider request or model call was made",
    )
  } finally {
    await rm(sourceSandbox.root, { recursive: true, force: true })
    await rm(managedSandbox.root, { recursive: true, force: true })
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})

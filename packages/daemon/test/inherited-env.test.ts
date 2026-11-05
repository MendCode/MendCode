import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DROPPABLE_ENV, droppedEnvArgs, droppedEnvLog, dropHostSessionEnv, hostSessionEnvNames, ownArguments, parseDroppedEnv, restartWithoutHostSessionEnv, withoutHostSessionEnv } from "@mendcode/client/inherited-env"
import { askHarnessesAndStop, CLAUDE_SHELL_ENV, expectCleanChild, fakeClaude, USER_ENV } from "./inherited-env-fixture"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("the variables a Claude Code shell leaves behind", () => {
  test("a daemon started from a Claude Code shell drops that session's markers and keeps the user's own settings", () => {
    const environment: NodeJS.ProcessEnv = { ...CLAUDE_SHELL_ENV, ...USER_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", PATH: "/bin" }
    expect(dropHostSessionEnv(environment).sort()).toEqual(Object.keys(CLAUDE_SHELL_ENV).sort())
    expect(environment).toEqual({ ...USER_ENV, CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", PATH: "/bin" })
  })

  test("an ordinary environment is left as it is", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/u" }
    expect(dropHostSessionEnv(environment)).toEqual([])
    expect(environment).toEqual({ PATH: "/bin", HOME: "/home/u" })
  })

  test("AI_AGENT, GIT_EDITOR and TRACEPARENT go only with the value a Claude Code shell gives them", () => {
    // Another agent's AI_AGENT, a user's own editor and trace context outside a Claude Code shell are the user's.
    expect(hostSessionEnvNames({ AI_AGENT: "cursor", GIT_EDITOR: "true", TRACEPARENT: "00-abc-def-01" })).toEqual([])
    expect(hostSessionEnvNames({ CLAUDECODE: "1", GIT_EDITOR: "vim" })).toEqual(["CLAUDECODE"])
    expect(hostSessionEnvNames({ AI_AGENT: "claude-code/2.1.0" })).toEqual(["AI_AGENT"])
    expect(hostSessionEnvNames({ CLAUDECODE: "1", GIT_EDITOR: "true", TRACEPARENT: "00-abc-def-01" })).toEqual(["CLAUDECODE", "GIT_EDITOR", "TRACEPARENT"])
  })

  test("a daemon started from a tuios pane drops that pane's identity and token; a process that is the pane keeps them", () => {
    const pane = { TUIOS_ENV: "1", TUIOS_SOCKET: "/tmp/tuios.sock", TUIOS_SESSION: "session-0", TUIOS_PANE_ID: "f52f9980", TUIOS_PANE_TOKEN: "leaked-pane-token", TUIOS_PANE_GRANTS: "agent" }
    const environment: NodeJS.ProcessEnv = { ...pane, CLAUDECODE: "1", TERM_PROGRAM: "TUIOS", PATH: "/bin" }
    expect(withoutHostSessionEnv(environment)).toEqual({ TERM_PROGRAM: "TUIOS", PATH: "/bin" })
    expect(hostSessionEnvNames(environment, { pane: false })).toEqual(["CLAUDECODE"])
    expect(withoutHostSessionEnv(environment, { pane: false })).toEqual({ ...pane, TERM_PROGRAM: "TUIOS", PATH: "/bin" })
    expect(parseDroppedEnv("TUIOS_PANE_TOKEN,TUIOS_OTHER")).toEqual(["TUIOS_PANE_TOKEN"])
  })

  test("a daemon a terminal in a Rex block starts drops that block and session; the Rex installation's variables stay", () => {
    const environment: NodeJS.ProcessEnv = { REX_SESSION: "session:01a1", REX_BLOCK: "block:01a1", REX_SERVER: "unix:///tmp/rex.sock", REX_BIN_DIR: "/opt/rex/bin", PATH: "/bin" }
    expect(withoutHostSessionEnv(environment)).toEqual({ REX_SERVER: "unix:///tmp/rex.sock", REX_BIN_DIR: "/opt/rex/bin", PATH: "/bin" })
    expect(hostSessionEnvNames(environment, { pane: false })).toEqual([])
    expect(parseDroppedEnv("REX_BLOCK,REX_SERVER")).toEqual(["REX_BLOCK"])
  })

  test("the copy for a daemon leaves the caller's environment untouched", () => {
    const environment: NodeJS.ProcessEnv = { CLAUDECODE: "1", PATH: "/bin" }
    expect(withoutHostSessionEnv(environment)).toEqual({ PATH: "/bin" })
    expect(environment).toEqual({ CLAUDECODE: "1", PATH: "/bin" })
  })

  test("the names a launcher passes on are logged by name only, and nothing but droppable names is accepted", () => {
    expect(droppedEnvArgs([])).toEqual([])
    expect(droppedEnvArgs(["CLAUDECODE", "CLAUDE_PID"])).toEqual(["--dropped-env", "CLAUDECODE,CLAUDE_PID"])
    expect(parseDroppedEnv("CLAUDECODE,PATH,\u001b[31mFAKE,CLAUDE_PID")).toEqual(["CLAUDECODE", "CLAUDE_PID"])
    expect(parseDroppedEnv(undefined)).toEqual([])
    expect(droppedEnvLog(["CLAUDECODE"])).toBe("[ENV]: dropped inherited session variables: CLAUDECODE")
    expect(droppedEnvLog([])).toBeUndefined()
  })

  test("a compiled binary's own arguments skip its bundled entry; a script's keep the script", () => {
    expect(ownArguments(["/bin/mendcode", "/$bunfs/root/mendcode", "__daemon", "--dir", "/d"], "/$bunfs/root/mendcode")).toEqual(["__daemon", "--dir", "/d"])
    expect(ownArguments(["C:\\mendcode.exe", "B:/~BUN/root/mendcode.exe", "__daemon"], "B:/~BUN/root/mendcode.exe")).toEqual(["__daemon"])
    expect(ownArguments(["/usr/bin/bun", "/src/main.ts", "--dir", "/d"], "/src/main.ts")).toEqual(["/src/main.ts", "--dir", "/d"])
  })
})

describe("restarting in place without them", () => {
  /** Runs with exactly these marker values set (or, with `undefined`, absent) in this process, restoring what was there. */
  const withEnv = async (values: Record<string, string | undefined>, run: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
    for (const [name, value] of Object.entries(values)) value === undefined ? delete process.env[name] : (process.env[name] = value)
    try { await run() } finally { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value) }
  }

  test("restarts with the same arguments, the user's settings and none of the markers, after logging their names", async () => {
    const calls: Array<{ file: string; args: readonly string[]; env: Record<string, string | undefined> }> = []
    const lines: string[] = []
    await withEnv({ ...CLAUDE_SHELL_ENV, ...USER_ENV }, () => restartWithoutHostSessionEnv({ args: ["__daemon", "--dir", "/d"], log: (line) => lines.push(line), exec: async () => (file, args, env) => { calls.push({ file, args, env }) } }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe(process.execPath)
    expect(calls[0]!.args).toEqual(["__daemon", "--dir", "/d"])
    for (const name of Object.keys(CLAUDE_SHELL_ENV)) expect(calls[0]!.env[name]).toBeUndefined()
    expect(calls[0]!.env).toMatchObject(USER_ENV)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("CLAUDE_CODE_CHILD_SESSION")
    for (const value of ["leaked-session-id", "leaked-token", "/tmp/leaked.sock"]) expect(lines[0]).not.toContain(value)
  })

  test("nothing to drop, or no way to restart (Windows): it returns and logs nothing", async () => {
    const lines: string[] = []
    let execs = 0
    // Every droppable name absent, a tuios pane's too: the test may run in one.
    const absent = Object.fromEntries([...DROPPABLE_ENV].map((name) => [name, undefined]))
    await withEnv(absent, () => restartWithoutHostSessionEnv({ log: (line) => lines.push(line), exec: async () => () => { execs++ } }))
    await withEnv(CLAUDE_SHELL_ENV, () => restartWithoutHostSessionEnv({ log: (line) => lines.push(line), exec: async () => undefined }))
    expect(execs).toBe(0)
    expect(lines).toEqual([])
  })
})

describe.skipIf(process.platform === "win32")("a daemon process started from a Claude Code shell", () => {
  test("restarts in place (same pid), logs the names, and the programs it starts get none of the markers but the user's settings", async () => {
    const dir = temp("mendd-env-")
    const claude = fakeClaude(dir)
    const socketPath = path.join(dir, "mendd.sock")
    const daemon = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/main.ts"), "--dir", dir, "--cwd", dir, "--engine", "faux", "--local-transport", "unix"], {
      cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      env: { ...process.env, ...CLAUDE_SHELL_ENV, ...USER_ENV, ...claude.env },
    })
    cleanups.push(() => { if (daemon.exitCode === null) daemon.kill("SIGKILL") })
    const stderr = new Response(daemon.stderr).text()
    const deadline = Date.now() + 20_000
    while (!existsSync(socketPath) && daemon.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
    expect(existsSync(socketPath)).toBe(true)
    expect(readFileSync(path.join(dir, "mendd.lock"), "utf8").trim()).toBe(String(daemon.pid))
    await askHarnessesAndStop({ socketPath })
    expectCleanChild(claude)
    await daemon.exited
    const log = await stderr
    expect(log).toContain("[ENV]: dropped inherited session variables: ")
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SSE_PORT", "AI_AGENT"]) expect(log).toContain(name)
    for (const value of ["leaked-session-id", "leaked-token", "sk-ant-test-kept"]) expect(log).not.toContain(value)
  }, 40_000)
})

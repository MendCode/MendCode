import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { findSessionFiles, codexExecArgs, createCodexAdapter } from "../adapters/codex"
import { linkAuth } from "../adapters/common"
import { MENDCODE_EVAL_ENV, MENDCODE_EVAL_SETTINGS, MENDCODE_PROMPT_MODE } from "../adapters/mendcode-settings"
import { createMendcodeAdapter, nativeModelRef, nativeRunArgs } from "../adapters/mendcode"
import { cleanEnv } from "../lib/env"
import { assertSafeStateRoot, OWNER_MARKER } from "../lib/safety"
import { loadTask } from "../lib/tasks"
import { tempDir } from "./helpers"

describe("codex adapter arguments", () => {
  const args = codexExecArgs({ cwd: "/work", model: "gpt-6-luna", effort: "medium" })

  test("the held-equal settings are on the command line", () => {
    expect(args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(args[args.indexOf("-C") + 1]).toBe("/work")
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write")
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-6-luna")
    expect(args).toContain('model_reasoning_effort="medium"')
    expect(args).toContain('approval_policy="never"')
  })

  test("the operator's config and rules are ignored, and the prompt comes from stdin", () => {
    expect(args).toContain("--ignore-user-config")
    expect(args).toContain("--ignore-rules")
    expect(args.at(-1)).toBe("-")
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(args).not.toContain("danger-full-access")
  })
})

describe("mendcode adapter settings", () => {
  test("the evaluation settings pin tier, permission, sandbox and confinement", () => {
    expect(MENDCODE_EVAL_SETTINGS.tier).toBe("balanced")
    expect(MENDCODE_EVAL_SETTINGS.defaultPermission).toBe("full")
    expect(MENDCODE_EVAL_SETTINGS.sandbox).toEqual({ mode: "workspace-write", network: "off" })
    expect(MENDCODE_EVAL_SETTINGS.permission.external_directory).toBe("deny")
    expect(MENDCODE_PROMPT_MODE).toEqual({ mode: "focus", focus: "auto" })
    expect(MENDCODE_EVAL_ENV.MENDCODE_CLAUDE).toBe("0")
  })

  test("a bare model id gets the subscription provider prefix", () => {
    expect(nativeModelRef("gpt-6-luna")).toBe("chatgpt/gpt-6-luna")
    expect(nativeModelRef("chatgpt/gpt-6.1-sol")).toBe("chatgpt/gpt-6.1-sol")
    expect(nativeRunArgs("gpt-6-luna", "high")).toEqual(["--model", "chatgpt/gpt-6-luna", "--effort", "high"])
  })
})

describe("isolation", () => {
  test("the child environment is an allow-list: no keys, no operator HOME, no CODEX_HOME", () => {
    const env = cleanEnv({ HOME: "/iso" }, { PATH: "/usr/bin", HOME: "/Users/someone", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/Users/someone/.codex", HTTPS_PROXY: "http://p", TMPDIR: "/tmp/x" })
    expect(env.HOME).toBe("/iso")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.TMPDIR).toBe("/tmp/x")
    expect(env.PATH!.split(path.delimiter)).toContain(path.dirname(process.execPath))
  })

  test("the state root refuses the product's, Codex's and Claude's real directories", () => {
    for (const forbidden of [".mendcode-v2", ".mendcode", ".codex", ".pi", ".claude", "mc2-prueba"]) {
      expect(() => assertSafeStateRoot(path.join(homedir(), forbidden))).toThrow("[SAFETY]")
      expect(() => assertSafeStateRoot(path.join(homedir(), forbidden, "nested", "dir"))).toThrow("[SAFETY]")
    }
    expect(() => assertSafeStateRoot(homedir())).toThrow("[SAFETY]")
    expect(() => assertSafeStateRoot("/")).toThrow("[SAFETY]")
  })

  test("a non-empty directory the kit did not create is refused; an empty or kit-owned one is accepted", () => {
    const foreign = tempDir("foreign")
    writeFileSync(path.join(foreign, "something.db"), "x")
    expect(() => assertSafeStateRoot(foreign)).toThrow("not empty")
    const fresh = tempDir("fresh")
    expect(assertSafeStateRoot(fresh)).toBe(fresh)
    expect(existsSync(path.join(fresh, OWNER_MARKER))).toBe(true)
    expect(assertSafeStateRoot(fresh)).toBe(fresh)
  })

  test("auth is linked, not copied, and only auth.json (plus the model catalog when asked)", () => {
    const source = tempDir("auth")
    writeFileSync(path.join(source, "auth.json"), '{"tokens":{}}')
    writeFileSync(path.join(source, "models_cache.json"), "{}")
    writeFileSync(path.join(source, "config.toml"), "model = 'x'")
    const home = path.join(tempDir("home"), ".codex")
    expect(linkAuth(source, home, { modelsCache: false })).toEqual(["auth.json"])
    expect(lstatSync(path.join(home, "auth.json")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(home, "auth.json"))).toBe(path.join(source, "auth.json"))
    expect(existsSync(path.join(home, "config.toml"))).toBe(false)
    expect(existsSync(path.join(home, "models_cache.json"))).toBe(false)
    const second = path.join(tempDir("home2"), ".codex")
    expect(linkAuth(source, second, { modelsCache: true })).toEqual(["auth.json", "models_cache.json"])
  })

  test("--auth-from without an auth.json is a clear error", () => {
    expect(() => linkAuth(tempDir("empty"), path.join(tempDir("h"), ".codex"), { modelsCache: false })).toThrow("no auth.json")
  })

  test("codex session discovery finds rollout files newest first", () => {
    const home = tempDir("cxhome")
    const day = path.join(home, "sessions", "2026", "10", "06")
    mkdirSync(day, { recursive: true })
    writeFileSync(path.join(day, "rollout-2026-10-06T10-00-00-aaa.jsonl"), "{}")
    writeFileSync(path.join(day, "notes.txt"), "x")
    expect(findSessionFiles(home).map((file) => path.basename(file))).toEqual(["rollout-2026-10-06T10-00-00-aaa.jsonl"])
    expect(findSessionFiles(path.join(home, "nope"))).toEqual([])
  })

  test("the codex adapter prepares an isolated home without starting anything", async () => {
    const auth = tempDir("auth")
    writeFileSync(path.join(auth, "auth.json"), "{}")
    const runDir = tempDir("run")
    const adapter = createCodexAdapter({ authFrom: auth, codexBin: "/definitely/not/codex" })
    await adapter.prepare({ task: loadTask("bug-offbyone"), runDir, effort: "medium", timeoutMs: 1000 })
    // A missing binary is reported as a harness failure with usage unavailable, never a thrown crash.
    const result = await adapter.run("hello", tempDir("cwd"), "m")
    expect(result.exitCode).toBeNull()
    expect(result.usage.inputTokens).toBeNull()
    expect(result.notes.join(" ")).toContain("no usage")
    await adapter.cleanup()
    await adapter.cleanup()
  })
})

describe("mendcode adapter end to end on the faux engine (no model, no credentials)", () => {
  async function runFaux(prompt: string) {
    const root = tempDir("dd")
    const runDir = tempDir("rd")
    const cwd = tempDir("cw")
    const adapter = createMendcodeAdapter({ engine: "faux", dataDir: root })
    await adapter.prepare({ task: loadTask("bug-offbyone"), runDir, effort: "medium", timeoutMs: 60_000 })
    const result = await adapter.run(prompt, cwd, "faux")
    return { adapter, result, runDir, root }
  }

  function daemonPidOf(runDir: string): number {
    const ready = readFileSync(path.join(runDir, "daemon.log"), "utf8").split("\n").find((line) => line.includes('"ready":true'))
    return (JSON.parse(ready!) as { pid: number }).pid
  }

  test("starts a daemon on the dedicated data dir, applies the settings, runs, parses usage, stops the daemon", async () => {
    const { adapter, result, runDir, root } = await runFaux("/faux-activity")
    expect(result.exitCode).toBe(0)
    expect(result.usage.inputTokens).toBe(21_000)
    expect(result.usage.cachedReadTokens).toBe(9_000)
    expect(result.usage.outputTokens).toBe(900)
    expect(result.usage.toolCalls).toBe(4)
    expect(result.usage.failedToolCalls).toBe(0)
    expect(result.usage.compactions).toBe(0)
    expect(result.usage.turnMs).toBeGreaterThanOrEqual(0)
    expect(result.agentMs).toBeGreaterThan(0)
    // The daemon really holds the evaluation settings and the prompt mode was confirmed.
    expect(JSON.parse(readFileSync(path.join(runDir, "settings-applied.json"), "utf8"))).toEqual(MENDCODE_EVAL_SETTINGS)
    expect(result.notes.join(" ")).toContain("prompt mode focus, family auto")
    // Its state lives under the dedicated data dir, never under the operator's HOME.
    const daemonLog = readFileSync(path.join(runDir, "daemon.log"), "utf8")
    expect(daemonLog).toContain(root)
    expect(daemonLog).not.toContain(path.join(homedir(), ".mendcode-v2"))
    // The daemon is gone as soon as the run returns.
    const pid = daemonPidOf(runDir)
    expect(() => process.kill(pid, 0)).toThrow()
    await adapter.cleanup()
    await adapter.cleanup()
    expect(readFileSync(path.join(root, OWNER_MARKER), "utf8").length).toBeGreaterThan(0)
  }, 90_000)

  test("a failing turn is reported through the exit code and the notes", async () => {
    const { adapter, result } = await runFaux("/fail")
    expect(result.exitCode).toBe(1)
    expect(result.notes.join(" ")).toContain("requested failure")
    expect(result.usage.inputTokens).toBeNull()
    await adapter.cleanup()
  }, 90_000)

  test("an unreachable data directory is refused before anything starts", async () => {
    const adapter = createMendcodeAdapter({ engine: "faux", dataDir: path.join(homedir(), ".mendcode-v2") })
    await expect(adapter.prepare({ task: loadTask("bug-offbyone"), runDir: tempDir("rd"), effort: "medium", timeoutMs: 1000 })).rejects.toThrow("[SAFETY]")
  })

  test("a data directory path too long for a unix socket is refused with advice", async () => {
    const long = path.join(tempDir("dd"), "x".repeat(90))
    const adapter = createMendcodeAdapter({ engine: "faux", dataDir: long })
    await expect(adapter.prepare({ task: loadTask("bug-offbyone"), runDir: tempDir("rd"), effort: "medium", timeoutMs: 1000 })).rejects.toThrow("too long")
  })
})

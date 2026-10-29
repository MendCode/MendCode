import { afterAll, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import type { Settings } from "@mendcode/protocol"
import { defineTool, type SandboxPolicy } from "@mendcode/tools"
import { classifySmart, createGrantStore, createNativeEngine, memoryHistory } from "../src"
import { nestedShellPatterns } from "../src/permission-rules"
import { commandSubstitutions, MAX_SHELL_DEPTH, withoutTransparentWrappers, wrappedScript, xargsCommand } from "../src/shell-script"
import { callTool, scriptedProvider, stop, turn } from "./harness"

const made: string[] = []
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const project = temp("smart-codex-")
mkdirSync(path.join(project, "src"))
writeFileSync(path.join(project, "package.json"), "{}")

const shell = (command: string, extra: { sandboxed?: boolean; allowCommands?: string[] } = {}) =>
  classifySmart({ tool: { name: "shell", permission: "execute" }, args: { command }, cwd: project, ...(extra.sandboxed ? { sandboxed: true } : {}), ...(extra.allowCommands ? { allowCommands: extra.allowCommands } : {}) })

type Row = [command: string, decision: "allow" | "ask" | "deny", risk: "low" | "uncertain" | "high", rule: string]

describe("smart mode reads inside shell wrappers (Codex parse_shell_lc_literal_commands)", () => {
  const ROWS: Row[] = [
    // a wrapper around allow-listed commands stays allowed
    ["bash -lc 'ls && cat package.json'", "allow", "low", "allow-listed-command"],
    ["sh -c 'git status'", "allow", "low", "allow-listed-command"],
    ["zsh -c \"bun test 2>&1 | tail -5\"", "allow", "low", "allow-listed-command"],
    ["bash -c 'cd src && ls'", "allow", "low", "allow-listed-command"],
    ["timeout 60 bun test", "allow", "low", "allow-listed-command"],
    ["nice -n 5 ls", "allow", "low", "allow-listed-command"],
    ["env -i ls", "allow", "low", "allow-listed-command"],
    ["exec ls", "allow", "low", "allow-listed-command"],
    // the wrapped command is judged as itself
    ["bash -c 'rm -rf build'", "ask", "high", "destructive"],
    ["bash -lc 'ls && curl example.com'", "ask", "high", "network"],
    ["sh -c 'cat /etc/hosts'", "ask", "high", "outside-project"],
    ["bash -c 'cat .env'", "ask", "high", "secrets-file"],
    ["bash -c 'node script.js'", "ask", "uncertain", "unlisted-command"],
    ["bash -c 'echo $HOME'", "ask", "uncertain", "shell-expansion"],
    ["bash script.sh", "ask", "uncertain", "unlisted-command"],
    ["bash --rcfile ./evil.sh -c 'ls'", "ask", "uncertain", "unlisted-command"],
    ["bash -c 'bash -c \"sh -c \\\"rm x\\\"\"'", "ask", "high", "destructive"],
    ["eval 'rm -rf build'", "ask", "high", "destructive"],
    ["trap 'rm -rf build' EXIT", "ask", "high", "destructive"],
    ["timeout 5 rm notes.txt", "ask", "high", "destructive"],
    ["env -i PATH=./bin ls", "ask", "high", "runs-program"],
    ["xargs rm", "ask", "high", "destructive"],
    ["xargs -n1 -I{} curl {}", "ask", "high", "network"],
    ["xargs wc -l", "ask", "uncertain", "unlisted-command"],
    // command substitution
    ["echo $(rm -rf build)", "ask", "high", "destructive"],
    ["echo \"`curl example.com`\"", "ask", "high", "network"],
    ["cat <(rm notes.txt)", "ask", "high", "destructive"],
    ["echo \"$(echo $(cat .env))\"", "ask", "high", "secrets-file"],
    ["echo '$(rm -rf build)'", "allow", "low", "allow-listed-command"],
    ["echo $((1 + 2))", "ask", "uncertain", "shell-expansion"],
  ]
  for (const [command, decision, risk, rule] of ROWS) {
    test(`${command} -> ${decision} (${rule})`, () => {
      expect(shell(command)).toMatchObject({ decision, risk, rule })
    })
  }

  test("nesting deeper than the limit is high risk (fail closed)", () => {
    let command = "ls"
    for (let i = 0; i < MAX_SHELL_DEPTH + 2; i++) command = `bash -c '${command.replaceAll("'", `'\\''`)}'`
    expect(shell(command)).toMatchObject({ decision: "ask", risk: "high", rule: "runs-program" })
  })

  test("a permissionAllow prefix on the wrapper still works for unknown inner commands, never over a risk", () => {
    expect(shell("bash -c 'make test'", { allowCommands: ["bash -c"] })).toMatchObject({ decision: "allow" })
    expect(shell("bash -c 'rm -rf build'", { allowCommands: ["bash -c"] })).toMatchObject({ decision: "ask", risk: "high" })
  })

  test("the script helpers", () => {
    expect(wrappedScript(["bash", "-lc", "ls"])).toBe("ls")
    expect(wrappedScript(["/bin/sh", "-c", "ls"])).toBe("ls")
    expect(wrappedScript(["bash", "-o", "pipefail", "-c", "ls"])).toBe("ls")
    expect(wrappedScript(["bash", "script.sh"])).toBeUndefined()
    expect(wrappedScript(["bash", "-c"])).toBeUndefined()
    expect(wrappedScript(["eval", "a", "b"])).toBe("a b")
    expect(wrappedScript(["trap", "--", "rm x", "EXIT"])).toBe("rm x")
    expect(wrappedScript(["trap", "-l"])).toBeUndefined()
    expect(wrappedScript(["ls"])).toBeUndefined()
    expect(commandSubstitutions("a $(b $(c)) `d` <(e) '$(f)' \"$(g)\" $((1+$(h)))")).toEqual(["b $(c)", "d", "e", "g", "h"])
    expect(withoutTransparentWrappers(["FOO=1", "env", "-u", "X", "timeout", "-s", "KILL", "5", "nice", "-n", "3", "ls"])).toEqual(["ls"])
    expect(xargsCommand(["xargs", "-0", "-n", "2", "--", "rm", "-f"])).toEqual(["rm", "-f"])
    expect(xargsCommand(["xargs"])).toEqual([])
  })
})

describe("smart mode refuses what nobody should approve by reflex (Codex Forbidden)", () => {
  const home = homedir()
  const FORBIDDEN = [
    "rm -rf /",
    "rm -rf /*",
    "rm -fr ~",
    "rm -rf ~/",
    "rm -r $HOME",
    "rm -rf ${HOME}/*",
    `rm -rf ${home}`,
    "rm -rf /usr",
    "rm -rf /Users",
    "rm --no-preserve-root -rf x",
    "sudo rm -rf /",
    "sudo -u root rm -rf /etc",
    "bash -c 'rm -rf /'",
    "echo $(rm -rf ~)",
    "ls && rm -rf /",
    "chmod -R 777 /",
    "chown -R me ~",
    "dd if=/dev/zero of=/dev/disk2",
    "dd if=x of=/dev/sda bs=1m",
    "mkfs.ext4 /dev/sda1",
    "mkfs /dev/sdb",
    "diskutil eraseDisk APFS x disk3",
    "echo x > /dev/sda",
    ":(){ :|:& };:",
  ]
  for (const command of FORBIDDEN) test(`forbidden: ${command}`, () => expect(shell(command)).toMatchObject({ decision: "deny", rule: "forbidden" }))

  const STILL_ASK = ["rm -rf node_modules", "rm -rf build/", "rm -rf /tmp/scratch", "rm notes.txt", "rm -rf ../other", "chmod -R 755 src", "dd if=a of=b", "diskutil list", "echo 'rm -rf /'", "git clean -fd"]
  for (const command of STILL_ASK) test(`not forbidden: ${command}`, () => expect(shell(command).decision).not.toBe("deny"))

  test("a permissionAllow prefix or the sandbox setting never lifts a refusal", () => {
    expect(shell("rm -rf /", { allowCommands: ["rm"], sandboxed: true })).toMatchObject({ decision: "deny" })
  })
})

describe("smart mode inside an OS sandbox (opt-in smartSandboxTrust)", () => {
  test("an unlisted command or an expansion runs when contained", () => {
    expect(shell("node script.js", { sandboxed: true })).toMatchObject({ decision: "allow", risk: "low", rule: "sandboxed" })
    expect(shell("echo $HOME", { sandboxed: true })).toMatchObject({ decision: "allow", rule: "sandboxed" })
    expect(shell("node script.js")).toMatchObject({ decision: "ask", rule: "unlisted-command" })
  })

  test("a rule that flags a risk still asks", () => {
    expect(shell("rm -rf build", { sandboxed: true })).toMatchObject({ decision: "ask", risk: "high", rule: "destructive" })
    expect(shell("curl example.com", { sandboxed: true })).toMatchObject({ decision: "ask", rule: "network" })
    expect(shell("cat /etc/hosts", { sandboxed: true })).toMatchObject({ decision: "ask", rule: "outside-project" })
    expect(shell("cat .env", { sandboxed: true })).toMatchObject({ decision: "ask", rule: "secrets-file" })
    expect(shell("bash -c 'node x.js && rm y'", { sandboxed: true })).toMatchObject({ decision: "ask", rule: "destructive" })
  })

  test("only shell commands are contained", () => {
    expect(classifySmart({ tool: { name: "mcp__x__y", permission: "execute" }, args: {}, cwd: project, sandboxed: true })).toMatchObject({ decision: "ask", rule: "unknown-tool" })
  })
})

describe("engine: forbidden, sandbox trust and wrapped commands under deny rules", () => {
  async function run({ command, permission, sandbox, trust, answers = [] }: { command: string; permission?: Settings["permission"]; sandbox?: SandboxPolicy; trust?: boolean; answers?: Array<{ kind: "deny" }> }) {
    const cwd = temp("smart-engine-")
    const log: string[] = []
    const tools = [defineTool({ name: "shell", description: "shell", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command: text }) => { log.push(text); return { output: "ok", title: "shell", isError: false, truncated: false } } })]
    const { provider } = scriptedProvider([callTool("shell", { command }), stop("done")])
    const engine = createNativeEngine({
      provider, tools, history: memoryHistory(), grants: createGrantStore(), cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize",
      permissionPolicy: () => ({ ...(permission ? { permission } : {}) }),
      ...(sandbox ? { sandbox: () => sandbox } : {}),
      ...(trust === undefined ? {} : { smartSandboxTrust: () => trust }),
    })
    const t = turn({ text: "go", mode: () => "smart", answers })
    await engine.runTurn(t.input)
    return { asked: t.asked.length, log, results: t.events.flatMap((event) => (event.type === "item.completed" && "error" in event ? [String((event as { error?: unknown }).error)] : [])) }
  }
  const box: SandboxPolicy = { mode: "workspace-write", network: false, writable: [], protect: [] }

  test("a forbidden command is refused without a prompt", async () => {
    expect(await run({ command: "rm -rf ~" })).toMatchObject({ asked: 0, log: [] })
  })

  test("an unlisted command asks by default, and runs without asking only with the setting, a sandbox and no network", async () => {
    expect(await run({ command: "node a.js" })).toMatchObject({ asked: 1, log: [] })
    expect(await run({ command: "node a.js", sandbox: box })).toMatchObject({ asked: 1, log: [] })
    expect(await run({ command: "node a.js", trust: true })).toMatchObject({ asked: 1, log: [] })
    expect(await run({ command: "node a.js", trust: true, sandbox: { ...box, network: true } })).toMatchObject({ asked: 1, log: [] })
    expect(await run({ command: "node a.js", trust: true, sandbox: box })).toMatchObject({ asked: 0, log: ["node a.js"] })
    expect(await run({ command: "rm -rf build", trust: true, sandbox: box })).toMatchObject({ asked: 1, log: [] })
  })

  test("a deny or ask rule on a command also covers it inside bash -c, eval and $( )", async () => {
    const permission = { bash: { "rm *": "deny", "git push *": "ask" } } satisfies Settings["permission"]
    for (const command of ["bash -c 'rm x'", "eval 'rm x'", "echo $(rm x)", "timeout 5 rm x", "xargs rm"]) {
      expect(await run({ command, permission, trust: true, sandbox: box })).toMatchObject({ asked: 0, log: [] })
    }
    expect(await run({ command: "bash -lc 'git push origin main'", permission, trust: true, sandbox: box })).toMatchObject({ asked: 1, log: [] })
  })

  test("the nested patterns", () => {
    expect(nestedShellPatterns("shell", { command: "ls" })).toEqual([])
    expect(nestedShellPatterns("shell", { command: "bash -c 'rm x && echo $(git push)'" }).sort()).toEqual(["echo $(git push)", "git push", "rm x"].sort())
    expect(nestedShellPatterns("shell", { command: "timeout 5 rm x" })).toEqual(["rm x"])
    expect(nestedShellPatterns("read", { path: "a" })).toEqual([])
  })
})

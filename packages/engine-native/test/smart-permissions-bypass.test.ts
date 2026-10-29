import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import type { Settings } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { classifySmart, createGrantStore, createNativeEngine, memoryHistory, splitCommand } from "../src"
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

const project = temp("smart-bypass-")
mkdirSync(path.join(project, "src"))
writeFileSync(path.join(project, "package.json"), "{}")

const shell = (command: string) => classifySmart({ tool: { name: "shell", permission: "execute" }, args: { command }, cwd: project })
const edit = (file: string) => classifySmart({ tool: { name: "write", permission: "write" }, args: { path: file }, cwd: project })

describe("smart mode: commands on the allow list that can still run code or write elsewhere", () => {
  const MUST_ASK = [
    // sed scripts: `e` runs a command, `w` and the `w`/`e` flags of `s` write or run
    "sed 'e id' package.json",
    "sed -n '1e id' package.json",
    "sed 's/a/b/e' package.json",
    "sed -n 'w /tmp/pwned' package.json",
    "sed 's/a/b/w out.txt' package.json",
    "sed -n -f script.sed package.json",
    // ripgrep runs the program named by --pre and --hostname-bin
    "rg --pre ./hook.sh foo",
    "rg --pre=./hook.sh foo src",
    "rg --hostname-bin=./hook.sh foo",
    // git grep opens matches in a pager program
    "git grep -Osh foo",
    "git grep --open-files-in-pager=sh foo",
    // sort runs its compress program
    "sort --compress-program=./hook.sh package.json",
    // a leading assignment can redirect which program or library runs
    "PATH=./bin ls",
    "env PATH=./bin ls",
    "LD_PRELOAD=./evil.so ls",
    "GIT_EXTERNAL_DIFF=./hook.sh git diff",
    "BASH_ENV=./hook.sh ls",
    // process substitution runs a command
    "cat <(rm notes.txt)",
    "ls >(cat)",
    // an option value glued to its flag still names a path
    "sort -o/etc/cron.d/x package.json",
    // jq can print the environment
    "jq -n env",
    "jq -n '$ENV'",
  ]
  for (const command of MUST_ASK) test(`asks: ${command}`, () => expect(shell(command).decision).toBe("ask"))

  const MUST_RUN = [
    "sed -n '1,5p' package.json",
    "sed 's/a/b/g' package.json",
    "sed -E 's/(a)+/\\1/' package.json",
    "sed -n '3p' package.json",
    "sed -n '2,$p' package.json",
    "sed -e 's/a/b/' -e '3d' package.json",
    "rg foo src",
    "git grep foo",
    "sort package.json",
    "NODE_ENV=test bun test",
    "CI=1 bun test",
    "jq . package.json",
    "cat package.json | head -3",
    "echo '<(not a substitution)'",
  ]
  for (const command of MUST_RUN) test(`runs: ${command}`, () => expect(shell(command).decision).toBe("allow"))

  test("process substitution marks the command as expansion", () => {
    expect(splitCommand("cat <(ls)")[0]!.expansion).toBe(true)
    expect(splitCommand("echo x >(cat)")[0]!.expansion).toBe(true)
    expect(splitCommand("cat < file")[0]!.expansion).toBe(false)
  })

  test("what the daemon runs later (.mendcode: hooks, tools, extensions) asks, like .git internals", () => {
    expect(edit(".mendcode/hooks.json")).toMatchObject({ decision: "ask", risk: "high", rule: "agent-config" })
    expect(edit(".mendcode/tools/run.json")).toMatchObject({ decision: "ask", rule: "agent-config" })
    expect(shell("echo '{}' > .mendcode/hooks.json")).toMatchObject({ decision: "ask", rule: "agent-config" })
    expect(shell("cp x.json .mendcode/tools/run.json")).toMatchObject({ decision: "ask", rule: "agent-config" })
    expect(edit("src/a.ts")).toMatchObject({ decision: "allow" })
  })
})

describe("saved allow rules never cover a command whose text is only known after expansion", () => {
  async function run(permission: Settings["permission"], command: string) {
    const cwd = temp("rule-expansion-")
    const log: string[] = []
    const tools = [defineTool({ name: "shell", description: "shell", permission: "execute", args: z.object({ command: z.string() }), execute: async ({ command: text }) => { log.push(text); return { output: "ok", title: "shell", isError: false, truncated: false } } })]
    const { provider } = scriptedProvider([callTool("shell", { command }), stop("done")])
    const engine = createNativeEngine({ provider, tools, history: memoryHistory(), grants: createGrantStore(), cwdFor: () => cwd, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => ({ permission }) })
    const t = turn({ text: "go", answers: [{ kind: "deny" }] })
    await engine.runTurn(t.input)
    return { asked: t.asked.length, log }
  }

  for (const command of ["ls $(echo hi)", "ls `echo hi`", "ls <(echo hi)", "ls \"$(echo hi)\""]) {
    test(`\`ls *\` asks for ${command}`, async () => {
      expect(await run({ shell: { "ls *": "allow" } }, command)).toEqual({ asked: 1, log: [] })
    })
  }

  test("a plain `ls -la` still runs under the same rule, and a whole-tool allow still covers everything", async () => {
    expect(await run({ shell: { "ls *": "allow" } }, "ls -la")).toEqual({ asked: 0, log: ["ls -la"] })
    expect(await run({ shell: { "ls *": "allow" } }, "ls '$HOME'")).toEqual({ asked: 0, log: ["ls '$HOME'"] })
    expect(await run({ shell: "allow" }, "ls $(echo hi)")).toEqual({ asked: 0, log: ["ls $(echo hi)"] })
    expect(await run({ shell: { "ls $(echo hi)": "allow" } }, "ls $(echo hi)")).toEqual({ asked: 0, log: ["ls $(echo hi)"] })
  })
})

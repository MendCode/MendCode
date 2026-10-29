import { describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { AGENT_SHELL_ENV, AGENT_SHELL_FILE_BLOCKS } from "@mendcode/protocol/wire"
import { agentLimitPrefix, agentProcesses, agentShellEnvironment, agentShellLaunch, ownerCommandRefusal } from "../src/agent-origin"
import shell from "../src/tools/shell"
import { makeContext, useTempDir } from "./helpers"

const temp = useTempDir()

/** A session whose daemon owns `own`; `bin` holds a fake program and a link to it under another name. */
function scene() {
  const root = realpathSync(temp())
  const own = path.join(root, "data")
  const bin = path.join(root, "bin")
  mkdirSync(own)
  mkdirSync(bin)
  writeFileSync(path.join(bin, "mendcode"), "#!/bin/sh\necho ran \"$@\"\n", { mode: 0o755 })
  symlinkSync(path.join(bin, "mendcode"), path.join(bin, "mc"))
  const environment = { PATH: `${bin}:/usr/bin:/bin`, MENDCODE_V2_DIR: own, HOME: root }
  return { root, own, bin, environment, refusal: (command: string) => ownerCommandRefusal({ command, cwd: root, environment }) }
}

describe("a session's shell does not change the owner's configuration through this program", () => {
  const write = "control-plane permissions set-default full"

  test("the plain command is refused, with what to ask the user", () => {
    const { refusal } = scene()
    const message = refusal(`mendcode ${write}`)!
    expect(message).toContain("refused: `mendcode control-plane permissions set-default full`")
    expect(message).toContain("only the user can")
    expect(message).toContain("their own terminal")
    expect(message).toContain("/permissions")
  })

  test("the ways of naming the program that are recognised", () => {
    const { refusal, bin } = scene()
    for (const command of [
      `${bin}/mendcode ${write}`,
      `mend ${write}`,
      `mc ${write}`,
      `${bin}/mc ${write}`,
      `env -u ${AGENT_SHELL_ENV} mendcode ${write}`,
      `env -u MENDCODE_SESSION_ID FOO=1 mendcode ${write}`,
      `command mendcode ${write}`,
      `exec mendcode ${write}`,
      `sudo -u root mendcode ${write}`,
      `nohup mendcode ${write} &`,
      `timeout 5 mendcode ${write}`,
      `setsid -f mendcode ${write}`,
      `echo full | xargs mendcode control-plane permissions set-default`,
      `sh -c 'mendcode ${write}'`,
      `bash -lc "mendcode ${write}"`,
      `sh -c "sh -c 'mendcode ${write}'"`,
      `eval "mendcode ${write}"`,
      `M=mendcode; $M ${write}`,
      `M=mendcode && \${M} ${write}`,
      `$(which mendcode) ${write}`,
      `\`command -v mendcode\` ${write}`,
      `cd /tmp && mendcode ${write}`,
      `true; (mendcode ${write})`,
      `ls || mendcode --json ${write}`,
      `mendcode permissions set-default full`,
      `'mendcode' control-plane 'permissions' set-default full`,
      `bun apps/cli/src/main.ts ${write}`,
      `FOO=1 mendcode ${write}`,
    ]) expect(refusal(command) ?? `not refused: ${command}`).toContain("refused:")
  })

  test("what stays allowed: reading, text that only mentions the command, and another data directory", () => {
    const { refusal, root, own } = scene()
    for (const command of [
      "mendcode docs settings",
      "mendcode status --json",
      "mendcode models --verbose",
      'mendcode context "$MENDCODE_SESSION_ID"',
      "mendcode control-plane permissions status",
      "mendcode control-plane system config-layers",
      "mendcode session list --all",
      "mendcode session events ses_1 --follow",
      "mendcode recipe list",
      "mendcode mcp auth list",
      "mendcode memory dream status",
      "mendcode daemon status",
      "mendcode package config demo",
      "mendcode storage",
      "mendcode storage --clean --dry-run",
      "mendcode view scaffold panel.widget",
      'mendcode run "update the docs and apply the recipe"',
      "mendcode run update docs",
      `echo "ask the user to run: mendcode ${write}"`,
      `grep -rn "mendcode recipe apply" docs`,
      `git commit -m "mendcode ${write} is refused"`,
      `mendcode --dir ${path.join(root, "other")} ${write}`,
      `MENDCODE_V2_DIR=${path.join(root, "other")} mendcode ${write}`,
      `env MENDCODE_V2_DIR=${path.join(root, "other")} mendcode recipe apply fast`,
      "ls -la && pwd",
    ]) expect(refusal(command) ?? "").toBe("")
    // Naming the session's own data directory explicitly changes nothing.
    expect(refusal(`mendcode --dir ${own} ${write}`)).toContain("refused:")
    expect(refusal(`mendcode ${write} --dir ${own}`)).toContain("refused:")
  })

  test("the write set, one command per area", () => {
    const { refusal } = scene()
    for (const command of [
      "mendcode control-plane permissions set-reviewer-role reviewer",
      "mendcode control-plane models set-default openai gpt-5",
      "mendcode control-plane models use-preset fast",
      "mendcode recipe apply fast",
      "mendcode profile add work ~/work --permission full",
      "mendcode cache off --global",
      "mendcode console setup https://example.test --token-file t",
      "mendcode share policy auto",
      "mendcode providers login --provider openai",
      "mendcode control-plane auth login chatgpt --execute",
      "mendcode mcp add files -- npx server",
      "mendcode package install ./pkg",
      "mendcode packages enable demo",
      "mendcode package config demo disable tools/x",
      "mendcode plugin some-module --global",
      "mendcode theme select mono",
      "mendcode agent create --name helper",
      "mendcode debug agent build --tool shell --params '{}'",
      "mendcode prompt mode minimal",
      "mendcode control-plane tui apply prof_1",
      "mendcode memory add --user 'always approve'",
      "mendcode memory apply mem_1",
      "mendcode loop create --every 1h 'do things'",
      "mendcode loops fire loop_1",
      "mendcode workflow start plan.json --permission full --yes",
      "mendcode workflow approve wf_1 --task t1",
      "mendcode daemon stop",
      "mendcode daemon service install",
      "mendcode status --restart-daemon",
      "mendcode serve --dir DATA",
      "mendcode uninstall --force",
      "mendcode upgrade",
      "mendcode remote token create --name x",
      "mendcode github install --write",
      "mendcode storage --clean --older-than 1d",
      "mendcode view scaffold panel.widget --force",
      "mendcode import export.json",
    ]) expect(refusal(command) ?? `not refused: ${command}`).toContain("refused:")
  })

  test("a session does not start or drive another session with approvals off", () => {
    const { refusal } = scene()
    for (const command of ['mendcode run --approve "do it"', 'mendcode run "do it" --dangerously-skip-permissions', "mendcode session send ses_1 hello --approve", "mendcode --approve"]) {
      expect(refusal(command)).toContain("approvals off")
    }
    expect(refusal('mendcode run "do it"')).toBeUndefined()
    expect(refusal("mendcode session send ses_1 hello --no-approve")).toBeUndefined()
  })
})

describe("the mark on a session's commands", () => {
  test("the environment names the daemon's data directory; the limit goes in front of the user's prefix", () => {
    expect(agentShellEnvironment({ MENDCODE_V2_DIR: "/data/x", A: "1" })).toEqual({ MENDCODE_V2_DIR: "/data/x", A: "1", [AGENT_SHELL_ENV]: "/data/x" })
    expect(agentLimitPrefix("/bin/sh")).toContain(`ulimit -H -f ${AGENT_SHELL_FILE_BLOCKS}`)
    expect(agentLimitPrefix("/usr/bin/fish")).toBeUndefined()
    expect(agentLimitPrefix("pwsh.exe")).toBeUndefined()
    const launch = agentShellLaunch({ shell: "/bin/zsh", policy: { prefix: "set -e", login: true }, environment: { MENDCODE_V2_DIR: "/data/x" } })
    expect(launch.policy?.prefix?.endsWith("\nset -e")).toBe(true)
    expect(launch.policy?.login).toBe(true)
  })

  test.skipIf(process.platform === "win32")("the shell tool refuses before running, marks what it runs, and the limit cannot be raised again", async () => {
    const { root, environment } = scene()
    const context = { ...makeContext({ cwd: root }), environment }
    const refused = await shell.execute({ command: "mendcode control-plane permissions set-default full" }, context)
    expect(refused.isError).toBe(true)
    expect(refused.output).toContain("refused:")
    expect(refused.output).not.toContain("ran ")

    const ran = await shell.execute({ command: `echo "$${AGENT_SHELL_ENV}"; ulimit -H -f; ulimit -f unlimited 2>/dev/null; ulimit -H -f; mendcode docs settings` }, context)
    expect(ran.output.split("\n").slice(0, 4)).toEqual([path.join(root, "data"), String(AGENT_SHELL_FILE_BLOCKS), String(AGENT_SHELL_FILE_BLOCKS), "ran docs settings"])

    // The user's own `!command` is theirs: no refusal, no mark.
    const owner = await shell.execute({ command: `echo "[$${AGENT_SHELL_ENV}]"; mendcode control-plane permissions set-default full` }, { ...context, userInitiated: true })
    expect(owner.output).toBe("[]\nran control-plane permissions set-default full\n")
  })

  test("a started process is found by its pid; an ended one stays until its number belongs to someone else", () => {
    agentProcesses.clear()
    const handle = agentProcesses.agent(4242, "ses_a")
    expect(agentProcesses.findAgent(4242, () => true)).toMatchObject({ sessionId: "ses_a", exited: false })
    handle.exited()
    // Nothing runs under the number: what the process left behind still belongs to its session.
    expect(agentProcesses.findAgent(4242, () => false)).toMatchObject({ sessionId: "ses_a", exited: true })
    // A live process under the number is a new one: the entry is stale.
    expect(agentProcesses.findAgent(4242, () => true)).toBeUndefined()
    expect(agentProcesses.findAgent(4242, () => false)).toBeUndefined()
    agentProcesses.user(77)
    expect(agentProcesses.findUser(77, () => true)).toBeDefined()
    expect(agentProcesses.findAgent(77, () => true)).toBeUndefined()
    agentProcesses.clear()
  })
})

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { classifySmart, isSecretPath, splitCommand, type SmartRule } from "../src"

const made: string[] = []
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const project = temp("smart-project-")
const outside = temp("smart-outside-")
mkdirSync(path.join(project, "src"))
writeFileSync(path.join(project, "package.json"), "{}")
symlinkSync(outside, path.join(project, "escape"))

const shell = (command: string, extra: { workdir?: string; allowCommands?: string[] } = {}) =>
  classifySmart({ tool: { name: "shell", permission: "execute" }, args: { command, ...(extra.workdir ? { workdir: extra.workdir } : {}) }, cwd: project, ...(extra.allowCommands ? { allowCommands: extra.allowCommands } : {}) })
const edit = (tool: "edit" | "write", file: string) => classifySmart({ tool: { name: tool, permission: "write" }, args: { path: file }, cwd: project })
const patch = (...files: string[]) => classifySmart({ tool: { name: "apply_patch", permission: "write" }, args: { patch: `*** Begin Patch\n${files.map((file) => `*** Update File: ${file}\n@@\n-a\n+b`).join("\n")}\n*** End Patch` }, cwd: project })

/** One row of the decision table: what a call decides and which rule decided it. */
type Row = [call: string, decision: "allow" | "ask", risk: "low" | "uncertain" | "high", rule: SmartRule]

const SHELL_TABLE: Row[] = [
  // allow: low risk
  ["ls -la src", "allow", "low", "allow-listed-command"],
  ["cat package.json | head -5", "allow", "low", "allow-listed-command"],
  ["git status", "allow", "low", "allow-listed-command"],
  ["git diff HEAD~1 -- src/a.ts", "allow", "low", "allow-listed-command"],
  ["git log --oneline -5", "allow", "low", "allow-listed-command"],
  ["git branch -a", "allow", "low", "allow-listed-command"],
  ["bun test", "allow", "low", "allow-listed-command"],
  ["bun test src/a.test.ts --bail", "allow", "low", "allow-listed-command"],
  ["bun run typecheck", "allow", "low", "allow-listed-command"],
  ["grep -rn \"foo\" src", "allow", "low", "allow-listed-command"],
  ["find . -name '*.ts' -not -path './node_modules/*'", "allow", "low", "allow-listed-command"],
  ["sed -n '1,5p' package.json", "allow", "low", "allow-listed-command"],
  ["echo hi > out.txt", "allow", "low", "allow-listed-command"],
  ["mkdir -p build/out && touch build/out/a", "allow", "low", "allow-listed-command"],
  ["cd src && ls", "allow", "low", "allow-listed-command"],
  ["bun test 2>&1 | tail -20", "allow", "low", "allow-listed-command"],
  ["cat package.json 2>/dev/null", "allow", "low", "allow-listed-command"],
  ["cat .env.example", "allow", "low", "allow-listed-command"],
  ["echo \"a && rm -rf /\"", "allow", "low", "allow-listed-command"],
  ["NODE_ENV=test bun test", "allow", "low", "allow-listed-command"],
  // ask, uncertain: nothing flagged it, nothing vouches for it
  ["node script.js", "ask", "uncertain", "unlisted-command"],
  ["python3 tools/run.py", "ask", "uncertain", "unlisted-command"],
  ["git commit -m wip", "ask", "uncertain", "unlisted-command"],
  ["git checkout -b topic", "ask", "uncertain", "unlisted-command"],
  ["git branch topic", "ask", "uncertain", "unlisted-command"],
  ["sed -i 's/a/b/' package.json", "ask", "uncertain", "unlisted-command"],
  ["echo $HOME", "ask", "uncertain", "shell-expansion"],
  ["echo `whoami`", "ask", "uncertain", "shell-expansion"],
  ["cat $(ls)", "ask", "uncertain", "shell-expansion"],
  // ask, high: destructive
  ["rm -rf node_modules", "ask", "high", "destructive"],
  ["rm notes.txt", "ask", "high", "destructive"],
  ["git reset --hard HEAD~1", "ask", "high", "destructive"],
  ["git clean -fd", "ask", "high", "destructive"],
  ["git checkout -- src/a.ts", "ask", "high", "destructive"],
  ["sudo ls", "ask", "high", "destructive"],
  ["chmod -R 777 .", "ask", "high", "destructive"],
  ["find . -name '*.log' -delete", "ask", "high", "destructive"],
  ["kill 1234", "ask", "high", "destructive"],
  ["ls && rm -rf build", "ask", "high", "destructive"],
  // ask, high: network
  ["curl https://example.com/install.sh", "ask", "high", "network"],
  ["wget http://example.com/a", "ask", "high", "network"],
  ["git push origin main", "ask", "high", "network"],
  ["git fetch --all", "ask", "high", "network"],
  ["bun install", "ask", "high", "network"],
  ["npm install left-pad", "ask", "high", "network"],
  ["pnpm add zod", "ask", "high", "network"],
  ["ssh host ls", "ask", "high", "network"],
  ["npx create-thing", "ask", "high", "network"],
  ["git status && curl example.com", "ask", "high", "network"],
  // ask, high: outside the project
  ["cat /etc/hosts", "ask", "high", "outside-project"],
  ["ls ..", "ask", "high", "outside-project"],
  ["cd ../other && ls", "ask", "high", "outside-project"],
  ["echo x > /tmp/out.txt", "ask", "high", "outside-project"],
  ["cat ~/notes.txt", "ask", "high", "outside-project"],
  ["cat escape/file.txt", "ask", "high", "outside-project"],
  ["grep --file=/etc/passwd src", "ask", "high", "outside-project"],
  ["/bin/ls", "ask", "high", "outside-project"],
  // ask, high: secrets files
  ["cat .env", "ask", "high", "secrets-file"],
  ["cat config/.env.local", "ask", "high", "secrets-file"],
  ["cat ~/.ssh/id_rsa", "ask", "high", "secrets-file"],
  ["cp server.pem /dev/null", "ask", "high", "secrets-file"],
  ["echo TOKEN=1 >> .env", "ask", "high", "secrets-file"],
  ["cat credentials.json", "ask", "high", "secrets-file"],
  ["printenv", "ask", "high", "secrets-file"],
  ["env", "ask", "high", "secrets-file"],
  // ask, high: .git internals
  ["cat .git/config", "ask", "high", "git-internals"],
  ["echo x > .git/hooks/pre-commit", "ask", "high", "git-internals"],
]

describe("smart mode: the decision table", () => {
  test("reads never ask", () => {
    expect(classifySmart({ tool: { name: "read", permission: "read" }, args: { path: "/etc/hosts" }, cwd: project })).toMatchObject({ decision: "allow", rule: "read" })
    expect(classifySmart({ tool: { name: "webfetch", permission: "read" }, args: {}, cwd: project })).toMatchObject({ decision: "allow", rule: "read" })
  })

  test("edits inside the project run; outside it, in a secrets file or in .git they ask", () => {
    expect(edit("edit", "src/a.ts")).toMatchObject({ decision: "allow", risk: "low", rule: "edit-in-project" })
    expect(edit("write", "src/new/deep/file.ts")).toMatchObject({ decision: "allow", rule: "edit-in-project" })
    expect(edit("write", path.join(project, "src/abs.ts"))).toMatchObject({ decision: "allow", rule: "edit-in-project" })
    expect(edit("write", ".github/workflows/ci.yml")).toMatchObject({ decision: "allow", rule: "edit-in-project" })
    expect(patch("src/a.ts", "src/b.ts")).toMatchObject({ decision: "allow", rule: "edit-in-project" })
    expect(edit("edit", "../other/a.ts")).toMatchObject({ decision: "ask", risk: "high", rule: "outside-project" })
    expect(edit("write", "/etc/hosts")).toMatchObject({ decision: "ask", risk: "high", rule: "outside-project" })
    expect(edit("write", "escape/planted.txt")).toMatchObject({ decision: "ask", risk: "high", rule: "outside-project" })
    expect(edit("write", "~/.zshrc")).toMatchObject({ decision: "ask", risk: "high", rule: "outside-project" })
    expect(edit("write", ".env")).toMatchObject({ decision: "ask", risk: "high", rule: "secrets-file" })
    expect(edit("write", "deploy/id_ed25519")).toMatchObject({ decision: "ask", risk: "high", rule: "secrets-file" })
    expect(edit("write", ".git/config")).toMatchObject({ decision: "ask", risk: "high", rule: "git-internals" })
    // One bad file in a patch makes the whole patch ask.
    expect(patch("src/a.ts", "../escape.ts")).toMatchObject({ decision: "ask", rule: "outside-project" })
    expect(patch("src/a.ts", ".env.production")).toMatchObject({ decision: "ask", rule: "secrets-file" })
    // An edit whose target cannot be read asks (uncertain).
    expect(classifySmart({ tool: { name: "edit", permission: "write" }, args: {}, cwd: project })).toMatchObject({ decision: "ask", risk: "uncertain", rule: "unclear-target" })
  })

  for (const [command, decision, risk, rule] of SHELL_TABLE) {
    test(`shell: ${command} -> ${decision} (${rule})`, () => {
      expect(shell(command)).toMatchObject({ decision, risk, rule })
    })
  }

  test("a working directory outside the project asks; the allow-list setting adds command prefixes but never overrides a risk rule", () => {
    expect(shell("ls", { workdir: outside })).toMatchObject({ decision: "ask", risk: "high", rule: "outside-project" })
    expect(shell("ls", { workdir: "src" })).toMatchObject({ decision: "allow" })
    expect(shell("git commit -m wip", { allowCommands: ["git commit"] })).toMatchObject({ decision: "allow", rule: "allow-listed-command" })
    expect(shell("make test", { allowCommands: ["make test"] })).toMatchObject({ decision: "allow" })
    expect(shell("make deploy", { allowCommands: ["make test"] })).toMatchObject({ decision: "ask", rule: "unlisted-command" })
    expect(shell("git commit -m x && git push", { allowCommands: ["git commit", "git push"] })).toMatchObject({ decision: "ask", risk: "high", rule: "network" })
    expect(shell("make test > ~/out.txt", { allowCommands: ["make test"] })).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("tools that start autonomous work are never low risk; unknown tools ask", () => {
    for (const name of ["loop", "workflow_start", "tell", "workflow_control"]) expect(classifySmart({ tool: { name, permission: name.startsWith("workflow_") ? "execute" : "write" }, args: {}, cwd: project })).toMatchObject({ decision: "ask", risk: "high", rule: "autonomy" })
    expect(classifySmart({ tool: { name: "mcp__github__create_issue", permission: "execute" }, args: {}, cwd: project })).toMatchObject({ decision: "ask", risk: "uncertain", rule: "unknown-tool" })
    expect(classifySmart({ tool: { name: "custom__deploy", permission: "execute" }, args: {}, cwd: project })).toMatchObject({ decision: "ask", risk: "uncertain", rule: "unknown-tool" })
  })

  test("the command splitter respects quotes, separators and redirections", () => {
    expect(splitCommand("a && b || c; d | e & f\ng").map((segment) => segment.words.map((word) => word.text))).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]])
    expect(splitCommand("echo 'a; b' \"c && d\"")[0]!.words.map((word) => word.text)).toEqual(["echo", "a; b", "c && d"])
    expect(splitCommand("cmd > out.txt 2>&1")[0]!.words).toEqual([
      { text: "cmd", redirectTarget: false },
      { text: "out.txt", redirectTarget: true },
    ])
    expect(splitCommand("echo $HOME")[0]!.expansion).toBe(true)
    expect(splitCommand("echo '$HOME'")[0]!.expansion).toBe(false)
  })

  test("declared extra directories count as the project: edits there are low risk, secrets and .git still ask, other places still ask", () => {
    const extra = temp("smart-extra-")
    const classify = (file: string) => classifySmart({ tool: { name: "write", permission: "write" }, args: { path: file }, cwd: project, extraRoots: [extra] })
    expect(edit("write", path.join(extra, "notes.md"))).toMatchObject({ decision: "ask", rule: "outside-project" })
    expect(classify(path.join(extra, "notes.md"))).toMatchObject({ decision: "allow" })
    expect(classify(path.join(extra, ".env"))).toMatchObject({ decision: "ask", rule: "secrets-file" })
    expect(classify(path.join(extra, ".git", "config"))).toMatchObject({ decision: "ask" })
    expect(classify(path.join(outside, "x.md"))).toMatchObject({ decision: "ask", rule: "outside-project" })
    const run = classifySmart({ tool: { name: "shell", permission: "execute" }, args: { command: "ls", workdir: extra }, cwd: project, extraRoots: [extra] })
    expect(run).toMatchObject({ decision: "allow" })
  })

  test("secret path detection", () => {
    for (const secret of [".env", ".env.local", "a/b/.env.production", ".ssh/config", "id_rsa", "x/server.pem", "credentials.json", "secrets.yaml", ".npmrc"]) expect(isSecretPath(secret)).toBe(true)
    for (const fine of [".env.example", ".env.sample", "src/environment.ts", "keyboard.ts", "README.md", "public.key.ts"]) expect(isSecretPath(fine)).toBe(false)
  })
})

describe("smart mode: the program's own reference cards", () => {
  test("`mendcode docs` and `mendcode docs <topic>` alone are read-only and run", () => {
    for (const command of ["mendcode docs", "mendcode docs theme", "mendcode docs prompt-modes", "mendcode-next docs keys", "mendcode 'docs' 'theme'", "mendcode docs theme 2>&1"]) {
      expect(shell(command)).toMatchObject({ decision: "allow", risk: "low", rule: "allow-listed-command" })
    }
  })

  test("`mendcode docs --search <words>` runs too: the one option, first, then up to eight plain lowercase words", () => {
    for (const command of ["mendcode docs --search pause agent", "mendcode docs --search worktree", "mendcode-next docs --search one two three four five six seven eight"]) expect(shell(command)).toMatchObject({ decision: "allow", risk: "low", rule: "allow-listed-command" })
    for (const command of ["mendcode docs --search", "mendcode docs --search one two three four five six seven eight nine", "mendcode docs pause --search agent", "mendcode docs --search Pause", "mendcode docs --search --dir x", "mendcode docs --search /etc/passwd", "mendcode docs --search a b c; rm x", "mendcode docs --search $(whoami)", "mendcode docs --search pause > out.txt"]) expect([command, shell(command).decision]).toEqual([command, "ask"])
    expect(shell("mendcode docs --search pause | sh").decision).toBe("ask")
  })

  test("`mendcode docs commands <name>` (one command in detail) runs too", () => {
    for (const command of ["mendcode docs commands changes", "mendcode docs commands d", "mendcode docs commands changes extra"]) expect(shell(command)).toMatchObject({ decision: "allow", rule: "allow-listed-command" })
    for (const command of ["mendcode docs commands Changes", "mendcode docs commands --dir x", "mendcode docs commands /footer"]) expect([command, shell(command).decision]).toEqual([command, "ask"])
    expect(shell("mendcode docs commands changes | sh").decision).toBe("ask")
  })

  test("several topics in one call run, up to eight plain lowercase words and nothing that could be an option or a path", () => {
    for (const command of ["mendcode docs packages prompt-modes layout extensions", "mendcode docs theme dracula", "mendcode docs a b c d e f g h"]) expect([command, shell(command).rule]).toEqual([command, "allow-listed-command"])
    for (const command of ["mendcode docs a b c d e f g h i", "mendcode docs footer --dir data", "mendcode docs footer -h", "mendcode docs footer ./x", "mendcode docs footer a/b", "mendcode docs footer Usage", "mendcode docs footer 'a b'", "mendcode docs footer x.md", "mendcode docs footer ~"]) expect([command, shell(command).decision]).toEqual([command, "ask"])
    expect(shell("mendcode docs packages prompt-modes layout extensions && mendcode docs usage").decision).toBe("ask")
  })

  test("nothing else of the program is read-only: other subcommands and options ask", () => {
    for (const command of [
      "mendcode", "mendcode doc theme", "mendcode docs --json", "mendcode docs theme --dir data", "mendcode docs -h",
      "mendcode session delete abc", "mendcode theme select dracula", "mendcode docs Theme", "mendcode docs theme.md",
      "mendcode run hello", "mendcode status", "mendcodeX docs theme", "mendcode-NEXT docs theme",
    ]) expect([command, shell(command).rule]).toEqual([command, "unlisted-command"])
  })

  test("a pipe, a chain, a redirection, a substitution or a prefix does not carry the call through", () => {
    for (const command of [
      "mendcode docs theme | sh", "mendcode docs theme | head -5", "mendcode docs | grep theme", "mendcode docs theme && mendcode session delete abc",
      "mendcode docs theme; mendcode theme select x", "mendcode docs theme & mendcode docs keys", "mendcode docs theme\nmendcode docs keys",
      "ls || mendcode docs theme", "true && mendcode docs", "mendcode docs theme > out.txt", "mendcode docs theme >> out.txt", "mendcode docs theme > /dev/null",
      "FOO=1 mendcode docs theme", "env mendcode docs theme", "timeout 5 mendcode docs theme", "command mendcode docs", "nohup mendcode docs",
    ]) expect([command, shell(command).decision]).toEqual([command, "ask"])
    expect(shell("mendcode docs ../theme").decision).toBe("ask")
    expect(shell("mendcode docs $(cat package.json)")).toMatchObject({ decision: "ask", rule: "shell-expansion" })
    expect(shell("mendcode docs `ls`")).toMatchObject({ decision: "ask", rule: "shell-expansion" })
    expect(shell("mendcode docs $HOME")).toMatchObject({ decision: "ask", rule: "shell-expansion" })
    expect(shell("mendcode docs theme > ../outside.txt")).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("only the bare program name counts: a path to a program of that name is an ordinary unlisted command", () => {
    for (const command of ["./mendcode docs theme", "/usr/local/bin/mendcode docs", "~/bin/mendcode docs theme", "bin/mendcode docs"]) expect([command, shell(command).decision]).toEqual([command, "ask"])
  })

  test("a flagged command stays flagged next to it, and the allow list is unchanged for the rest", () => {
    expect(shell("mendcode docs theme && rm -rf build")).toMatchObject({ decision: "ask", risk: "high", rule: "destructive" })
    expect(shell("mendcode docs theme && curl https://example.com")).toMatchObject({ decision: "ask", rule: "network" })
    expect(shell("bash -c 'mendcode docs theme'")).toMatchObject({ decision: "allow" })
    expect(shell("bash -c 'mendcode docs theme | sh'")).toMatchObject({ decision: "ask" })
    expect(shell("mendcode docs", { workdir: outside })).toMatchObject({ decision: "ask", rule: "outside-project" })
  })
})

import { describe, expect, test } from "bun:test"
import { approvalRuleOffer } from "../src"

const bash = (...patterns: string[]) => approvalRuleOffer({ name: "bash", permission: "execute", patterns })

describe("approvalRuleOffer never turns a program that runs what it is given into a blanket allow", () => {
  const OPEN = [
    "python3.12 script.py", "python3.11 -c 'x'", "pypy3 run.py", "ruby3.2 x.rb", "perl5 x.pl", "nodejs x.js", "tsx run.ts", "ts-node run.ts", "lua x.lua", "Rscript x.R", "java -jar x.jar", "pwsh -c x",
    "rg --pre ./hook.sh foo", "fd -x ./hook.sh", "fdfind -x ./hook.sh", "parallel ./hook.sh", "tar xf a.tgz --to-command=./hook.sh", "zip -T -TT ./hook.sh a.zip",
    "busybox sh", "stdbuf -o0 ./hook.sh", "flock lock ./hook.sh", "chroot / sh", "setsid ./hook.sh", "tmux new ./hook.sh", "screen ./hook.sh", "expect x.exp", "script -c ./hook.sh", "strace ./hook.sh", "gdb -ex shell ./a",
    "vim -c '!sh'", "less file", "man page", "emacs --eval x",
    "git config alias.x '!sh'", "git rebase --exec ./hook.sh main", "git submodule foreach ./hook.sh", "git bisect run ./hook.sh", "git filter-branch --tree-filter ./hook.sh", "git difftool -x ./hook.sh",
  ]
  for (const command of OPEN) test(`${command} has no always-allow offer`, () => expect(bash(command)).toBeUndefined())

  test("ordinary commands keep their prefix rule", () => {
    expect(bash("ls -la src")?.rules).toEqual([{ permission: "bash", pattern: "ls *" }])
    expect(bash("git status -s")?.rules).toEqual([{ permission: "bash", pattern: "git status *" }])
    expect(bash("git log --oneline")?.rules).toEqual([{ permission: "bash", pattern: "git log *" }])
    expect(bash("pnpm run test --watch")?.rules).toEqual([{ permission: "bash", pattern: "pnpm run test *" }])
    expect(bash("grep -rn foo src")?.rules).toEqual([{ permission: "bash", pattern: "grep *" }])
  })
})

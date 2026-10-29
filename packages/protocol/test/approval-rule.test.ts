import { describe, expect, test } from "bun:test"
import { approvalRuleOffer, Command, createIdFactory, withApprovalRules } from "../src"

const bash = (...patterns: string[]) => approvalRuleOffer({ name: "bash", permission: "execute", patterns })

describe("approvalRuleOffer", () => {
  test("a command becomes a prefix rule that keeps the subcommand", () => {
    expect(bash("git status -s")).toEqual({ label: "`git status *`", rules: [{ permission: "bash", pattern: "git status *" }] })
    expect(bash("ls -la src")?.rules).toEqual([{ permission: "bash", pattern: "ls *" }])
    expect(bash("pnpm run test --watch")?.rules).toEqual([{ permission: "bash", pattern: "pnpm run test *" }])
    expect(bash("bun test src/a.test.ts")?.rules).toEqual([{ permission: "bash", pattern: "bun test *" }])
  })

  test("a pipeline needs a prefix for every command and lists each once", () => {
    expect(bash("git log -5", "head -3")?.rules.map((rule) => rule.pattern)).toEqual(["git log *", "head *"])
    expect(bash("git log", "git log -1")?.rules.map((rule) => rule.pattern)).toEqual(["git log *"])
    expect(bash("git log", "rm -rf x")).toBeUndefined()
  })

  test("commands that run anything, flags before the subcommand and dynamic text offer nothing", () => {
    for (const command of ["sudo ls", "bash -c ls", "env FOO=1 ls", "node build.js", "python3 x.py", "rm x", "curl https://x.test", "find . -delete", "git -C other status", "git", "pnpm run", "FOO=1 ls", "echo $(whoami)", "echo `id`", "ls <(cat x)", "xargs rm"])
      expect(bash(command)).toBeUndefined()
    expect(bash()).toBeUndefined()
    expect(bash("a", "b", "c", "d", "e")).toBeUndefined()
  })

  test("a file-changing tool is allowed as a whole; commands, boundaries and loops never are", () => {
    expect(approvalRuleOffer({ name: "edit", permission: "write", patterns: ["/p/a.ts"] })).toEqual({ label: "edits", rules: [{ permission: "edit", pattern: "*" }] })
    expect(approvalRuleOffer({ name: "notebook", permission: "write", patterns: [] })?.rules).toEqual([{ permission: "notebook", pattern: "*" }])
    expect(approvalRuleOffer({ name: "browser", permission: "execute", patterns: ["navigate"] })).toBeUndefined()
    expect(approvalRuleOffer({ name: "external_directory", permission: "write", patterns: ["/etc"] })).toBeUndefined()
    expect(approvalRuleOffer({ name: "doom_loop", patterns: ["*"] })).toBeUndefined()
  })
})

describe("withApprovalRules", () => {
  const rules = [{ permission: "bash", pattern: "git status *" }]

  test("adds the allow rule last, in a new config or an existing one, without touching the input", () => {
    expect(withApprovalRules(undefined, rules)).toEqual({ bash: { "git status *": "allow" } })
    const current = { bash: { "git push *": "deny" as const }, edit: "ask" as const }
    expect(withApprovalRules(current, rules)).toEqual({ bash: { "git push *": "deny", "git status *": "allow" }, edit: "ask" })
    expect(current).toEqual({ bash: { "git push *": "deny" }, edit: "ask" })
  })

  test("keeps a blanket ask or the wildcard shorthand as the fallback", () => {
    expect(withApprovalRules({ bash: "ask" }, rules)).toEqual({ bash: { "*": "ask", "git status *": "allow" } })
    expect(withApprovalRules("ask", rules)).toEqual({ "*": "ask", bash: { "git status *": "allow" } })
  })

  test("a tool already allowed stays as it is; a repeated rule moves to the end", () => {
    expect(withApprovalRules({ bash: "allow" }, rules)).toEqual({ bash: "allow" })
    const moved = withApprovalRules({ bash: { "git status *": "allow", "ls *": "ask" } }, rules) as { bash: Record<string, string> }
    expect(Object.keys(moved.bash)).toEqual(["ls *", "git status *"])
    expect(withApprovalRules({ edit: "ask" }, [{ permission: "edit", pattern: "*" }])).toEqual({ edit: { "*": "allow" } })
  })
})

describe("request.resolve remember", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client"), type: "request.resolve", sessionId: ids("session"), requestId: ids("request") }
  test("is an optional addition to approve", () => {
    expect(Command.safeParse({ ...base, decision: { kind: "approve", scope: "once" } }).success).toBe(true)
    expect(Command.safeParse({ ...base, decision: { kind: "approve", scope: "once", remember: { level: "project" } } }).success).toBe(true)
    expect(Command.safeParse({ ...base, decision: { kind: "approve", scope: "once", remember: { level: "everyone" } } }).success).toBe(false)
    expect(Command.safeParse({ ...base, decision: { kind: "approve", scope: "once", remember: { level: "user", pattern: "*" } } }).success).toBe(false)
  })
})

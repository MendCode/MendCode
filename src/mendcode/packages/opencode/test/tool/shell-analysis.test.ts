import { beforeAll, describe, expect, test } from "bun:test"
import {
  analyzeShellCommand,
  createNativeFileActionFacts,
  isBoundedShellInspection,
} from "../../src/tool/shell-analysis"

import { Parser, Language } from "web-tree-sitter"
import { fileURLToPath } from "node:url"

let parser: Parser
beforeAll(async () => {
  await Parser.init({ locateFile: () => fileURLToPath(import.meta.resolve("web-tree-sitter/tree-sitter.wasm")) })
  parser = new Parser()
  parser.setLanguage(await Language.load(fileURLToPath(import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"))))
})

function analyze(input: Parameters<typeof analyzeShellCommand>[0]) {
  const tree = parser.parse(input.command)!
  try {
    return analyzeShellCommand({ ...input, root: tree.rootNode })
  } finally {
    tree.delete()
  }
}

describe("shell action facts", () => {
  test("preserves quoted Git patterns, revspecs and ordinary Unicode in the real AST", () => {
    const facts = analyze({
      command: "git ls-files '*AGENTS.md' '*openai*' && git log --oneline --left-right HEAD...origin/dev && cat 'diseño.txt'",
      cwd: "/workspace/project",
    })
    expect(facts.argvSegments).toEqual([
      ["git", "ls-files", "*AGENTS.md", "*openai*"],
      ["git", "log", "--oneline", "--left-right", "HEAD...origin/dev"],
      ["cat", "diseño.txt"],
    ])
    expect(facts.unknownReasons).not.toContain("invisible_or_non_ascii_control")
    expect(facts.unknownReasons).toContain("shell_execution_identity_unverified")
    expect(isBoundedShellInspection(facts)).toBe(false)
  })

  test.each([
    "sort -o output input", "find . -delete", "find . -exec helper {} \\;",
    "rg --pre helper pattern .", "sed -i.bak s/a/b/ input", "node", "python3 -v",
    "./git status", "git -c core.fsmonitor=helper status", "cat input > output",
    "cat $(helper)", "cat input & helper", "cat input && helper", "cat /dev/zero",
  ])("never infers safe execution from a binary name: %s", (command) => {
    expect(isBoundedShellInspection(analyze({ command, cwd: "/workspace/project" }))).toBe(false)
  })

  test("bounds AST traversal and rejects invisible direction controls", () => {
    const large = analyze({ command: Array(100).fill("cat input").join(" && "), cwd: "/workspace/project" })
    expect(large.unknownReasons).toContain("ast_budget_exceeded")
    expect(large.astNodes).toBeLessThanOrEqual(257)
    const bidi = analyze({ command: "cat '\u202Einput'", cwd: "/workspace/project" })
    expect(bidi.unknownReasons).toContain("invisible_or_non_ascii_control")
  })
  test("binds environment values without exposing them and ignores key order", () => {
    const withEnv = (environment: NodeJS.ProcessEnv) =>
      analyze({ command: "pwd", cwd: "/workspace/project", environment })
    const first = withEnv({ PATH: "/usr/bin", TOKEN: "secret-a" })
    const reordered = withEnv({ TOKEN: "secret-a", PATH: "/usr/bin" })
    const changed = withEnv({ PATH: "/usr/bin", TOKEN: "secret-b" })
    expect(first.fingerprint).toBe(reordered.fingerprint)
    expect(first.environmentDigest).not.toBe(changed.environmentDigest)
    expect(first.fingerprint).not.toBe(changed.fingerprint)
    expect(JSON.stringify(first)).not.toContain("secret-a")
  })
  test("keeps diagnostic commands manual until execution identities are proven", () => {
    const facts = analyze({
      command: "printf '%s\\n' ok && uname -a && command -v node && node --version",
      cwd: "/workspace/project",
      environment: { PATH: "/usr/bin", HOME: "/private/secret" },
    })

    expect(facts.kind).toBe("shell")
    expect(facts.analysisComplete).toBe(false)
    expect(isBoundedShellInspection(facts)).toBe(false)
    expect(facts.effects).toContain("execute")
    expect(facts.fingerprint).toHaveLength(64)
    expect(JSON.stringify(facts)).not.toContain("/private/secret")
  })

  test("fails closed for dynamic evaluation, unknown executables and oversized commands", () => {
    const dynamic = analyze({ command: 'grep "$(cat secret)" file', cwd: "/workspace/project" })
    const unknown = analyze({ command: "workspace-helper --check", cwd: "/workspace/project" })
    const oversized = analyze({ command: "printf x ".repeat(5000), cwd: "/workspace/project" })

    expect(dynamic.analysisComplete).toBe(false)
    expect(dynamic.unknownReasons).toContain("dynamic_shell_evaluation")
    expect(unknown.unknownReasons.some((reason) => reason.startsWith("unknown_executable:"))).toBe(true)
    expect(oversized.unknownReasons).toContain("command_too_large")
  })

  test("does not treat file redirection as a bounded read", () => {
    const redirect = analyze({ command: "cat input.txt > output.txt", cwd: "/workspace/project" })
    const stream = analyze({ command: "cat input.txt 2>&1 | head -20", cwd: "/workspace/project" })

    expect(redirect.analysisComplete).toBe(false)
    expect(redirect.unknownReasons.some((reason) => reason.startsWith("unsupported_shell_grammar:"))).toBe(true)
    expect(isBoundedShellInspection(redirect)).toBe(false)
    expect(stream.analysisComplete).toBe(false)
    expect(isBoundedShellInspection(stream)).toBe(false)
  })

  test("records native file content identities and makes deletion manual", () => {
    const update = createNativeFileActionFacts({
      operation: "update",
      cwd: "/workspace/project",
      sourcePaths: ["src/index.ts"],
      before: ["old"],
      after: ["new"],
    })
    const deletion = createNativeFileActionFacts({
      operation: "delete",
      cwd: "/workspace/project",
      sourcePaths: ["tmp.txt"],
    })

    expect(update.analysisComplete).toBe(true)
    expect(update.beforeDigest).not.toBe(update.afterDigest)
    expect(update.effects).toContain("write")
    expect(deletion.analysisComplete).toBe(false)
    expect(deletion.effects).toContain("delete")
  })
})

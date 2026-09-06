import { describe, expect, test } from "bun:test"
import {
  analyzeShellCommand,
  createNativeFileActionFacts,
  isBoundedShellInspection,
} from "../../src/tool/shell-analysis"

describe("shell action facts", () => {
  test("recognizes bounded diagnostics and fingerprints the effective input", () => {
    const facts = analyzeShellCommand({
      command: "printf '%s\\n' ok && uname -a && command -v node && node --version",
      cwd: "/workspace/project",
      environment: { PATH: "/usr/bin", HOME: "/private/secret" },
    })

    expect(facts.kind).toBe("shell")
    expect(facts.analysisComplete).toBe(true)
    expect(isBoundedShellInspection(facts)).toBe(true)
    expect(facts.effects).toContain("execute")
    expect(facts.fingerprint).toHaveLength(64)
    expect(JSON.stringify(facts)).not.toContain("/private/secret")
  })

  test("fails closed for dynamic evaluation, unknown executables and oversized commands", () => {
    const dynamic = analyzeShellCommand({ command: 'grep "$(cat secret)" file', cwd: "/workspace/project" })
    const unknown = analyzeShellCommand({ command: "workspace-helper --check", cwd: "/workspace/project" })
    const oversized = analyzeShellCommand({ command: "printf x ".repeat(5000), cwd: "/workspace/project" })

    expect(dynamic.analysisComplete).toBe(false)
    expect(dynamic.unknownReasons).toContain("dynamic_shell_evaluation")
    expect(unknown.unknownReasons.some((reason) => reason.startsWith("unknown_executable:"))).toBe(true)
    expect(oversized.unknownReasons).toContain("ast_budget_exceeded")
  })

  test("does not treat file redirection as a bounded read", () => {
    const redirect = analyzeShellCommand({ command: "cat input.txt > output.txt", cwd: "/workspace/project" })
    const stream = analyzeShellCommand({ command: "cat input.txt 2>&1 | head -20", cwd: "/workspace/project" })

    expect(redirect.analysisComplete).toBe(false)
    expect(redirect.unknownReasons).toContain("redirection_requires_review")
    expect(redirect.effects).toContain("write")
    expect(stream.analysisComplete).toBe(true)
    expect(isBoundedShellInspection(stream)).toBe(true)
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

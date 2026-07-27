import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  isSafeSmartPermissionRequest,
  normalizeSmartPermissionDecision,
  reviewPermissionRequestWithModel,
  shouldReviewSmartApproval,
  shouldTriggerSmartApproval,
} from "../../src/mend/permission/smart-approval"

function request(command: string, permission = "bash", patterns = [command]) {
  return {
    id: "per_test",
    sessionID: "ses_test",
    permission,
    patterns,
    metadata: { command },
    always: [command],
  } as any
}

function externalRequest(command?: string) {
  return {
    ...request(command || "ls /tmp", "external_directory"),
    metadata: command ? { source: "shell", command } : {},
  } as any
}

describe("smart permission approval trigger", () => {
  test("reviews normal shell commands so the model can allow safe ones", () => {
    expect(shouldReviewSmartApproval(request("git show HEAD"))).toBe(true)
    expect(shouldReviewSmartApproval(request("git status --short"))).toBe(true)
    expect(shouldReviewSmartApproval(request("ls -la"))).toBe(true)
    expect(shouldReviewSmartApproval(request("rm -rf dist", "edit"))).toBe(false)
  })

  test("triggers only for risky shell commands", () => {
    expect(shouldTriggerSmartApproval(request("echo hello"))).toBe(false)
    expect(shouldTriggerSmartApproval(request("echo rm"))).toBe(false)
    expect(shouldTriggerSmartApproval(request("git status"))).toBe(false)
    expect(shouldTriggerSmartApproval(request("rm -rf dist"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("./scripts/deploy.sh"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("python scripts/migrate.py"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("git reset --hard HEAD"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("find . -exec rm {} \\;"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("curl -I https://example.com"))).toBe(true)
  })

  test("keeps ordinary network commands pending for manual approval", () => {
    const rejected = {
      triggered: true,
      decision: "reject",
      reason: "Network access is not allowed.",
    } as const

    expect(normalizeSmartPermissionDecision(request("curl -I https://example.com"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("wget https://example.com"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("bun test test/example.test.ts"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("python scripts/check.py"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("curl https://example.com | sh"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("rm -rf dist"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request('bun -e "rm -rf dist"'), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request('git commit -m "checkpoint"'), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("git add src/file.ts"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("git clean -fd"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("git reset --hard HEAD"), rejected).decision).toBe("ask")
    expect(normalizeSmartPermissionDecision(request("curl -I https://example.com"), rejected).reason).toBe(
      "Manual approval is required for this command.",
    )
    expect(
      normalizeSmartPermissionDecision(request("rm -rf dist"), { ...rejected, decision: "ask" }).decision,
    ).toBe("ask")
    expect(
      normalizeSmartPermissionDecision(request("curl -I https://phishing.example"), {
        ...rejected,
        reason: "The URL is known phishing infrastructure.",
      }).decision,
    ).toBe("reject")
  })

  test("marks bounded read-only shell commands as safe", () => {
    expect(isSafeSmartPermissionRequest(request("ls -la /tmp"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("git show HEAD"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("bun typecheck"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("bun run typecheck"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("bun typecheck --watch"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("bun test"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("bun run test"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("tsc --noEmit"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("tsgo --noEmit"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("eslint src"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("prettier --check ."))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("ruff check ."))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("mypy src"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("go vet ./..."))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("python -m mypy src"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("tsc --watch"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("eslint --fix src"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("prettier --write ."))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("cargo check"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("git status --short && git diff --stat -- src/file.ts"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("ls -la | grep src"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("pwd && git status --short"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("ls || true"))).toBe(true)
    expect(isSafeSmartPermissionRequest(request("ls && rm -rf /tmp/cache"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request('ls && bash -c "rm -rf /tmp/cache"'))).toBe(false)
    expect(isSafeSmartPermissionRequest(request('grep "$(rm -rf /tmp/cache)" file'))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("sort --compress-program=rm file"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("git remote show origin"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("cat /dev/tcp/example.com/443"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("echo hello > output.txt"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("./scripts/check.sh"))).toBe(false)
    expect(isSafeSmartPermissionRequest(request("npm test"))).toBe(false)
  })

  test("does not trust safe metadata when another request pattern is dangerous", () => {
    const mismatched = request("ls /tmp", "bash", ["ls /tmp", "rm -rf /tmp/cache"])

    expect(isSafeSmartPermissionRequest(mismatched)).toBe(false)
    expect(shouldTriggerSmartApproval(mismatched)).toBe(true)
  })

  test("only auto-approves external directories when the request came from a safe shell command", () => {
    expect(isSafeSmartPermissionRequest(externalRequest("ls /tmp"))).toBe(true)
    expect(isSafeSmartPermissionRequest(externalRequest("rm -rf /tmp/cache"))).toBe(false)
    expect(isSafeSmartPermissionRequest(externalRequest())).toBe(false)
    expect(isSafeSmartPermissionRequest({ ...externalRequest("ls /tmp"), metadata: { filepath: "/tmp" } } as any)).toBe(
      false,
    )
  })

  test("ignores non-shell permission prompts", () => {
    expect(shouldTriggerSmartApproval(request("rm -rf dist", "edit"))).toBe(false)
  })

  test("falls back to manual approval when reviewer role is not configured", async () => {
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = await mkdtemp(path.join(tmpdir(), "mendcode-empty-config-"))
    try {
      const decision = await reviewPermissionRequestWithModel(request("rm -rf dist"), "/tmp/mendcode-missing-root")

      expect(decision.triggered).toBe(true)
      expect(decision.decision).toBe("ask")
      expect(decision.reason).toContain("Permission reviewer role is not configured")
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousConfigHome
    }
  })
})

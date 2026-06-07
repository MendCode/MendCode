import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { reviewPermissionRequestWithModel, shouldTriggerSmartApproval } from "../../src/mend/permission/smart-approval"

function request(command: string, permission = "bash") {
  return {
    id: "per_test",
    sessionID: "ses_test",
    permission,
    patterns: [command],
    metadata: { command },
    always: [command],
  } as any
}

describe("smart permission approval trigger", () => {
  test("triggers only for risky shell commands", () => {
    expect(shouldTriggerSmartApproval(request("echo hello"))).toBe(false)
    expect(shouldTriggerSmartApproval(request("rm -rf dist"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("./scripts/deploy.sh"))).toBe(true)
    expect(shouldTriggerSmartApproval(request("python scripts/migrate.py"))).toBe(true)
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

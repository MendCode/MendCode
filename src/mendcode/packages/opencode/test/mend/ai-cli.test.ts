import { describe, expect, test } from "bun:test"
import { controlPlaneRoutes } from "../../src/mend/cli/public-bin"
import { aiConfigRequest } from "../../src/mend/cli/ai-config-request"

describe("AI configuration CLI routing", () => {
  test("converts a real preview target descriptor into the API path and discards advisory fields", () => {
    const patch = { compaction: { strategy: "portable" } }
    const preview = { patch, target: { path: "/tmp/project/mendcode.jsonc", scope: "project" }, expectedHash: "a".repeat(64), alternatives: ["not-request-data"] }
    expect(aiConfigRequest("validate", preview, {})).toEqual({ patch, target: preview.target.path, scope: "project", expectedHash: preview.expectedHash })
    expect(aiConfigRequest("apply", preview, { scope: "global", target: "/tmp/global/mendcode.jsonc", expectedHash: "b".repeat(64), causalSessionID: "fixture" })).toEqual({
      patch, target: "/tmp/global/mendcode.jsonc", scope: "global", expectedHash: "b".repeat(64), causalSessionID: "fixture",
    })
    expect(aiConfigRequest("validate", patch, {})).toEqual({ patch })
    expect(() => aiConfigRequest("validate", [], {})).toThrow("JSON object")
  })
  test("routes every AI configuration action through the shared control plane", () => {
    for (const action of ["inspect", "plan", "validate", "apply"]) {
      expect(controlPlaneRoutes.ai!(["config", action, "--file", "preview.json"])).toEqual([
        "ai",
        "config",
        action,
        "--file",
        "preview.json",
      ])
    }
  })

  test("preserves apply scope, target, and digest arguments for the backend CAS check", () => {
    expect(
      controlPlaneRoutes.ai!([
        "config",
        "apply",
        "--file",
        "preview.json",
        "--scope",
        "project",
        "--target",
        "/tmp/project/mendcode.jsonc",
        "--expected-hash",
        "a".repeat(64),
      ]),
    ).toEqual([
      "ai",
      "config",
      "apply",
      "--file",
      "preview.json",
      "--scope",
      "project",
      "--target",
      "/tmp/project/mendcode.jsonc",
      "--expected-hash",
      "a".repeat(64),
    ])
  })
})

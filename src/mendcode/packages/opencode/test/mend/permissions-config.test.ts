import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { globalPermissionsConfigPath, readPermissionsConfig, writePermissionsConfig } from "../../src/mend/config/permissions"

describe("mend permissions config", () => {
  test("persists global default permission mode and reviewer role", async () => {
    await using tmp = await tmpdir()
    const configDir = path.join(tmp.path, "config")

    expect(await readPermissionsConfig(configDir)).toMatchObject({
      mode: "approval",
      reviewerRole: "permissionReviewer",
      trigger: "dangerous-shell",
    })

    const written = await writePermissionsConfig({ mode: "smart", reviewerRole: "small" }, configDir)
    expect(written.path).toBe(globalPermissionsConfigPath(configDir))
    expect(written.config).toMatchObject({ mode: "smart", reviewerRole: "small" })
    expect(await readPermissionsConfig(configDir)).toMatchObject({ mode: "smart", reviewerRole: "small" })

    const raw = JSON.parse(await readFile(globalPermissionsConfigPath(configDir), "utf8"))
    expect(raw).toMatchObject({ version: 0, mode: "smart", reviewerRole: "small" })
  })

  test("normalizes invalid mode to manual approval", async () => {
    await using tmp = await tmpdir()
    const configDir = path.join(tmp.path, "config")

    await writePermissionsConfig({ mode: "full_access" }, configDir)
    await writePermissionsConfig({ mode: "nope" as any }, configDir)

    expect(await readPermissionsConfig(configDir)).toMatchObject({ mode: "approval" })
  })
})

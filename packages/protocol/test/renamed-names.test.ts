import { describe, expect, test } from "bun:test"
import { createIdFactory, currentSettingKeys, parseCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client"), directory: "/p" }

describe("names renamed when packages became profiles", () => {
  test("a command of an older client (`packages.*`) is read as the current `profiles.*`", () => {
    const parsed = parseCommand({ ...base, type: "packages.list" })
    expect(parsed.success && parsed.data.type).toBe("profiles.list")
    const install = parseCommand({ ...base, type: "packages.install", source: "/x", scope: "user" })
    expect(install.success && install.data.type).toBe("profiles.install")
    expect(parseCommand({ ...base, type: "profiles.list" }).success).toBe(true)
    expect(parseCommand({ ...base, type: "packages.nope" }).success).toBe(false)
  })

  test("a settings.set patch with older names is written under the current ones", () => {
    const parsed = parseCommand({ id: base.id, clientId: base.clientId, type: "settings.set", patch: { disabledPackages: ["user:a"], disabledPackageResources: ["user:a/skills/b"], features: { package_tools: false, hooks: true } } })
    expect(parsed.success && parsed.data.type === "settings.set" && parsed.data.patch).toEqual({ disabledProfiles: ["user:a"], disabledProfileResources: ["user:a/skills/b"], features: { profile_tools: false, hooks: true } })
  })

  test("the current name wins when both are present, inside features and tools too", () => {
    expect(currentSettingKeys({ profiles: [1], areas: [2], tools: { packages: false }, features: { packages: true, profiles: false } })).toEqual({ areas: [2], tools: { profiles: false }, features: { profiles: false } })
  })
})

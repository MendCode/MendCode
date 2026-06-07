import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { readProviderAuthState, repairProviderAuthState } from "../../src/mend/runtime/auth-state"

describe("mend auth state compatibility", () => {
  test("falls back to legacy aggregated auth.json when provider file is missing", async () => {
    await using dir = await tmpdir()
    const providerID = "legacy-provider"
    const legacyFile = path.join(dir.path, ".mendcode", "data", "auth.json")
    await mkdir(path.dirname(legacyFile), { recursive: true })
    await writeFile(
      legacyFile,
      `${JSON.stringify({
        [providerID]: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 123,
          accountId: "acct_123",
        },
      }, null, 2)}\n`,
    )

    const state = await readProviderAuthState(dir.path, providerID)

    expect(state).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
    })
  })

  test("repairs provider auth file from legacy aggregated auth.json", async () => {
    await using dir = await tmpdir()
    const providerID = "legacy-provider"
    const legacyFile = path.join(dir.path, ".mendcode", "data", "auth.json")
    const modernFile = path.join(dir.path, ".mendcode", "auth", `${providerID}.json`)
    await mkdir(path.dirname(legacyFile), { recursive: true })
    await writeFile(
      legacyFile,
      `${JSON.stringify({
        [providerID]: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: 123,
          accountId: "acct_123",
        },
      }, null, 2)}\n`,
    )

    const result = await repairProviderAuthState(dir.path, providerID, { preferProject: true })
    const repaired = JSON.parse(await readFile(modernFile, "utf8"))

    expect(result.status).toBe("repaired")
    expect(repaired).toMatchObject({
      providerID,
      source: "legacy-auth-json-repair",
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      accountId: "acct_123",
    })
  })
})

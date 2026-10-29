import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { planLabel, readUsageProfile } from "../src/usage-profile"

const dirs: string[] = []
function authFile(content: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-profile-"))
  dirs.push(dir)
  const file = path.join(dir, "auth.json")
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
  return file
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

describe("usage profile", () => {
  test("name, email and plan come from the id_token claims; tokens are not returned", async () => {
    const file = authFile({ tokens: { id_token: jwt({ name: "Ada", email: "ada@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }), access_token: "secret" } })
    const profile = await readUsageProfile(file)
    expect(profile).toEqual({ name: "Ada", email: "ada@example.com", plan: "Pro" })
    expect(JSON.stringify(profile)).not.toContain("secret")
  })

  test("missing file, bad JSON, no id_token or a broken token give an empty profile", async () => {
    expect(await readUsageProfile(path.join(tmpdir(), "mend-no-such-dir", "auth.json"))).toEqual({})
    expect(await readUsageProfile(authFile("{not json"))).toEqual({})
    expect(await readUsageProfile(authFile({ tokens: {} }))).toEqual({})
    expect(await readUsageProfile(authFile({ tokens: { id_token: "not-a-jwt" } }))).toEqual({})
  })

  test("partial claims give a partial profile", async () => {
    expect(await readUsageProfile(authFile({ tokens: { id_token: jwt({ email: "a@b.c" }) } }))).toEqual({ email: "a@b.c" })
  })

  test("plan ids read as labels", () => {
    expect(planLabel("plus")).toBe("Plus")
    expect(planLabel("PRO")).toBe("Pro")
    expect(planLabel("prolite")).toBe("Prolite")
  })
})

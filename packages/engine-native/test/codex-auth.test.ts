import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { codexSubscriptionHeaders } from "../src"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function authFile(content: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-auth-"))
  dirs.push(dir)
  const file = path.join(dir, "auth.json")
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
  return file
}

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`
const NOW = 1_800_000_000_000

describe("Codex subscription headers", () => {
  test("a valid login yields bearer, account and originator headers", async () => {
    const token = jwt(NOW / 1_000 + 3_600)
    const headers = codexSubscriptionHeaders({ authFile: authFile({ tokens: { access_token: token, account_id: "acct" } }), now: () => NOW })
    expect(await headers()).toEqual({ authorization: `Bearer ${token}`, "chatgpt-account-id": "acct", originator: "mendcode" })
  })

  test("an expired token asks the user to refresh through Codex instead of refreshing itself", async () => {
    const headers = codexSubscriptionHeaders({ authFile: authFile({ tokens: { access_token: jwt(NOW / 1_000 - 10), account_id: "acct" } }), now: () => NOW })
    await expect(headers()).rejects.toThrow("Codex login expired")
  })

  test("missing file, API-key-only login and malformed JSON give actionable errors", async () => {
    await expect(codexSubscriptionHeaders({ authFile: "/nonexistent/auth.json" })()).rejects.toThrow("run `codex login`")
    await expect(codexSubscriptionHeaders({ authFile: authFile({ OPENAI_API_KEY: "k" }) })()).rejects.toThrow("no ChatGPT tokens")
    await expect(codexSubscriptionHeaders({ authFile: authFile("{not json") })()).rejects.toThrow("no Codex login found")
  })
})

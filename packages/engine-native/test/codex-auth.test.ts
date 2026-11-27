import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { codexSubscriptionHeaders, importedChatgptLogin } from "../src"

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

  test("an expired token asks for MendCode's own sign-in, never another tool", async () => {
    const headers = codexSubscriptionHeaders({ authFile: authFile({ tokens: { access_token: jwt(NOW / 1_000 - 10), account_id: "acct" } }), now: () => NOW })
    await expect(headers()).rejects.toThrow("ChatGPT sign-in expired (imported from another tool); sign in with /connect chatgpt again")
    await expect(headers()).rejects.not.toThrow("codex")
  })

  test("missing file, API-key-only login and malformed JSON all point to /connect chatgpt", async () => {
    await expect(codexSubscriptionHeaders({ authFile: "/nonexistent/auth.json" })()).rejects.toThrow("sign in with /connect chatgpt")
    await expect(codexSubscriptionHeaders({ authFile: authFile({ OPENAI_API_KEY: "k" }) })()).rejects.toThrow("no ChatGPT account; sign in with /connect chatgpt")
    await expect(codexSubscriptionHeaders({ authFile: authFile("{not json") })()).rejects.toThrow("not signed in to ChatGPT")
  })

  test("the imported login's state is reported without a token", () => {
    expect(importedChatgptLogin({ authFile: authFile({ tokens: { access_token: jwt(NOW / 1_000 + 3_600), account_id: "a" } }), now: () => NOW })).toEqual({ state: "valid", expiresAt: NOW + 3_600_000 })
    expect(importedChatgptLogin({ authFile: authFile({ tokens: { access_token: jwt(NOW / 1_000 - 10), account_id: "a" } }), now: () => NOW })?.state).toBe("expired")
    expect(importedChatgptLogin({ authFile: authFile({ OPENAI_API_KEY: "k" }) })).toBeUndefined()
    expect(importedChatgptLogin({ authFile: "/nonexistent/auth.json" })).toBeUndefined()
  })
})

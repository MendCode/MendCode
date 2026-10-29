import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMcpAuth } from "../src/oauth"
import { createAuthStore } from "../src/auth-store"

test("B83 submitted OAuth codes retain PKCE, are one-use and cannot save a cancelled exchange", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "b83-mcp-auth-"))
  const store = createAuthStore({ dir })
  let release!: (response: Response) => void, exchanging!: () => void
  const exchangeStarted = new Promise<void>((resolve) => { exchanging = resolve })
  const auth = createMcpAuth({ dir, store, startCallback: async () => {
    let settle!: (code: string) => void, reject!: (error: Error) => void, finished = false
    const done = new Promise<string>((resolve, fail) => { settle = resolve; reject = fail })
    done.catch(() => undefined)
    return { redirectUri: "http://127.0.0.1:19876/callback", done, complete(code) { if (finished) throw new Error("Already used"); finished = true; settle(code) }, close() { if (!finished) { finished = true; reject(new Error("Cancelled")) } } }
  }, fetch: async (url, init) => {
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.example.invalid", authorization_servers: ["https://auth.example.invalid"] })
    if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://auth.example.invalid", authorization_endpoint: "https://auth.example.invalid/authorize", token_endpoint: "https://auth.example.invalid/token" })
    expect(String(init?.body)).toContain("code_verifier=")
    exchanging()
    return new Promise<Response>((resolve) => { release = resolve })
  } })
  const url = "https://mcp.example.invalid"
  try {
    const flow = await auth.start({ serverName: "docs", serverUrl: url, oauth: { clientId: "fixture" } })
    expect(await auth.state(url)).toBe("pending")
    const completion = auth.complete!(url, "fixture-code")
    const rejected = completion.catch((error: Error) => error.message)
    await exchangeStarted
    await expect(auth.complete!(url, "fixture-code")).rejects.toThrow("Already used")
    auth.cancel(url)
    release(Response.json({ access_token: "fixture-access", expires_in: 3600 }))
    expect(await rejected).toContain("cancelled")
    await expect(flow.completion).rejects.toThrow("cancelled")
    expect(await store.get(url)).toBeUndefined()
    expect(await auth.state(url)).toBe("none")
    await expect(auth.complete!(url, "fixture-code")).rejects.toThrow("no pending")
  } finally { auth.cancel(url); rmSync(dir, { recursive: true, force: true }) }
})

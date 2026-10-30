import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { claudeStatus, codexStatus } from "../src/harness-status"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "harness-status-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fixed = (code: number, out: string) => {
  const calls: string[][] = []
  return { calls, run: async (argv: string[]) => { calls.push(argv); return { code, out } } }
}

describe("harness status", () => {
  test("Claude Code signed in: the method and plan it reports, never its email or organization", async () => {
    const fake = fixed(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.com", orgId: "org-1", orgName: "Acme", subscriptionType: "max" }))
    const status = await claudeStatus({ bin: "claude", run: fake.run })
    expect(status).toEqual({ id: "claude", installed: true, signedIn: true, method: "claude.ai", plan: "max" })
    expect(JSON.stringify(status)).not.toContain("example.com")
    expect(JSON.stringify(status)).not.toContain("Acme")
    expect(fake.calls[0]).toEqual(["claude", "auth", "status", "--json"])
  })

  test("a signed-out Claude Code is given its own official login; no profile of MendCode's is set", async () => {
    const status = await claudeStatus({ bin: "claude", run: fixed(1, JSON.stringify({ loggedIn: false, authMethod: "none" })).run })
    expect(status).toEqual({ id: "claude", installed: true, signedIn: false, login: "claude auth login" })
  })

  test("not installed, and an answer that is not the status JSON: installed with sign-in unknown, no plan invented", async () => {
    expect(await claudeStatus({ bin: "claude", run: async () => undefined })).toEqual({ id: "claude", installed: false })
    const odd = await claudeStatus({ bin: "claude", run: fixed(0, "Claude Code 1.0").run })
    expect(odd).toEqual({ id: "claude", installed: true, login: "claude auth login" })
    expect(odd.plan).toBeUndefined()
  })

  test("Codex CLI: signed in with ChatGPT, signed out, not installed", async () => {
    expect(await codexStatus({ bin: "codex", run: fixed(0, "Logged in using ChatGPT").run })).toEqual({ id: "codex", installed: true, signedIn: true, method: "chatgpt" })
    expect(await codexStatus({ bin: "codex", run: fixed(1, "Not logged in").run })).toEqual({ id: "codex", installed: true, signedIn: false, login: "codex login" })
    expect(await codexStatus({ bin: "codex", run: async () => undefined })).toEqual({ id: "codex", installed: false })
    expect(await codexStatus({ bin: path.join(temp(), "no-such-codex") })).toEqual({ id: "codex", installed: false })
  })

  test("a status printed on stderr is read (codex login status writes there)", async () => {
    const dir = temp()
    const fake = path.join(dir, "codex")
    await Bun.write(fake, "#!/bin/sh\necho 'Logged in using ChatGPT' >&2\n")
    await Bun.$`chmod +x ${fake}`
    expect(await codexStatus({ bin: fake })).toEqual({ id: "codex", installed: true, signedIn: true, method: "chatgpt" })
  })
})

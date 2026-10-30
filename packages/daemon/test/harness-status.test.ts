import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseClaudeProfile, runClaudeProfile } from "../src/claude-profile"
import { claudeProfileDir, claudeProfileEnv, claudeStatus, codexStatus } from "../src/harness-status"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "harness-status-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fixed = (code: number, out: string) => {
  const calls: Array<{ argv: string[]; env: Record<string, string> | undefined }> = []
  return { calls, run: async (argv: string[], env: Record<string, string> | undefined) => { calls.push({ argv, env }); return { code, out } } }
}

describe("harness status", () => {
  test("Claude Code signed in: the method and plan it reports, never its email or organization", async () => {
    const fake = fixed(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "someone@example.com", orgId: "org-1", orgName: "Acme", subscriptionType: "max" }))
    const status = await claudeStatus({ bin: "claude", ownLogins: false, dataDir: "/d", run: fake.run })
    expect(status).toEqual({ id: "claude", installed: true, signedIn: true, profile: "default", method: "claude.ai", plan: "max" })
    expect(JSON.stringify(status)).not.toContain("example.com")
    expect(JSON.stringify(status)).not.toContain("Acme")
    expect(fake.calls[0]).toEqual({ argv: ["claude", "auth", "status", "--json"], env: undefined })
  })

  test("ownLogins: Claude Code runs with MendCode's own profile, and a signed-out one is given the official login for that profile", async () => {
    const fake = fixed(1, JSON.stringify({ loggedIn: false, authMethod: "none" }))
    const status = await claudeStatus({ bin: "claude", ownLogins: true, dataDir: "/d", run: fake.run })
    expect(status).toEqual({ id: "claude", installed: true, signedIn: false, profile: "mendcode", login: "mendcode claude login --dir /d" })
    expect(fake.calls[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/d/claude-code" })
    expect(claudeProfileEnv({ ownLogins: undefined, dataDir: "/d" })).toBeUndefined()
    expect(claudeProfileDir("/d")).toBe("/d/claude-code")
  })

  test("not installed, and an answer that is not the status JSON: installed with sign-in unknown, no plan invented", async () => {
    expect(await claudeStatus({ bin: "claude", ownLogins: false, dataDir: "/d", run: async () => undefined })).toEqual({ id: "claude", installed: false, profile: "default" })
    const odd = await claudeStatus({ bin: "claude", ownLogins: false, dataDir: "/d", run: fixed(0, "Claude Code 1.0").run })
    expect(odd).toEqual({ id: "claude", installed: true, profile: "default", login: "claude auth login" })
    expect(odd.plan).toBeUndefined()
  })

  test("Codex CLI: signed in with ChatGPT, signed out, not installed", async () => {
    expect(await codexStatus({ bin: "codex", run: fixed(0, "Logged in using ChatGPT").run })).toEqual({ id: "codex", installed: true, signedIn: true, method: "chatgpt" })
    expect(await codexStatus({ bin: "codex", run: fixed(1, "Not logged in").run })).toEqual({ id: "codex", installed: true, signedIn: false, login: "codex login" })
    expect(await codexStatus({ bin: "codex", run: async () => undefined })).toEqual({ id: "codex", installed: false })
    expect(await codexStatus({ bin: path.join(temp(), "no-such-codex") })).toEqual({ id: "codex", installed: false })
  })

  // The real Claude Code, read-only: its documented CLAUDE_CONFIG_DIR keeps MendCode's profile apart from ~/.claude.
  test.if(Bun.which("claude") !== null && process.env.CI === undefined)("the installed Claude Code with MendCode's empty profile is not signed in, whatever ~/.claude holds", async () => {
    const dataDir = temp()
    const status = await claudeStatus({ bin: "claude", ownLogins: true, dataDir })
    expect(status).toMatchObject({ id: "claude", installed: true, signedIn: false, profile: "mendcode", login: `mendcode claude login --dir ${dataDir}` })
  })

  test("a status printed on stderr is read (codex login status writes there)", async () => {
    const dir = temp()
    const fake = path.join(dir, "codex")
    await Bun.write(fake, "#!/bin/sh\necho 'Logged in using ChatGPT' >&2\n")
    await Bun.$`chmod +x ${fake}`
    expect(await codexStatus({ bin: fake })).toEqual({ id: "codex", installed: true, signedIn: true, method: "chatgpt" })
  })
})

describe("mendcode claude login|status", () => {
  test("only login and status are taken, so a folder named claude still opens", () => {
    expect(parseClaudeProfile(["claude", "login", "--dir", "/d"])).toEqual({ action: "login", dir: "/d" })
    expect(parseClaudeProfile(["claude", "status"])).toEqual({ action: "status" })
    expect(parseClaudeProfile(["claude"])).toBeUndefined()
    expect(parseClaudeProfile(["claude", "src"])).toBeUndefined()
  })
  test("Claude Code's own auth command runs with MendCode's profile and nothing else changed", async () => {
    const dir = temp()
    const fake = path.join(dir, "claude")
    await Bun.write(fake, `#!/bin/sh\necho "$@ $CLAUDE_CONFIG_DIR" > ${path.join(dir, "ran")}\nexit 3\n`)
    await Bun.$`chmod +x ${fake}`
    const said: string[] = []
    expect(await runClaudeProfile({ action: "status", dataDir: dir, bin: fake, err: { write: (text) => { said.push(text) } } })).toBe(3)
    expect((await Bun.file(path.join(dir, "ran")).text()).trim()).toBe(`auth status --text ${path.join(dir, "claude-code")}`)
    expect(await runClaudeProfile({ action: "login", dataDir: dir, bin: path.join(dir, "missing"), err: { write: (text) => { said.push(text) } } })).toBe(127)
    expect(said.join("")).toContain("your own ~/.claude login is not touched")
    expect(said.join("")).toContain("Claude Code is not installed")
  })
})

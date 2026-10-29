import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENT_SHELL_ENV } from "@mendcode/protocol/wire"
import { guardClient, originCapabilities, shownCommand, startedBySession } from "../src/agent-origin"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcev-p-cli-origin-")))
  dirs.push(dir)
  return dir
}
const main = path.join(import.meta.dir, "../src/main.ts")

describe("this program, started from a session's own shell", () => {
  test("the mark applies to the daemon the session runs under, by real path, and to no other data directory", () => {
    const root = temp()
    const link = path.join(root, "link")
    symlinkSync(root, link)
    expect(startedBySession({ env: { [AGENT_SHELL_ENV]: root }, dir: root })).toBe(true)
    expect(startedBySession({ env: { [AGENT_SHELL_ENV]: root }, dir: link })).toBe(true)
    expect(startedBySession({ env: { [AGENT_SHELL_ENV]: root }, dir: path.join(root, "other") })).toBe(false)
    expect(startedBySession({ env: {}, dir: root })).toBe(false)
    expect(originCapabilities({ env: { [AGENT_SHELL_ENV]: root }, dir: root, limit: undefined })).toEqual(["origin:agent"])
    expect(originCapabilities({ env: {}, dir: root, limit: 4096 })).toEqual(["limit:4096"])
    expect(originCapabilities({ env: {}, dir: root, limit: undefined })).toEqual([])
  })

  test("what only the user decides is answered locally; reads and session work are sent", async () => {
    const sent: string[] = []
    const client = guardClient({ send: async (command: { type: string }) => { sent.push(command.type); return { ok: true as const } } }, ["control-plane", "permissions", "set-default", "full"])
    const send = client.send as unknown as (command: Record<string, unknown>) => Promise<{ ok: boolean; error?: { code: string; message: string } }>
    const refused = await send({ type: "permissions.set-default", mode: "full" })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("forbidden")
    expect(refused.error?.message).toContain("refused: `mendcode control-plane permissions set-default full`")
    expect(refused.error?.message).toContain("their own terminal")
    expect((await send({ type: "settings.set", patch: {} })).ok).toBe(false)
    expect((await send({ type: "daemon.shutdown" })).ok).toBe(false)
    // Importing a picture as a pet reads a path the caller chooses and writes the user's pet store: not a session's to do.
    const imported = await send({ type: "pet.manage", input: { action: "import", path: "/tmp/character.png" } })
    expect([imported.ok, imported.error?.code]).toEqual([false, "forbidden"])
    expect((await send({ type: "request.resolve", decision: { kind: "approve", scope: "once" } })).ok).toBe(false)
    expect(sent).toEqual([])
    expect((await send({ type: "settings.get" })).ok).toBe(true)
    expect((await send({ type: "user.submit" })).ok).toBe(true)
    expect((await send({ type: "request.resolve", decision: { kind: "deny" } })).ok).toBe(true)
    expect(sent).toEqual(["settings.get", "user.submit", "request.resolve"])
  })

  test("the command shown to the user is quoted and never repeats a token", () => {
    expect(shownCommand(["run", "do it now", "--model", "a/b"])).toBe("mendcode run 'do it now' --model a/b")
    expect(shownCommand(["github", "run", "--token", "ghp_secret"])).toBe("mendcode github run --token …")
  })

  const cli = (args: string[], env: Record<string, string | undefined>) => {
    const result = Bun.spawnSync([process.execPath, main, ...args], { env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  test("commands that never reach a daemon refuse too; reading and another data directory do not", () => {
    const own = temp()
    const other = temp()
    const marked = { [AGENT_SHELL_ENV]: own, MENDCODE_V2_DIR: own }

    const token = cli(["remote", "token", "create", "--dir", own, "--name", "x"], marked)
    expect(token.code).toBe(1)
    expect(token.err).toContain("refused:")
    expect(token.err).toContain("remote access")
    expect(existsSync(path.join(own, "remote-tokens.json"))).toBe(false)
    expect(cli(["remote", "token", "list", "--dir", own], marked).code).toBe(0)

    // Against a throwaway data directory the same command is the session's own business.
    const elsewhere = cli(["remote", "token", "create", "--dir", other, "--name", "x"], marked)
    expect(elsewhere.code).toBe(0)
    expect(existsSync(path.join(other, "remote-tokens.json"))).toBe(true)

    // The user's terminal: no mark, no refusal.
    expect(cli(["remote", "token", "create", "--dir", own, "--name", "x"], { [AGENT_SHELL_ENV]: undefined, MENDCODE_V2_DIR: own }).code).toBe(0)

    for (const args of [["daemon", "stop", "--dir", own], ["daemon", "service", "install", "--dir", own], ["serve", "--dir", own], ["--dir", own, "--restart-daemon"],["run", "--dir", own, "--approve", "hello"], ["run", "--dir", own, "--dangerously-skip-permissions", "hello"]]) {
      const result = cli(args, marked)
      expect(`${args.join(" ")} → ${result.code}`).toBe(`${args.join(" ")} → 1`)
      expect(result.err).toContain("refused:")
    }
    expect(existsSync(path.join(own, "mendd.sock"))).toBe(false)

    // Replacing or removing the installation is refused whatever data directory is named; looking is not.
    expect(cli(["upgrade", "--dir", other], marked).err).toContain("replaces the installed program")
    expect(cli(["uninstall", "--force", "--dir", other], marked).err).toContain("removes this installation")
    expect(cli(["--dir", other, "update", "--inspect", "--json"], marked).code).toBe(0)
  }, 60_000)
})

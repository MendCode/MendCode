import { describe, expect, test } from "bun:test"
import path from "node:path"
import { isMigrateCommand, MIGRATE_EXIT, parseMigrateArgs } from "@mendcode/migrate"

const cli = path.join(import.meta.dir, "..")

describe("migrate-v1 routing", () => {
  test("the arg parser recognises the subcommand with its documented flags", () => {
    const argv = ["migrate-v1", "--from", "/old/v1", "--dir", "/tmp/v2", "--dry-run", "--since", "2026-01-01", "--no-memories", "--json"]
    expect(isMigrateCommand(argv)).toBe(true)
    expect(parseMigrateArgs(argv)).toMatchObject({ ok: true, command: { from: "/old/v1", dir: "/tmp/v2", dryRun: true, memories: false, json: true } })
  })

  test("--dir has no default: without it the parse fails with a usage error", () => {
    const parsed = parseMigrateArgs(["migrate-v1", "--from", "/old/v1"])
    expect(parsed.ok).toBe(false)
    expect(MIGRATE_EXIT.usage).toBe(64)
  })

  test("other subcommands are not migrate-v1", () => {
    expect(isMigrateCommand(["upgrade", "--dir", "/tmp/v2"])).toBe(false)
    expect(isMigrateCommand(["session", "list"])).toBe(false)
  })

  test("main.ts routes it like `upgrade`: lazy import, right after that block and before any daemon connection", async () => {
    const source = await Bun.file(path.join(cli, "src/main.ts")).text()
    const upgrade = source.indexOf('argv.includes("upgrade")')
    const migrate = source.indexOf('argv.includes("migrate-v1") ? await import("@mendcode/migrate")')
    const daemon = source.indexOf("const daemonOptions")
    expect(upgrade).toBeGreaterThan(0)
    expect(migrate).toBeGreaterThan(upgrade)
    expect(daemon).toBeGreaterThan(migrate)
    expect(source).not.toMatch(/^import [^\n]*"@mendcode\/migrate"/m)
    const block = source.slice(migrate, daemon)
    expect(block).toContain("process.exit(")
    expect(block).not.toMatch(/fetch\(|Bun\.spawn|ensureDaemon|createClient/)
  })

  test("@mendcode/migrate stays out of the terminal client's startup module graph", () => {
    const script = `await import("./src/ui/app"); await import("@mendcode/client"); await import("./src/ui/screen");
console.log(JSON.stringify(Object.keys(require.cache).filter((k) => k.includes("/packages/migrate/")).length))`
    const result = Bun.spawnSync(["bun", "-e", script], { cwd: cli, stdout: "pipe", stderr: "pipe" })
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.stdout.toString().trim())).toBe(0)
  })
})

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { commandOwnsStartupMigration } from "../../src/storage/startup-migration"

test("maintenance CLI leaves an unmigrated database and legacy marker untouched", async () => {
  const base = path.join(process.env.XDG_DATA_HOME!, "readonly-upgrade")
  const db = path.join(base, "share", "mendcode.db")
  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", "src/index.ts", "upgrade", "channel"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, MENDCODE_DB: db, OPENCODE_DB: db,
      XDG_DATA_HOME: path.join(base, "share"), XDG_CONFIG_HOME: path.join(base, "config"),
      XDG_STATE_HOME: path.join(base, "state"), XDG_CACHE_HOME: path.join(base, "cache"),
      HOME: path.join(base, "home"), OPENCODE_TEST_HOME: path.join(base, "home"),
    },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stdout + stderr).toContain("Release channel: stable")
    expect(stderr).not.toContain("sqlite-migration")
    expect(existsSync(db)).toBe(false)
    expect(existsSync(path.join(base, "share", "mendcode", ".mendcode-json-storage-migration-v0.done"))).toBe(false)
  } finally { clearTimeout(timer) }
}, 20_000)

test("TUI clients defer migration to the backend; backend and local data commands retain migration", () => {
  for (const command of [undefined, "attach", "upgrade", "models", "providers", "run", "stats"]) {
    expect(commandOwnsStartupMigration(command)).toBe(false)
  }
  for (const command of ["serve", "import", "export", "session"]) {
    expect(commandOwnsStartupMigration(command)).toBe(true)
  }
})

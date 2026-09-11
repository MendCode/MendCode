import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

describe("server shutdown process boundary", () => {
  for (const channel of ["beta", "latest"]) {
    for (const stalled of [false, true]) {
      test(`${channel}: ${stalled ? "stalled" : "successful"} cleanup exits and permits the next database writer`, async () => {
        await using tmp = await tmpdir()
        const database = path.join(tmp.path, "sessions.db")
        const receipt = path.join(tmp.path, "server.json")
        const source = `
          import { Database } from "bun:sqlite"
          import { writeFileSync, renameSync } from "node:fs"
          import { createShutdown } from ${JSON.stringify(new URL("../../../src/cli/cmd/serve-shutdown.ts", import.meta.url).href)}
          const db = new Database(process.env.MENDCODE_DB)
          db.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY, value TEXT); INSERT INTO session VALUES('saved', 'keep');")
          db.exec("BEGIN IMMEDIATE; UPDATE session SET value='uncommitted';")
          writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
          // A leftover background timer must not keep a closed server alive.
          setInterval(() => {}, 1000)
          await createShutdown({
            stopListener: () => ${stalled ? "new Promise(() => {})" : "Promise.resolve()"},
            disposeInstances: async () => {},
            closeDatabase: () => { db.exec("ROLLBACK"); db.close() },
            clearState: async () => { renameSync(${JSON.stringify(receipt)}, ${JSON.stringify(receipt + ".released")}) },
            shutdownTimeoutMs: 25,
            exit: (code) => process.exit(code),
          })()
        `
        const child = Bun.spawn([process.execPath, "--eval", source], {
          cwd: tmp.path,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: tmp.path,
            USERPROFILE: tmp.path,
            XDG_DATA_HOME: path.join(tmp.path, "data"),
            XDG_CONFIG_HOME: path.join(tmp.path, "config"),
            XDG_STATE_HOME: path.join(tmp.path, "state"),
            XDG_CACHE_HOME: path.join(tmp.path, "cache"),
            OPENCODE_TEST_HOME: tmp.path,
            MENDCODE_DB: database,
            OPENCODE_DB: database,
            MENDCODE_CHANNEL: channel,
            OPENCODE_CHANNEL: channel,
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const code = await Promise.race([
            child.exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("server remained alive after shutdown")), 5000)
            }),
          ])
          const stderr = await new Response(child.stderr).text()
          expect(stderr).toBe("")
          expect(code).toBe(stalled ? 1 : 0)
          expect(await Bun.file(receipt).exists()).toBe(stalled)
          expect(await Bun.file(receipt + ".released").exists()).toBe(!stalled)
          const next = new Database(database)
          try {
            expect(next.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
            expect(next.query("SELECT value FROM session WHERE id='saved'").get()).toEqual({ value: "keep" })
            next.exec("BEGIN IMMEDIATE; INSERT INTO session VALUES('next', 'ok'); COMMIT;")
            expect(next.query("SELECT count(*) AS count FROM session").get()).toEqual({ count: 2 })
          } finally {
            next.close()
          }
        } finally {
          if (timer) clearTimeout(timer)
          if (child.exitCode === null) child.kill()
          await child.exited
        }
      })
    }
  }
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "node:os"
import {
  legacyChannelDbPath,
  mendChannelDbPath,
  resolveDefaultSqliteDbPath,
  resolveDualReadDbPathFromLayout,
} from "@/storage/resolve-default-sqlite-path"

describe("resolve-default-sqlite-path", () => {
  test("dual-read prefers mend when both exist", () => {
    const base = path.join(tmpdir(), `mend-sqlite-test-${Date.now()}`)
    mkdirSync(base, { recursive: true })
    try {
      const legacy = legacyChannelDbPath(base, "local", false)
      const mend = mendChannelDbPath(base, "local", false)
      writeFileSync(legacy, "")
      writeFileSync(mend, "")
      expect(resolveDualReadDbPathFromLayout(base, "local", false)).toBe(mend)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("dual-read falls back to legacy when mend missing", () => {
    const base = path.join(tmpdir(), `mend-sqlite-test-${Date.now()}`)
    mkdirSync(base, { recursive: true })
    try {
      const legacy = legacyChannelDbPath(base, "dev", false)
      writeFileSync(legacy, "")
      expect(resolveDualReadDbPathFromLayout(base, "dev", false)).toBe(legacy)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("OPENCODE_DB relative joins dataDir", () => {
    const base = "/tmp/x"
    expect(
      resolveDefaultSqliteDbPath({
        dataDir: base,
        installationChannel: "local",
        disableChannelDb: false,
        opencodeDb: "custom.db",
      }),
    ).toBe(path.join(base, "custom.db"))
  })

  test("OPENCODE_DB absolute passthrough", () => {
    const abs = path.join(path.sep, "var", "db", "x.sqlite")
    expect(
      resolveDefaultSqliteDbPath({
        dataDir: "/tmp",
        installationChannel: "local",
        disableChannelDb: false,
        opencodeDb: abs,
      }),
    ).toBe(abs)
  })
})

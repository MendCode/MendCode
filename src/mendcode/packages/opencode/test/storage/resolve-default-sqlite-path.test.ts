import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "node:os"
import {
  assertTestSqliteIsolation,
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

  test("dual-read keeps the MendCode local database when a compiled channel changes", () => {
    const base = path.join(tmpdir(), `mend-sqlite-test-${Date.now()}`)
    mkdirSync(base, { recursive: true })
    try {
      const localMend = mendChannelDbPath(base, "local", false)
      const legacyLatest = legacyChannelDbPath(base, "latest", false)
      writeFileSync(localMend, "")
      writeFileSync(legacyLatest, "")
      expect(resolveDualReadDbPathFromLayout(base, "latest", false)).toBe(localMend)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("dual-read falls back to base legacy db before creating an empty channel db", () => {
    const base = path.join(tmpdir(), `mend-sqlite-test-${Date.now()}`)
    mkdirSync(base, { recursive: true })
    try {
      const baseLegacy = path.join(base, "opencode.db")
      writeFileSync(baseLegacy, "")
      expect(resolveDualReadDbPathFromLayout(base, "local", false)).toBe(baseLegacy)
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

  test("test isolation rejects a user database outside temporary roots", () => {
    expect(() =>
      assertTestSqliteIsolation({
        dbPath: path.join(path.sep, "Users", "person", ".mendcode", "data", "mendcode-local.db"),
        nodeEnv: "test",
        allowedRoots: [path.join(path.sep, "tmp", "mendcode-tests")],
      }),
    ).toThrow("Refusing to use non-isolated SQLite database during tests")
  })

  test("test isolation allows memory and temporary databases", () => {
    expect(() =>
      assertTestSqliteIsolation({
        dbPath: ":memory:",
        nodeEnv: "test",
        allowedRoots: [],
      }),
    ).not.toThrow()
    expect(() =>
      assertTestSqliteIsolation({
        dbPath: path.join(tmpdir(), "mendcode-tests", "test.db"),
        nodeEnv: "test",
        allowedRoots: [tmpdir()],
      }),
    ).not.toThrow()
  })
})

import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdir, readFile, stat, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { activateMflow, deactivateMflow, enforceMflowBeforeEdit, mflowControlStatus, mflowEditTargets, mflowLocalRelayGuide, mflowReadTargets, readMflowConfig, releaseMflowLocks, waitMflowBeforeRead } from "../../src/mend/config/mflow"

async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

describe("mflow MendCode integration", () => {
  test("defaults disabled config to local-first relay", async () => {
    await using tmp = await tmpdir()

    await expect(readMflowConfig(tmp.path)).resolves.toMatchObject({
      enabled: false,
      relayMode: "local",
      signaling: "ws://localhost:8787",
    })
  })

  test("requires explicit acceptance before using the legacy public relay", async () => {
    await using tmp = await tmpdir()

    await expect(activateMflow({
      relayMode: "legacy-public",
      room: "test-room",
      publicRelayNoticeAccepted: false,
    }, tmp.path, { sync: false })).rejects.toThrow("Legacy public mflow relay is a shared demo-only service")
  })

  test("writes activation config, pnpm MCP config, hook scaffold, and runtime config", async () => {
    await using tmp = await tmpdir()

    const status = await activateMflow({
      relayMode: "local",
      signaling: "ws://localhost:8787",
      room: "test-room",
      secret: "local-test-secret",
      generateSecret: false,
      storeSecret: true,
      hookPriority: 4,
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    expect(["enabled-stopped", "running"]).toContain(status.mode)
    expect(await readMflowConfig(tmp.path)).toMatchObject({
      enabled: true,
      relayMode: "local",
      signaling: "ws://localhost:8787",
      room: "test-room",
      storeSecret: true,
      hookPriority: 4,
    })

    const mcp = JSON.parse(await readFile(path.join(tmp.path, ".mendcode/mcp/mflow.json"), "utf8"))
    expect(mcp).toMatchObject({
      type: "local",
      enabled: true,
      command: ["pnpm", "dlx", "--package", "mflow-cli", "mflow-mcp", "--root", tmp.path],
    })
    expect(await exists(path.join(tmp.path, ".mendcode/plugins/mflow-lock.js"))).toBe(true)
    expect(await readFile(path.join(tmp.path, ".mflow/config.toml"), "utf8")).toContain('secret = "local-test-secret"')
    expect(await readFile(path.join(tmp.path, ".mflowignore"), "utf8")).toContain(".mendcode/cache")
  })

  test("deactivates without deleting local mflow files", async () => {
    await using tmp = await tmpdir()

    await activateMflow({
      relayMode: "custom",
      signaling: "wss://relay.example.test",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    const status = await deactivateMflow(tmp.path, { sync: false })

    expect(status.mode).toBe("disabled")
    expect(await readMflowConfig(tmp.path)).toMatchObject({ enabled: false, signaling: "wss://relay.example.test" })
    expect(await exists(path.join(tmp.path, ".mflow/config.toml"))).toBe(true)
    expect(JSON.parse(await readFile(path.join(tmp.path, ".mendcode/mcp/mflow.json"), "utf8"))).toMatchObject({ enabled: false })
  })

  test("does not check daemon or remote locks when mflow is disabled", async () => {
    await using tmp = await tmpdir()

    const status = await mflowControlStatus(tmp.path)

    expect(status.mode).toBe("disabled")
    expect(status.daemon.checked).toBe(false)
    expect(status.daemon.running).toBe(false)
    expect(status.daemon.output).toContain("not checked")
    expect(status.locks.checked).toBe(false)
    expect(status.locks.output).toContain("not checked")
  })

  test("extracts edit targets and keeps external paths explicit", () => {
    const root = "/tmp/mend-mflow-root"
    const outside = "/tmp/outside.ts"

    expect(mflowEditTargets("edit", { filePath: "src/app.ts" }, root)).toEqual(["src/app.ts"])
    expect(mflowReadTargets("read", { filePath: "src/app.ts" }, root)).toEqual(["src/app.ts"])
    expect(mflowEditTargets("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/app.ts",
        "*** Add File: docs/mflow.md",
        "*** End Patch",
      ].join("\n"),
    }, root)).toEqual(["src/app.ts", "docs/mflow.md"])
    expect(mflowEditTargets("write", { path: "../outside.ts" }, root)).toEqual([outside])
    expect(mflowReadTargets("read", { path: "../outside.ts" }, root)).toEqual([outside])
  })

  test("validates public relay URLs", async () => {
    await using tmp = await tmpdir()

    await expect(activateMflow({
      relayMode: "public",
      signaling: "ftp://relay.example.test",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })).rejects.toThrow("must start with ws://, wss://, http://, or https://")
  })

  test("normalizes https public relay URLs to websocket URLs", async () => {
    await using tmp = await tmpdir()

    await activateMflow({
      relayMode: "public",
      signaling: "https://relay.example.test",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    await expect(readMflowConfig(tmp.path)).resolves.toMatchObject({
      relayMode: "public",
      signaling: "wss://relay.example.test",
    })
  })

  test("exposes local relay guide with pnpm MCP command", async () => {
    await using tmp = await tmpdir()

    expect(mflowLocalRelayGuide(tmp.path)).toMatchObject({
      recommendedUrl: "ws://localhost:8787",
      mcpCommand: ["pnpm", "dlx", "--package", "mflow-cli", "mflow-mcp", "--root", tmp.path],
    })
  })

  test("waits for a local edit lock lease before acquiring", async () => {
    await using tmp = await tmpdir()
    const file = "shared-test.md"
    const lockDir = path.join(tmp.path, ".mendcode/mflow/edit-locks")

    await activateMflow({
      relayMode: "local",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    const lockName = createHash("sha256").update(file).digest("hex")
    await mkdir(path.join(lockDir, `${lockName}.lock`), { recursive: true })
    await writeFile(path.join(lockDir, `${lockName}.lock`, "owner.json"), JSON.stringify({
      file,
      owner: "other-agent",
      expiresAt: Date.now() + 1_000,
    }))

    const waits: Array<{ file: string; remainingMs: number }> = []
    const started = Date.now()
    const lock = await enforceMflowBeforeEdit({
      tool: "edit",
      args: { filePath: file },
      root: tmp.path,
      onWait: (wait) => {
        waits.push({ file: wait.file, remainingMs: wait.remainingMs })
      },
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(lock.locked).toEqual([file])
    expect(waits.length).toBeGreaterThan(0)
    expect(waits[0]?.file).toBe(file)

    await releaseMflowLocks({ root: tmp.path, files: lock.locked, owner: lock.owner })
  })

  test("keeps local edit locks visible as a short lease after the owning tool call", async () => {
    await using tmp = await tmpdir()
    await activateMflow({
      relayMode: "local",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    const file = "owned.md"
    const lockName = createHash("sha256").update(file).digest("hex")
    const lockPath = path.join(tmp.path, ".mendcode/mflow/edit-locks", `${lockName}.lock`)
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      file,
      owner: "owner-1",
      expiresAt: Date.now() + 60_000,
    }))

    await releaseMflowLocks({ root: tmp.path, files: [file], owner: "owner-1" })

    expect(await exists(lockPath)).toBe(true)
    const current = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"))
    expect(current.owner).toBe("owner-1")
    expect(current.expiresAt).toBeGreaterThan(Date.now())
  })

  test("waits before reading a file locked by another local writer", async () => {
    await using tmp = await tmpdir()
    await activateMflow({
      relayMode: "local",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    const file = "read-after-write.md"
    const lockName = createHash("sha256").update(file).digest("hex")
    const lockPath = path.join(tmp.path, ".mendcode/mflow/edit-locks", `${lockName}.lock`)
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      file,
      owner: "other-agent",
      expiresAt: Date.now() + 1_000,
    }))

    const waits: Array<{ file: string; remainingMs: number }> = []
    const started = Date.now()
    const read = await waitMflowBeforeRead({
      tool: "read",
      args: { filePath: file },
      root: tmp.path,
      onWait: (wait) => {
        waits.push({ file: wait.file, remainingMs: wait.remainingMs })
      },
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(read.waited).toEqual([file])
    expect(waits.length).toBeGreaterThan(0)
    expect(waits[0]?.file).toBe(file)
  })

  test("does not wait before reading its own local edit lease", async () => {
    await using tmp = await tmpdir()
    await activateMflow({
      relayMode: "local",
      room: "test-room",
      publicRelayNoticeAccepted: true,
    }, tmp.path, { sync: false })

    const file = "own-read.md"
    const lockName = createHash("sha256").update(file).digest("hex")
    const lockPath = path.join(tmp.path, ".mendcode/mflow/edit-locks", `${lockName}.lock`)
    await mkdir(lockPath, { recursive: true })
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      file,
      owner: `pid:${process.pid}`,
      expiresAt: Date.now() + 30_000,
    }))

    const started = Date.now()
    const read = await waitMflowBeforeRead({
      tool: "read",
      args: { filePath: file },
      root: tmp.path,
    })

    expect(Date.now() - started).toBeLessThan(500)
    expect(read.waited).toEqual([file])
  })
})

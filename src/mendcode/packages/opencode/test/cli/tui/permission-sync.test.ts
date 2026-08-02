import { describe, expect, test } from "bun:test"
import {
  isTransientPermissionSyncError,
  sessionPermissionModeSynced,
  syncPermissionModeWithRetry,
} from "@/cli/cmd/tui/util/permission-sync"

const permissionName = "__mendcode_session_permission_mode__"

describe("permission mode sync", () => {
  test("recognizes transient socket failures", () => {
    expect(isTransientPermissionSyncError(new Error("The socket connection was closed unexpectedly"))).toBe(true)
    expect(isTransientPermissionSyncError(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))).toBe(true)
    expect(isTransientPermissionSyncError(new Error("permission payload is invalid"))).toBe(false)
  })

  test("uses the last session mode rule when reconciling", () => {
    expect(
      sessionPermissionModeSynced(
        [
          { permission: permissionName, pattern: "approval", action: "allow" },
          { permission: permissionName, pattern: "smart", action: "allow" },
        ],
        permissionName,
        "smart",
      ),
    ).toBe(true)
    expect(
      sessionPermissionModeSynced(
        [
          { permission: permissionName, pattern: "smart", action: "allow" },
          { permission: permissionName, pattern: "approval", action: "allow" },
        ],
        permissionName,
        "smart",
      ),
    ).toBe(false)
  })

  test("reconciles a socket failure without duplicating the write", async () => {
    let reads = 0
    let writes = 0
    const result = await syncPermissionModeWithRetry({
      mode: "smart",
      permissionName,
      signal: new AbortController().signal,
      retryDelaysMs: [0],
      read: async () => {
        reads++
        return [{ permission: permissionName, pattern: "smart", action: "allow" }]
      },
      write: async () => {
        writes++
        throw new Error("The socket connection was closed unexpectedly")
      },
    })

    expect(result).toBe(true)
    expect(reads).toBe(1)
    expect(writes).toBe(1)
  })

  test("stops after the bounded retry budget", async () => {
    let writes = 0
    await expect(
      syncPermissionModeWithRetry({
        mode: "smart",
        permissionName,
        signal: new AbortController().signal,
        retryDelaysMs: [0, 0],
        read: async () => undefined,
        write: async () => {
          writes++
          throw new Error("The socket connection was closed unexpectedly")
        },
      }),
    ).rejects.toThrow("socket connection")

    expect(writes).toBe(3)
  })
})

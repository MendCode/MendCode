import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@mendcode/core/global"
import { InstallationChannel } from "@mendcode/core/installation/version"
import { Database } from "@/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
      ? path.join(Global.Path.data, "opencode.db")
      : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })

  test("mend primary path mirrors legacy naming with mendcode basename", () => {
    const legacy = Database.getChannelPath()
    const mend = Database.getMendChannelPath()
    expect(path.dirname(mend)).toBe(path.dirname(legacy))
    expect(path.basename(mend)).toBe(path.basename(legacy).replace(/^opencode/, "mendcode"))
  })
})

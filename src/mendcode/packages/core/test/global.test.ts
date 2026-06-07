import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@mendcode/core/global"
import { resolveActiveAppSegment } from "@mendcode/core/global-layout"

describe("global paths", () => {
  test("tmp path matches resolved app segment", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), resolveActiveAppSegment()))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})

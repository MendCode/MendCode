import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@mendcode/core/flag/flag"
import * as Log from "@mendcode/core/util/log"
import { Server } from "../../src/server/server"
import { MemoryPaths } from "../../src/server/routes/instance/httpapi/groups/memory"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app(experimental: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("memory side chat route", () => {
  test("serves side chat through legacy and Effect HttpApi backends without 500", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }
    const body = JSON.stringify({ root: tmp.path, message: "hi", history: [], context: {} })

    for (const experimental of [false, true]) {
      const response = await app(experimental).request(
        `${MemoryPaths.sideChat}?directory=${encodeURIComponent(tmp.path)}`,
        { method: "POST", headers, body },
      )
      expect(response.status).toBe(200)
      const json = await response.json() as { text?: string; actions?: unknown[] }
      expect(json.text).toContain("memory side chat model not configured")
      expect(json.actions).toEqual([])
    }
  })
})

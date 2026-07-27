import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { InstanceMiddleware } from "../../src/server/routes/instance/middleware"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { isGlobalDreamBackgroundServiceRunning, stopGlobalDreamBackgroundService } from "../../src/mend/memory/dream-scheduler"
import { writeGlobalMemoryConfig } from "../../src/mend/memory/config"

// These regressions cover the legacy instance-loading paths fixed by PRs
// #25389 and #25449. The plugin config hook writes a marker file, and the test
// bodies deliberately avoid touching Plugin or config directly. The marker only
// exists if InstanceBootstrap ran at the instance boundary.

const originalMemoryDir = process.env.MENDCODE_MEMORY_DIR

afterEach(async () => {
  stopGlobalDreamBackgroundService()
  if (originalMemoryDir === undefined) delete process.env.MENDCODE_MEMORY_DIR
  else process.env.MENDCODE_MEMORY_DIR = originalMemoryDir
  await disposeAllInstances()
})

async function bootstrapFixture() {
  return tmpdir({
    init: async (dir) => {
      const marker = path.join(dir, "config-hook-fired")
      const pluginFile = path.join(dir, "plugin.ts")
      process.env.MENDCODE_MEMORY_DIR = path.join(dir, "global-memory")
      await Bun.write(
        pluginFile,
        [
          `const MARKER = ${JSON.stringify(marker)}`,
          "export default async () => ({",
          "  config: async () => {",
          '    await Bun.write(MARKER, "ran")',
          "  },",
          "})",
          "",
        ].join("\n"),
      )
      await Bun.write(
        path.join(dir, "mendcode.json"),
        JSON.stringify({
          $schema: "https://mendcode.ai/config.json",
          plugin: [pathToFileURL(pluginFile).href],
        }),
      )
      return marker
    },
  })
}

test("Instance.provide runs InstanceBootstrap before fn (boundary invariant)", async () => {
  await using tmp = await bootstrapFixture()

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => "ok",
  })

  expect(existsSync(tmp.extra)).toBe(true)
})

test("InstanceBootstrap starts global Dream background service", async () => {
  await using tmp = await bootstrapFixture()
  await writeGlobalMemoryConfig({ dreamWindow: { enabled: true, start: "00:00", end: "23:59" } }, tmp.path)

  expect(isGlobalDreamBackgroundServiceRunning()).toBe(false)
  const first = await cliBootstrap(tmp.path, async () => isGlobalDreamBackgroundServiceRunning())
  const second = await cliBootstrap(tmp.path, async () => isGlobalDreamBackgroundServiceRunning())

  expect(first).toBe(true)
  expect(second).toBe(true)
  expect(isGlobalDreamBackgroundServiceRunning()).toBe(true)
})

test("CLI bootstrap runs InstanceBootstrap before callback", async () => {
  await using tmp = await bootstrapFixture()

  await cliBootstrap(tmp.path, async () => "ok")

  expect(existsSync(tmp.extra)).toBe(true)
})

test("legacy Hono instance middleware runs InstanceBootstrap before next handler", async () => {
  await using tmp = await bootstrapFixture()
  const app = new Hono().use(InstanceMiddleware()).get("/probe", (c) => c.text("ok"))

  const response = await app.request("/probe", { headers: { "x-opencode-directory": tmp.path } })

  expect(response.status).toBe(200)
  expect(existsSync(tmp.extra)).toBe(true)
})

test("InstanceRuntime.reloadInstance runs InstanceBootstrap", async () => {
  await using tmp = await bootstrapFixture()

  await InstanceRuntime.reloadInstance({ directory: tmp.path })

  expect(existsSync(tmp.extra)).toBe(true)
})

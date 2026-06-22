import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"
import * as Log from "@mendcode/core/util/log"
import { tmpdir } from "../fixture/fixture"

const log = Global.Path.log

afterEach(() => {
  Global.Path.log = log
})

async function files(dir: string) {
  let last = ""
  let same = 0

  for (let i = 0; i < 50; i++) {
    const list = (await fs.readdir(dir)).sort()
    const next = JSON.stringify(list)
    same = next === last ? same + 1 : 0
    if (same >= 2 && list.length === 11) return list
    last = next
    await Bun.sleep(10)
  }

  return (await fs.readdir(dir)).sort()
}

test("init cleanup keeps the newest timestamped logs", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)

  await Promise.all(list.map((file) => fs.writeFile(path.join(tmp.path, file), file)))

  await Log.init({ print: false, dev: false })

  const next = await files(tmp.path)

  expect(next).not.toContain(list[0]!)
  expect(next).toContain(list.at(-1)!)
})

test("file logs stop at the configured byte cap", async () => {
  await using tmp = await tmpdir()
  const previous = process.env.MENDCODE_LOG_MAX_BYTES
  process.env.MENDCODE_LOG_MAX_BYTES = "512"
  Global.Path.log = tmp.path
  try {
    await Log.init({ print: false, dev: true, level: "INFO" })
    const logger = Log.create({ service: `log-cap-${Date.now()}` })
    for (let i = 0; i < 20; i++) logger.info("x".repeat(80), { i })
    await Bun.sleep(50)

    const file = path.join(tmp.path, "dev.log")
    const stat = await fs.stat(file)
    const text = await fs.readFile(file, "utf8")
    expect(stat.size).toBeLessThanOrEqual(512)
    expect(text).not.toContain("i=19")
  } finally {
    if (previous === undefined) delete process.env.MENDCODE_LOG_MAX_BYTES
    else process.env.MENDCODE_LOG_MAX_BYTES = previous
  }
})

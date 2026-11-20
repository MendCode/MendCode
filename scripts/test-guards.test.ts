import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { rssLimitBytes } from "./test-memory-guard"
import { MAX_FILES_PER_PROCESS, testFileCount, wholeSuite } from "./test-scope-guard"

const root = path.resolve(import.meta.dir, "..")

describe("test process guards", () => {
  test("a workspace's whole test directory is more than one process takes; a few named files are not", () => {
    expect(testFileCount(["./test"], path.join(root, "apps/cli"))).toBeGreaterThan(MAX_FILES_PER_PROCESS)
    expect(testFileCount(["./test/chat-chrome.test.ts", "./test/sticky-prompt.test.ts"], path.join(root, "apps/cli"))).toBe(2)
    expect(testFileCount(["--timeout", "20000", "./test/chat-chrome.test.ts"], path.join(root, "apps/cli"))).toBe(1)
    expect(wholeSuite([])).toBe(true)
    expect(wholeSuite(["./test/chat-chrome.test.ts"])).toBe(false)
  })

  test("the memory bound is 8 GB unless set; 0 turns it off", () => {
    expect(rssLimitBytes({})).toBe(8 * 1024 ** 3)
    expect(rssLimitBytes({ MENDCODE_TEST_RSS_GB: "12" })).toBe(12 * 1024 ** 3)
    expect(rssLimitBytes({ MENDCODE_TEST_RSS_GB: "0" })).toBeUndefined()
  })

  test("every workspace with tests preloads the same guards as the root (bun reads only the bunfig.toml where a run starts)", () => {
    const rootPreload = /preload = \[([^\]]*)\]/.exec(readFileSync(path.join(root, "bunfig.toml"), "utf8"))![1]!.match(/scripts\/[\w-]+\.ts/g)
    for (const group of ["apps", "packages"]) {
      for (const name of readdirSync(path.join(root, group))) {
        const dir = path.join(root, group, name)
        if (!existsSync(path.join(dir, "test"))) continue
        const config = path.join(dir, "bunfig.toml")
        expect(existsSync(config)).toBe(true)
        expect(/preload = \[([^\]]*)\]/.exec(readFileSync(config, "utf8"))?.[1]?.match(/scripts\/[\w-]+\.ts/g)).toEqual(rootPreload)
      }
    }
  })
})

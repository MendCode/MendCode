import { afterEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { tempDir, REPO } from "../packages/upgrade/test/helpers"
import { releaseIndex } from "./release-index"
import { validateReleaseIndex } from "../packages/upgrade/src/release-index"
import { sha256Hex } from "../packages/upgrade/src/checksum"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
test("B40 release pipeline index binds reproducible schema and exact artifact bytes", () => {
  const tmp = tempDir()
  cleanups.push(tmp.cleanup)
  const asset = "mendcode-0.0.1-nightly.20261001.10-linux-x64"
  const bytes = new TextEncoder().encode("local release fixture")
  writeFileSync(path.join(tmp.dir, asset), bytes)
  const index = releaseIndex({ tag: "v0.0.1-nightly.20261001.10", repository: REPO, directory: tmp.dir })
  expect(index.channel).toBe("nightly")
  expect(index.schema.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(index).toEqual(releaseIndex({ tag: index.tag, repository: REPO, directory: tmp.dir }))
  expect(validateReleaseIndex(index, { repo: REPO, tag: index.tag, channel: "nightly", asset, sha256: sha256Hex(bytes), size: bytes.byteLength }).assets).toHaveLength(1)
})

import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "../fixture/fixture"
import { pendingUpdate, trackUpdateStartup, latestUpdateStartup, latestUpdateOperation } from "../../src/installation/startup"

async function installed(root: string) {
  const executable = path.join(root, "mendcode")
  const operation = path.join(root, ".update.fixture")
  await fs.mkdir(operation)
  await fs.writeFile(executable, "verified candidate")
  const digest = createHash("sha256").update("verified candidate").digest("hex")
  await fs.writeFile(path.join(operation, "status"), `version=0.1.44\nphase=activated\nbinary_sha256=${digest}\n`)
  return executable
}

test("backend preparation does not consume the client readiness deadline", async () => {
  await using tmp = await tmpdir()
  const attempt = (await trackUpdateStartup({ executable: await installed(tmp.path), version: "0.1.44", timeoutMs: 20 }))!
  try {
    attempt.preparing()
    await Bun.sleep(60)
    expect(JSON.parse(await fs.readFile(attempt.file, "utf8")).state).toBe("starting")
    attempt.connecting()
    await Bun.sleep(60)
    expect(JSON.parse(await fs.readFile(attempt.file, "utf8")).state).toBe("failed")
  } finally { await attempt.close() }
})

test("deferred installer failures remain visible even when the previous executable is still installed", async () => {
  await using tmp = await tmpdir()
  const executable = await installed(tmp.path)
  const status = path.join(tmp.path, ".update.fixture", "status")
  await fs.writeFile(status, "version=0.1.45\r\nphase=waiting-for-restart\r\nexit_code=1\r\n")
  expect(await latestUpdateOperation(executable)).toMatchObject({ version: "0.1.45", phase: "waiting-for-restart", failed: true, file: status })
  expect(await pendingUpdate(executable, "0.1.44")).toBeUndefined()
})

test("readiness records are bound to the installed executable and release", async () => {
  await using tmp = await tmpdir()
  const executable = await installed(tmp.path)
  expect(await pendingUpdate(executable, "0.1.43")).toBeUndefined()
  expect(await pendingUpdate(executable, "0.1.44")).toBeDefined()
  await fs.writeFile(executable, "other candidate")
  expect(await pendingUpdate(executable, "0.1.44")).toBeUndefined()
})

test("only explicit client readiness changes a startup from starting to ready", async () => {
  await using tmp = await tmpdir()
  const executable = await installed(tmp.path)
  const journal = [{ name: "baseline", timestamp: 1, hash: "a".repeat(64) }]
  const attempt = (await trackUpdateStartup({ executable, version: "0.1.44", journal }))!
  try {
    expect(JSON.parse(await fs.readFile(attempt.file, "utf8")).state).toBe("starting")
    const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(attempt.file), "compatibility.json"), "utf8"))
    expect(metadata).toMatchObject({ formatVersion: 1, version: "0.1.44", journal,
      digest: createHash("sha256").update("verified candidate").digest("hex") })
    await attempt.ready()
    await attempt.close()
    expect(JSON.parse(await fs.readFile(attempt.file, "utf8")).state).toBe("ready")
    expect((await latestUpdateStartup(executable, "0.1.44"))?.state).toBe("ready")
  } finally { await attempt.close() }
})

test("a startup deadline is durable and preserves the failure reason on exit", async () => {
  await using tmp = await tmpdir()
  const executable = await installed(tmp.path)
  const attempt = (await trackUpdateStartup({ executable, version: "0.1.44", timeoutMs: 5 }))!
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    await attempt.close()
    const result = JSON.parse(await fs.readFile(attempt.file, "utf8"))
    expect(result.state).toBe("failed")
    expect(result.error).toContain("startup deadline")
  } finally { await attempt.close() }
})

test("a second terminal failure does not overwrite a ready client's record", async () => {
  await using tmp = await tmpdir()
  const executable = await installed(tmp.path)
  const first = (await trackUpdateStartup({ executable, version: "0.1.44" }))!
  const second = (await trackUpdateStartup({ executable, version: "0.1.44" }))!
  try {
    await first.ready()
    await second.close("Client disconnected")
    expect(first.file).not.toBe(second.file)
    expect(JSON.parse(await fs.readFile(first.file, "utf8")).state).toBe("ready")
    expect(JSON.parse(await fs.readFile(second.file, "utf8")).state).toBe("failed")
  } finally { await first.close(); await second.close() }
})

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { APP_NAME, BUNDLE_ID, appPath, ensureApp, launchApp, removeOldHelpers } from "../src/computer-app"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temporary = () => { const dir = mkdtempSync(path.join(tmpdir(), "mc-app-")); dirs.push(dir); return dir }

test("the loose helper folders of earlier versions are removed and nothing else", async () => {
  const dir = temporary()
  for (const name of ["2e922fb96e97f60ce491", "829af27215580e29e412", "keep-me", "0123"]) mkdirSync(path.join(dir, "computer-native", name), { recursive: true })
  expect((await removeOldHelpers(dir)).sort()).toEqual(["2e922fb96e97f60ce491", "829af27215580e29e412"])
  expect(existsSync(path.join(dir, "computer-native", "keep-me"))).toBe(true)
  expect(existsSync(path.join(dir, "computer-native", "0123"))).toBe(true)
})

// Compiles the real helper (about 40 s) and opens it through LaunchServices; it only answers `ping`, which never asks for a permission.
test.skipIf(process.platform !== "darwin")("the helper is one named app with a fixed identity, opened as its own process, and a rebuild keeps its path", async () => {
  const dir = temporary()
  const abort = new AbortController()
  const binary = await ensureApp(dir, abort.signal)
  const app = appPath(dir)
  expect(path.basename(app)).toBe(`${APP_NAME}.app`)
  expect(binary.startsWith(app)).toBe(true)
  const details = Bun.spawnSync(["/usr/bin/codesign", "-d", "-r-", "-vv", app])
  const text = details.stdout.toString() + details.stderr.toString()
  expect(text).toContain(`Identifier=${BUNDLE_ID}`)
  expect(text).toContain(`designated => identifier "${BUNDLE_ID}"`)
  expect(Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", app]).exitCode).toBe(0)
  const modified = Bun.file(binary).lastModified
  expect(await ensureApp(dir, abort.signal)).toBe(binary)
  expect(Bun.file(binary).lastModified).toBe(modified)
  const link = await launchApp(binary, dir, abort.signal)
  try {
    expect(link.alive()).toBe(true)
    await link.write(JSON.stringify({ method: "ping" }) + "\n")
    const answer = await link.reader.read()
    expect(JSON.parse(new TextDecoder().decode(answer.value))).toMatchObject({ ok: true, value: { trusted: expect.any(Boolean) } })
  } finally {
    link.end()
    link.kill("SIGTERM")
    await link.exited
  }
  expect(link.alive()).toBe(false)
}, 180_000)

test("making the computer control builds and opens nothing until a tool runs", async () => {
  const { createComputerControl } = await import("../src/computer")
  const dir = temporary()
  const control = createComputerControl({ hasSession: () => true } as never, dir, { enabled: true, platform: "darwin" })
  control.port("s" as never)
  await Bun.sleep(100)
  expect(existsSync(path.join(dir, `${APP_NAME}.app`))).toBe(false)
  expect(existsSync(path.join(dir, "computer-native"))).toBe(false)
  control.stop()
})

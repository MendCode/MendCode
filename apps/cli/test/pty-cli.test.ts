import { afterEach, expect, test } from "bun:test"
import { HTTP_USAGE, parseServerCommand } from "../src/http-cli"
import { textWidth } from "../src/view/wrap"
import { ptyChatHarness } from "./b89-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)
test("serve/web PTY requires explicit opt-in and supports disabling configured PTY", () => {
  expect(parseServerCommand(["serve", "--dir", "/tmp/server"])?.pty).toBeUndefined()
  expect(parseServerCommand(["serve", "--dir", "/tmp/server", "--pty"])?.pty).toBe(true)
  expect(parseServerCommand(["web", "--dir", "/tmp/server", "--pty", "--no-pty"])?.pty).toBe(false)
  expect(HTTP_USAGE).toContain("--pty (opt-in)")
  expect(() => parseServerCommand(["serve", "--dir", "/tmp/server", "--pty=true"])).toThrow("takes no value")
})

for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) test(`PTY API host keeps remote chat readable and never starts PTY from the terminal at ${width}×${height}`, async () => {
  const h = await ptyChatHarness(width!, height!)
  try {
    h.resize()
    h.app.render()
    expect(h.text()).toHaveLength(height!)
    expect(h.text().every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
    expect(h.sent.some((command) => command.type.startsWith("pty."))).toBe(false)
    expect(h.fake.processes[0]!.sizes).toEqual([[width!, height!]])
  } finally { h.close(); await h.app.onKey("\x03") }
})

test("PTY client and CLI startup keep zod/daemon/native PTY out of the terminal graph", () => {
  const script = 'await import("./apps/cli/src/ui/app"); await import("@mendcode/client"); await import("./apps/cli/src/http-cli"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ schemas: keys.filter(k => /protocol\\/src\\/(pty|commands|events|queries|frames)\\.ts$/.test(k)).length, zod: keys.filter(k => k.includes("/zod/")).length, daemon: keys.filter(k => k.includes("/packages/daemon/")).length }))'
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: new URL("../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual({ schemas: 0, zod: 0, daemon: 0 })
})

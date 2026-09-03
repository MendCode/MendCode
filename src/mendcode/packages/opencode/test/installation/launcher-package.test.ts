import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"

const root = path.join(import.meta.dirname, "../..")

describe("published MendCode launcher", () => {
  test("uses the MendCode platform package and binary names emitted by the build", async () => {
    const [launcher, postinstall, build] = await Promise.all([
      readFile(path.join(root, "bin/opencode"), "utf8"),
      readFile(path.join(root, "script/postinstall.mjs"), "utf8"),
      readFile(path.join(root, "script/build.ts"), "utf8"),
    ])

    expect(build).toContain('const binaryName = "mendcode"')
    expect(launcher).toContain('const base = "mendcode-" + platform + "-" + arch')
    expect(launcher).toContain('const binary = platform === "windows" ? "mendcode.exe" : "mendcode"')
    expect(postinstall).toContain("const packageName = `mendcode-${platform}-${arch}`")
    expect(postinstall).toContain('const binaryName = platform === "windows" ? "mendcode.exe" : "mendcode"')
  })

  test("honors the MendCode binary override", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, path.join(root, "bin/opencode"), "-e", 'process.stdout.write("override-ok")'],
      env: { ...process.env, MENDCODE_BIN_PATH: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("override-ok")
  })
})

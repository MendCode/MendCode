import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ghProcess } from "../src/pr-watch"
import { completeToolPath, knownToolDirs, loginShellPath, mergePath, parseShellPath } from "../src/tool-path"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tool-path-"))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

describe("the daemon's PATH", () => {
  test("folders it lacks are appended after its own, in order, once; empty and relative entries are dropped", () => {
    expect(mergePath("/home/u/.local/bin:/usr/bin:/bin", ["/opt/homebrew/bin", "/usr/bin", "bin", ""])).toBe("/home/u/.local/bin:/usr/bin:/bin:/opt/homebrew/bin")
    expect(mergePath(undefined, ["/usr/bin"])).toBe("/usr/bin")
  })

  test("the known install folders are the platform's that exist: Homebrew on macOS, Linuxbrew and snap on Linux", () => {
    const all = () => true
    expect(knownToolDirs({ platform: "darwin", home: "/Users/u", exists: all })).toEqual(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/Users/u/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    expect(knownToolDirs({ platform: "linux", home: "/home/u", exists: all })).toContain("/home/linuxbrew/.linuxbrew/bin")
    expect(knownToolDirs({ platform: "darwin", home: "/Users/u", exists: (dir) => dir === "/opt/homebrew/bin" })).toEqual(["/opt/homebrew/bin"])
  })

  test("only the line after the marker is read: what a profile prints before it is not taken for the PATH", () => {
    expect(parseShellPath("Welcome!\n/not/this:/either\n__MENDCODE_PATH__/opt/homebrew/bin:/usr/bin:relative\n")).toEqual(["/opt/homebrew/bin", "/usr/bin"])
    expect(parseShellPath("no marker here")).toBeUndefined()
  })

  test("a daemon started with env -i's short PATH (seen live: ~/.local/bin:/usr/bin:/bin) finds a gh that sits in a known folder", async () => {
    const brew = temp()
    writeFileSync(path.join(brew, "gh"), "#!/bin/sh\necho gh-ran \"$@\"\n")
    chmodSync(path.join(brew, "gh"), 0o755)
    // The short PATH is an empty folder, not /usr/bin: a CI runner has a real gh there (Ubuntu's does).
    const short = temp()
    const environment: NodeJS.ProcessEnv = { PATH: short }
    const finished = completeToolPath(environment, { platform: "darwin", home: "/nowhere", exists: () => false, shellPath: async () => [brew] })
    expect(environment.PATH).toBe(short)
    expect(await finished).toBe(`${short}:${brew}`)
    const saved = process.env.PATH
    process.env.PATH = short
    try {
      expect((await ghProcess({ argv: ["pr", "list"], cwd: brew })).code).toBe(127)
      process.env.PATH = environment.PATH
      expect(await ghProcess({ argv: ["pr", "list"], cwd: brew })).toEqual({ code: 0, out: "gh-ran pr list", err: "" })
    } finally { process.env.PATH = saved }
  })

  test.if(existsSync("/bin/zsh"))("the login shell's PATH is read from a real zsh profile, with only PATH taken from it", async () => {
    const home = temp()
    mkdirSync(path.join(home, "zdot"))
    writeFileSync(path.join(home, "zdot", ".zprofile"), "echo profile says hi\nexport PATH=/from/profile:$PATH\nexport SECRET_TOKEN=nope\n")
    const dirs = await loginShellPath({ shell: "/bin/zsh", environment: { HOME: home, ZDOTDIR: path.join(home, "zdot"), PATH: "/usr/bin:/bin" } })
    // The profile's folder first; macOS's /etc/zprofile (path_helper) may add the system's and /etc/paths.d's after it.
    expect(dirs?.[0]).toBe("/from/profile")
    expect(dirs).toContain("/usr/bin")
    expect(dirs!.every((dir) => path.isAbsolute(dir))).toBe(true)
    expect(await loginShellPath({ shell: "/bin/sh", environment: { PATH: "/usr/bin:/bin" }, timeoutMs: 5000 })).toContain("/usr/bin")
    expect(await loginShellPath({ shell: "relative-shell" })).toBeUndefined()
  })
})

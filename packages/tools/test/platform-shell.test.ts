import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { defaultShell, isSignalablePid, killProcessTree, shellArgv, shellFamily, shellSpawnOptions } from "../src/platform-shell"

describe("shell family", () => {
  test("recognizes PowerShell, cmd and POSIX shells from Windows and POSIX paths", () => {
    expect(shellFamily("pwsh")).toBe("powershell")
    expect(shellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell")
    expect(shellFamily("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE")).toBe("powershell")
    expect(shellFamily("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
    expect(shellFamily("/bin/sh")).toBe("posix")
    expect(shellFamily("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("posix")
  })
})

describe("default shell", () => {
  test("is /bin/sh off Windows", () => {
    expect(defaultShell({ platform: "linux", which: () => "/never" })).toBe("/bin/sh")
    expect(defaultShell({ platform: "darwin" })).toBe("/bin/sh")
  })

  test("prefers pwsh, then Windows PowerShell, then ComSpec, then cmd.exe on Windows", () => {
    const found = (names: string[]) => (name: string) => (names.includes(name) ? `C:\\bin\\${name}.exe` : null)
    expect(defaultShell({ platform: "win32", which: found(["pwsh", "powershell"]), env: {} })).toBe("C:\\bin\\pwsh.exe")
    expect(defaultShell({ platform: "win32", which: found(["powershell"]), env: {} })).toBe("C:\\bin\\powershell.exe")
    expect(defaultShell({ platform: "win32", which: found([]), env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } })).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(defaultShell({ platform: "win32", which: found([]), env: {} })).toBe("cmd.exe")
  })
})

describe("shell argv", () => {
  test("POSIX shells run `-c command`", () => {
    expect(shellArgv({ shell: "/bin/sh", command: "echo hi" })).toEqual(["/bin/sh", "-c", "echo hi"])
    expect(shellArgv({ shell: "C:\\Git\\bash.exe", command: "ls" })).toEqual(["C:\\Git\\bash.exe", "-c", "ls"])
  })

  test("PowerShell runs non-interactive, without a profile, as UTF-8, and restores native exit codes", () => {
    const argv = shellArgv({ shell: "pwsh", command: "Get-ChildItem # list\nexit 3" })
    expect(argv.slice(0, 5)).toEqual(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
    const script = argv[5]!
    expect(script).toContain("UTF8Encoding")
    // The user's text keeps its own lines, so a trailing comment cannot swallow the epilogue.
    expect(script).toContain("Get-ChildItem # list\nexit 3\n")
    expect(script.trimEnd().endsWith("exit 1 }")).toBe(true)
    expect(script).toContain("$LASTEXITCODE")
  })

  test("an interactive PowerShell session stays interactive", () => {
    expect(shellArgv({ shell: "powershell.exe", command: "python", interactive: true })).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", "python"])
  })

  test("cmd runs `/d /s /c` with the line quoted", () => {
    expect(shellArgv({ shell: "cmd.exe", command: "dir /b" })).toEqual(["cmd.exe", "/d", "/s", "/c", "\"dir /b\""])
  })
})

describe("spawn options", () => {
  test("Windows hides the console, skips detached groups and sends cmd.exe its line verbatim", () => {
    expect(shellSpawnOptions({ shell: "pwsh", platform: "win32" })).toEqual({ detached: false, windowsHide: true })
    expect(shellSpawnOptions({ shell: "cmd.exe", platform: "win32" })).toEqual({ detached: false, windowsHide: true, windowsVerbatimArguments: true })
    expect(shellSpawnOptions({ shell: "/bin/sh", platform: "linux" })).toEqual({ detached: true, windowsHide: true })
  })
})

describe("process tree kill", () => {
  test("POSIX signals the whole process group", async () => {
    if (process.platform === "win32") return
    const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" })
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()))
    killProcessTree({ pid: child.pid, signal: "SIGKILL", fallback: () => { throw new Error("group kill should work") } })
    await exited
    expect(child.signalCode).toBe("SIGKILL")
  })

  test("Windows uses taskkill with /T and falls back to the direct kill when it cannot run", async () => {
    if (process.platform === "win32") return
    const fallbacks: string[] = []
    // taskkill does not exist on this host, so the spawn error must route to the fallback.
    killProcessTree({ pid: 424242, signal: "SIGTERM", platform: "win32", fallback: (signal) => fallbacks.push(signal) })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fallbacks).toEqual(["SIGTERM"])
  })

  test("an unknown pid does nothing", () => {
    killProcessTree({ pid: undefined, signal: "SIGTERM", fallback: () => { throw new Error("unexpected") } })
  })

  test("a pid that is not a spawned child signals nothing: 0 and -1 reach whole groups, 1 is init, NaN and fractions are unparsed ids, ourselves and our parent are the runner", () => {
    const sent: Array<[number, unknown]> = []
    const real = process.kill
    process.kill = ((pid: number, signal?: string | number) => { sent.push([pid, signal]); return true }) as typeof process.kill
    try {
      for (const pid of [0, 1, -1, -2, Number.NaN, Number.POSITIVE_INFINITY, 12.5, 2 ** 60, process.pid, process.ppid]) {
        killProcessTree({ pid, signal: "SIGTERM", fallback: () => { throw new Error(`fallback for ${pid}`) } })
      }
      killProcessTree({ pid: 4242, signal: "SIGTERM", fallback: () => { throw new Error("fallback for the pid the test chose as self") }, self: 4242, parent: 4243 })
      killProcessTree({ pid: 4243, signal: "SIGTERM", fallback: () => { throw new Error("fallback for the pid the test chose as parent") }, self: 4242, parent: 4243 })
    } finally {
      process.kill = real
    }
    expect(sent).toEqual([])
  })

  test("an ordinary pid is signalled as the group it leads", () => {
    const sent: Array<[number, unknown]> = []
    const real = process.kill
    process.kill = ((pid: number, signal?: string | number) => { sent.push([pid, signal]); return true }) as typeof process.kill
    try {
      killProcessTree({ pid: 4242, signal: "SIGTERM", fallback: () => { throw new Error("unexpected") }, self: 1, parent: 2 })
    } finally {
      process.kill = real
    }
    expect(sent).toEqual([[-4242, "SIGTERM"]])
  })
})

describe("signal targets", () => {
  test("only whole numbers above 1 that are neither this process nor its parent qualify", () => {
    const own = { self: 500, parent: 400 }
    expect([2, 3, 99_999, 4_194_304].map((pid) => isSignalablePid(pid, own))).toEqual([true, true, true, true])
    expect([0, 1, -1, -500, 500, 400, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((pid) => isSignalablePid(pid, own))).toEqual([false, false, false, false, false, false, false, false, false])
    expect([undefined, null, "123", "", {}, [], true].map((pid) => isSignalablePid(pid, own))).toEqual([false, false, false, false, false, false, false])
    expect(isSignalablePid(process.pid)).toBe(false)
    expect(isSignalablePid(process.ppid)).toBe(false)
  })
})

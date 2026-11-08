import { describe, expect, test } from "bun:test"
import { installChecks, systemText } from "../src/support-output"

describe("mendcode doctor", () => {
  test("checks the installed binary and its folder on PATH, giving the line that adds it for the user's shell", () => {
    expect(installChecks("/home/ana/.local/bin/mendcode", "/usr/bin:/home/ana/.local/bin", "/bin/zsh")).toEqual([
      { name: "binary", ok: true, detail: "/home/ana/.local/bin/mendcode" },
      { name: "PATH", ok: true, detail: "/home/ana/.local/bin is on PATH" },
    ])
    const missing = installChecks("/home/ana/.local/bin/mendcode", "/usr/bin", "/usr/bin/fish")[1]!
    expect(missing).toMatchObject({ name: "PATH", ok: false })
    expect(missing.detail).toContain("fish_add_path '/home/ana/.local/bin'")
    expect(installChecks("/home/ana/.local/bin/mendcode", "/usr/bin", "/bin/zsh")[1]!.detail).toContain(`>> ~/.zshrc`)
    // A source checkout runs under bun: there is no installed binary to judge.
    expect(installChecks("/opt/homebrew/bin/bun", "/usr/bin", "/bin/zsh")).toEqual([])
  })

  test("a warning or a fact about the machine is not a failure; the last line says plainly whether the install works", () => {
    const report = (checks: Array<{ name: string; ok: boolean; detail: string; level?: "warn" | "info" }>) => ({ operation: "doctor", ok: checks.every((check) => check.ok), checks, failures: [], facts: {} })
    const working = systemText(report([
      { name: "database", ok: true, detail: "/d/mendd.db" },
      { name: "skills resources", ok: true, level: "warn", detail: "skill build (profile user:seda) is overridden by .claude (user)" },
      { name: "Rex", ok: true, level: "info", detail: "not installed (optional)" },
    ]))
    expect(working).toContain("warn\tskills resources\t")
    expect(working).toContain("info\tRex\tnot installed (optional)")
    expect(working.trim().split("\n").at(-1)).toBe("MendCode is installed and working (1 warning worth a look)")
    const broken = systemText(report([{ name: "PATH", ok: false, detail: "/x is not on PATH" }, { name: "skills resources", ok: true, level: "warn", detail: "w" }]))
    expect(broken).toContain("fail\tPATH\t")
    expect(broken.trim().split("\n").at(-1)).toBe("1 problem to fix, 1 warning")
  })
})

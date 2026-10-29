import { describe, expect, test } from "bun:test"
import { parseGlobalOptions } from "../src/global-options"
import { parseStartup, STARTUP_USAGE } from "../src/startup"

describe("instruction and config flags", () => {
  test("--no-context-files and -nc mark the session, for the TUI and run", () => {
    expect(parseStartup(["--no-context-files"])).toMatchObject({ kind: "tui", noContextFiles: true })
    expect(parseStartup(["-nc"])).toMatchObject({ noContextFiles: true })
    expect(parseStartup(["run", "hello", "-nc"])).toMatchObject({ kind: "run", noContextFiles: true, words: ["hello"] })
    expect(parseStartup(["run", "hello"]).noContextFiles).toBeUndefined()
    expect(() => parseStartup(["--no-context-files=1"])).toThrow("does not take a value")
    expect(STARTUP_USAGE).toContain("--no-context-files")
  })

  test("--strict-config is a global flag removed before the command parsers", () => {
    expect(parseGlobalOptions(["--strict-config", "run", "hi"])).toEqual({ args: ["run", "hi"], printLogs: false, strictConfig: true })
    expect(parseGlobalOptions(["--strict-config=false", "run"])).toEqual({ args: ["run"], printLogs: false })
    expect(parseGlobalOptions(["run", "--", "--strict-config"]).args).toEqual(["run", "--", "--strict-config"])
  })
})

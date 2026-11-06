import { describe, expect, test } from "bun:test"
import { helpText, parseAutomation, type Automation } from "../src/automation"
import { parseSlash, SLASH_COMMANDS } from "../src/view/commands"
import { HELP_GROUPS } from "../src/help-index"

function parsed(...argv: string[]): Automation {
  const result = parseAutomation(argv)
  if (!result.ok) throw new Error(`not parsed: ${argv.join(" ")}: ${"error" in result ? result.error : ""}`)
  return result.command
}

describe("profiles (formerly packages)", () => {
  test("`profile`, and the older `package`, `packages` and `marketplace`, are the same command", () => {
    for (const word of ["profile", "profiles", "package", "packages"]) {
      expect(parsed(word, "list")).toMatchObject({ kind: "profile.list" })
      expect(parsed(word, "install", "github:acme/tools#v1", "--replace")).toMatchObject({ kind: "profile.install", source: "github:acme/tools#v1", replace: true })
      expect(parsed(word, "enable", "acme", "--project")).toMatchObject({ kind: "profile.enable", name: "acme", scope: "project", enabled: true })
    }
    expect(parsed("marketplace", "search", "retro")).toMatchObject({ kind: "profile.catalog", request: { type: "profiles.search", query: "retro" } })
    expect(parsed("control-plane", "packages", "list")).toMatchObject({ kind: "profile.list" })
    expect(parsed("control-plane", "profiles", "list")).toMatchObject({ kind: "profile.list" })
  })

  test("help and the index say profile and never list the older words", () => {
    expect(helpText("profile")).toContain("mendcode profile <command>")
    for (const word of ["package", "packages", "profiles"]) expect(helpText(word)).toBe(helpText("profile"))
    const listed = HELP_GROUPS.flatMap((group) => group.entries.map((entry) => entry.command))
    expect(listed).toContain("profile")
    expect(listed).not.toContain("package")
  })

  test("/profiles opens the page; /packages and /pkg still do, but are not listed", () => {
    expect(parseSlash("/profiles")?.command.name).toBe("profiles")
    expect(parseSlash("/packages")?.command.name).toBe("profiles")
    expect(parseSlash("/pkg")?.command.name).toBe("profiles")
    const command = SLASH_COMMANDS.find((entry) => entry.name === "profiles")!
    expect(command.aliases).toEqual([])
    expect(SLASH_COMMANDS.some((entry) => entry.name === "packages" || entry.aliases.includes("pkg"))).toBe(false)
  })

  test("`customize restore` is the headless restore of the terminal settings", () => {
    expect(helpText("customize")).toContain("customize restore")
  })
})

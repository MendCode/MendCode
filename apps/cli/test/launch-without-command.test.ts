import { expect, test } from "bun:test"
import { parseAutomation } from "../src/automation"
import { launchesWithoutCommand } from "../src/startup"

const FLAG_ONLY = [
  ["--dir", "/tmp/data"],
  ["--dir", "/tmp/data", "--engine", "faux"],
  ["--model", "gpt-6-sol"],
  ["--continue"],
  ["-c"],
  ["--variant", "high"],
  ["--json"],
  ["--format", "json"],
  ["--offline"],
  ["--dry-run"],
]

test("a launch of flags and values alone skips the subcommand parsers, and they would have found nothing in it", () => {
  for (const argv of FLAG_ONLY) {
    expect(launchesWithoutCommand(argv), argv.join(" ")).toBe(true)
    expect(parseAutomation(argv), argv.join(" ")).toEqual({ ok: "none" })
  }
})

test("a launch that names a command, a word, help or an option the terminal does not know still reaches the subcommand parsers", () => {
  for (const argv of [[], ["session", "list"], ["attach", "ses_1"], ["run", "hi"], ["fix", "the", "bug"], ["--help"], ["-h"], ["--version"], ["--compat", "x"], ["storage", "--dry-run"], ["--dir", "/tmp/data", "usage"]]) {
    expect(launchesWithoutCommand(argv), argv.join(" ")).toBe(false)
  }
})

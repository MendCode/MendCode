import { describe, expect, test } from "bun:test"
import { HELP, helpText, NAMES, parseAutomation, USAGE } from "../src/automation"
import { HELP_ALIASES, HELP_GROUPS } from "../src/help-index"
import { parseDaemonService } from "../src/daemon-service"
import { parsePackageFileCommand } from "../src/package-file-command"
import { parseDocsCommand } from "../src/docs-args"
import { parseStartup, STARTUP_USAGE } from "../src/startup"
import { COMMANDS } from "../src/support-output"

const listed = HELP_GROUPS.flatMap((group) => group.entries)
const ID = "ses_0123456789ABCDEF"

/** Words that run through the startup parser, not the automation one. */
const STARTUP_ARGS: Record<string, string[]> = { run: ["run", "hello"], attach: ["attach", ID], acp: ["acp"], "app-server": ["app-server"], pet: ["pet", "new", "a fox"] }

function resolves(command: string): boolean {
  if (STARTUP_ARGS[command]) return parseStartup(STARTUP_ARGS[command]!).kind === (command === "attach" || command === "pet" ? "tui" : command)
  if (command === "docs") return parseDocsCommand(["docs"]) !== undefined
  if (command === "daemon") return parseDaemonService(["daemon", "status"]) !== undefined
  if (command === "uninstall") return typeof USAGE.uninstall === "string"
  const parsed = parseAutomation([command, "--help"])
  return parsed.ok === true && parsed.command.kind === "help"
}

describe("mendcode --help lists real commands", () => {
  test("every listed command resolves", () => {
    for (const entry of listed) expect([entry.command, resolves(entry.command)]).toEqual([entry.command, true])
  })

  test("a line starts with the word it lists, once per command", () => {
    for (const entry of listed) expect(entry.usage.split(" ")[0]).toBe(entry.command)
    expect(new Set(listed.map((entry) => entry.command)).size).toBe(listed.length)
  })

  test("every command that has help text is listed", () => {
    for (const command of Object.keys(USAGE)) expect([command, listed.some((entry) => entry.command === command) || command in HELP_ALIASES]).toEqual([command, true])
  })

  test("every registered command is listed or is an alias of a listed one", () => {
    const registered = new Set<string>([...NAMES, ...COMMANDS, ...Object.keys(STARTUP_ARGS), "docs", "daemon", "uninstall"])
    for (const command of registered) {
      const direct = listed.some((entry) => entry.command === command)
      const alias = HELP_ALIASES[command]
      expect([command, direct || alias === "mendcode" || (alias !== undefined && listed.some((entry) => entry.command === alias))]).toEqual([command, true])
    }
  })

  test("an alias is a word that runs", () => {
    for (const alias of Object.keys(HELP_ALIASES)) {
      if (alias === "thread") continue
      expect([alias, alias === "tui" || alias === "project" || parseAutomation([alias, "--help"]).ok !== false]).toEqual([alias, true])
    }
  })

  test("nothing is listed twice and nothing in the text is missing from the groups", () => {
    const lines = HELP.split("\n")
    for (const entry of listed) expect(lines.filter((line) => line.startsWith(`  ${entry.usage} `))).toHaveLength(1)
    expect(lines.filter((line) => line.startsWith("usage:")).length).toBe(1)
  })
})

describe("help text reads in 80 columns", () => {
  const topics = ["session", "memory", "loop", "workflow"]
  test("the index and the main commands", () => {
    for (const text of [HELP, ...topics.map((topic) => helpText(topic)), STARTUP_USAGE]) {
      for (const line of text.split("\n")) expect([line.length <= 80, line]).toEqual([true, line])
    }
  })

  test("each command help has one usage line", () => {
    for (const topic of topics) expect(helpText(topic).split("\n").filter((line) => line.startsWith("usage:"))).toHaveLength(1)
  })
})

describe("session commands", () => {
  const commandLines = helpText("session").split("\n").slice(0, helpText("session").split("\n").indexOf("options:"))
  const subcommands = [...new Set(commandLines.filter((line) => /^ {2}[a-z]/.test(line) && !line.startsWith("  (")).flatMap((line) => (/^ {2}(\S+)/.exec(line)![1]!).split("|")))]
  test("every command session --help lists is accepted", () => {
    expect(subcommands.length).toBeGreaterThan(15)
    for (const sub of subcommands) {
      const parsed = parseAutomation(["session", sub, ID, "x"])
      const message = parsed.ok === false ? parsed.message : ""
      expect([sub, /unknown session command/.test(message)]).toEqual([sub, false])
    }
  })

  test("session attach is attach", () => {
    expect(parseAutomation(["session", "attach", ID])).toEqual({ ok: "none" })
    const direct = parseStartup(["attach", ID])
    const viaSession = parseStartup(["session", "attach", ID])
    expect(viaSession.session).toBe(direct.session)
    expect(viaSession.session).toBe(ID)
    expect(viaSession.kind).toBe("tui")
  })

  test("the shorthands the help names still map to session commands", () => {
    expect(parseAutomation(["ps"])).toMatchObject({ ok: true, command: { kind: "session.list", active: true } })
    expect(parseAutomation(["logs", ID, "-f"])).toMatchObject({ ok: true, command: { kind: "session.events", follow: true } })
    expect(parseAutomation(["kill", ID])).toMatchObject({ ok: true, command: { kind: "session.cancel" } })
  })
})

describe("every command's help", () => {
  const topics = Object.keys(USAGE)

  test("fits 80 columns and has one usage line", () => {
    expect(topics.length).toBeGreaterThan(40)
    for (const topic of topics) {
      const lines = helpText(topic).trimEnd().split("\n")
      expect([topic, lines.filter((line) => line.length > 80)]).toEqual([topic, []])
      expect([topic, lines.filter((line) => line.startsWith("usage:")).length]).toEqual([topic, 1])
    }
  })

  test("the help of a command names that command", () => {
    for (const topic of topics) {
      if (topic in HELP_ALIASES && !listed.some((entry) => entry.command === topic)) continue
      expect([topic, helpText(topic).includes(topic)]).toEqual([topic, true])
    }
  })

  test("the subcommands listed by the larger helps are accepted", () => {
    for (const topic of ["memory", "loop", "workflow", "recipe", "area", "profile", "backlog"]) {
      const lines = helpText(topic).split("\n").filter((line) => /^ {2}[a-z]/.test(line))
      const subs = [...new Set(lines.flatMap((line) => /^ {2}(\S+)/.exec(line)![1]!.split("|")))].filter((word) => /^[a-z][a-z-]*$/.test(word))
      expect(subs.length).toBeGreaterThan(1)
      for (const sub of subs) {
        const parsed = parseAutomation([topic, sub, "x", "y"])
        const unknown = parsed.ok === false && /unknown/.test(parsed.message)
        const elsewhere = topic === "profile" && parsePackageFileCommand(["profile", sub, "x"]) !== undefined
        expect([topic, sub, !unknown || elsewhere]).toEqual([topic, sub, true])
      }
    }
  })
})

describe("the hand-written helps", () => {
  test("are written in 80 columns, before any reflow", async () => {
    const texts = await import("../src/help-text")
    expect(Object.keys(texts).length).toBeGreaterThan(30)
    for (const [name, text] of Object.entries(texts)) {
      expect([name, String(text).split("\n").filter((line) => line.length > 80)]).toEqual([name, []])
      expect([name, String(text).split("\n").filter((line) => line.startsWith("usage:")).length > 0]).toEqual([name, true])
    }
  })
})

describe("the commands the other helps list are accepted", () => {
  const H = "abcdef0123456789abcdef0123456789abcdef01"
  const S = "ses_0123456789ABCDEF"
  /** Each line is a command a help lists, written with arguments that make it valid: the help topic that lists it, then the words. */
  const CASES: Array<[topic: string, argv: string[]]> = [
    ...["config", "info", "paths", "scrap", "skill", "startup", "wait"].map((word): [string, string[]] => ["debug", ["debug", word]]),
    ["debug", ["debug", "agent", "x"]], ["debug", ["debug", "file", "search", "q"]], ["debug", ["debug", "file", "read", "p"]], ["debug", ["debug", "file", "status"]], ["debug", ["debug", "file", "list", "p"]], ["debug", ["debug", "file", "tree"]],
    ["debug", ["debug", "lsp", "diagnostics", "f"]], ["debug", ["debug", "lsp", "symbols", "q"]], ["debug", ["debug", "lsp", "document-symbols", "u"]],
    ["debug", ["debug", "snapshot", "track"]], ["debug", ["debug", "snapshot", "patch", H]], ["debug", ["debug", "snapshot", "diff", H]],
    ["debug", ["debug", "rg", "tree"]], ["debug", ["debug", "rg", "files"]], ["debug", ["debug", "rg", "search", "p"]],
    ["db", ["db", "path"]], ["db", ["db"]],
    ["theme", ["theme", "validate", "f"]], ["theme", ["theme", "install", "f"]], ["theme", ["theme", "select", "x"]],
    ...["status", "plan", "create", "open", "adopt", "remove", "reset", "doctor"].map((word): [string, string[]] => ["worktree", ["worktree", word, "n"]]),
    ["control-plane", ["control-plane", "permissions", "status"]], ["control-plane", ["control-plane", "permissions", "set-default", "ask"]],
    ...["status", "schema", "profile", "preview", "project", "render"].map((word): [string, string[]] => ["control-plane", ["control-plane", "tui", word]]),
    ["control-plane", ["control-plane", "tui", "apply", "x"]], ["control-plane", ["control-plane", "tui", "apply-preset", "x"]], ["control-plane", ["control-plane", "tui", "rollback", "x"]],
    ["control-plane", ["control-plane", "ai", "status"]], ["control-plane", ["control-plane", "ai", "env"]],
    ...["status", "doctor", "check", "toolchain", "config-paths", "config-layers", "precedence", "adapter-status"].map((word): [string, string[]] => ["control-plane", ["control-plane", "system", word]]),
    ...["status", "plan", "doctor"].map((word): [string, string[]] => ["control-plane", ["control-plane", "setup", word]]),
    ["control-plane", ["control-plane", "budget", "status"]], ["control-plane", ["control-plane", "budget", "doctor"]],
    ...["init", "config-show", "context-status", "context-refresh", "context-show", "focus-status", "focus-list", "focus-show", "package-show"].map((word): [string, string[]] => ["project", ["control-plane", "project", word]]),
    ["models", ["models"]], ...["status", "show", "plan", "presets"].map((word): [string, string[]] => ["models", ["control-plane", "models", word]]),
    ["models", ["control-plane", "models", "set-default", "p", "m"]], ["models", ["control-plane", "models", "use-preset", "n"]],
    ["providers", ["providers", "list"]], ["providers", ["providers", "logout"]], ["providers", ["providers", "login"]],
    ["providers", ["control-plane", "providers", "auth"]], ["providers", ["control-plane", "providers", "status"]], ["providers", ["control-plane", "providers", "adapters"]], ["providers", ["control-plane", "providers", "smoke"]],
    ["providers", ["control-plane", "auth", "status"]], ["providers", ["control-plane", "auth", "login-plan", "openai"]], ["providers", ["control-plane", "auth", "login", "openai"]],
    ["mcp", ["mcp", "list"]], ["mcp", ["mcp", "auth"]], ["mcp", ["mcp", "auth", "list"]], ["mcp", ["mcp", "logout"]], ["mcp", ["mcp", "debug", "n"]], ["mcp", ["mcp", "add", "n", "--", "cmd"]],
    ["mcp", ["control-plane", "mcp", "status"]], ["mcp", ["control-plane", "mcp", "preview"]], ["mcp", ["control-plane", "mcp", "add-local", "n", "c"]],
    ["github", ["github", "install"]], ["github", ["github", "run"]], ["pr", ["pr", "setup", "--session", S]], ["pr", ["pr", "12"]],
    ...["login", "logout", "switch", "orgs", "open", "status"].map((word): [string, string[]] => ["console", ["console", word]]), ["console", ["console", "setup", "--token-file", "f"]],
    ...["status", "create", "sync", "remove"].map((word): [string, string[]] => ["share", ["share", word, S]]), ["share", ["share", "policy", "manual"]], ["share", ["share", "local", S]], ["share", ["share", "gist", S, "--yes"]],
    ...["status", "doctor", "plan", "install", "setup", "activate", "deactivate", "remove"].map((word): [string, string[]] => ["tsm", ["tsm", word]]), ["tsm", ["tsm", "open", "t"]], ["tsm", ["tsm", "create", "n"]],
    ...["status", "legacy-status", "activate", "setup", "deactivate", "remove", "scan", "relay-guide", "plan", "doctor", "start", "stop"].map((word): [string, string[]] => ["mflow", ["mflow", word]]),
    ...["status", "enable", "on", "disable", "off"].map((word): [string, string[]] => ["cache", ["cache", word]]),
    ["ai-config", ["ai-config", "inspect"]], ["agent", ["agent", "list"]], ["agent", ["agent", "create"]],
    ["prompt", ["prompt", "sources"]], ["prompt", ["prompt", "build"]], ["prompt", ["prompt", "mode"]], ["prompt", ["prompt", "cycle-mode"]],
    ["recipe", ["recipe", "list"]], ["recipe", ["recipe", "apply", "n"]],
    ["storage", ["storage", "--clean"]], ["storage", ["storage", "--compact"]], ["storage", ["storage", "--worktrees"]], ["storage", ["storage", "--dry-run", "--clean"]],
    ["generate", ["generate", "--httpapi"]], ["export", ["export", "--sanitize"]], ["import", ["import", "--latest"]], ["context", ["context", S]], ["apply", ["apply", "--check"]],
  ]
  const rejected = /unknown|Expected a|unsupported|not a command/i

  test("each listed command is accepted by its parser", () => {
    expect(CASES.length).toBeGreaterThan(150)
    for (const [topic, argv] of CASES) {
      const parsed = parseAutomation(argv)
      const accepted = parsed.ok === true || (parsed.ok === false && !rejected.test(parsed.message))
      expect([argv.join(" "), accepted]).toEqual([argv.join(" "), true])
      // The help names what it accepts: each word of the command is in the text of its topic.
      const words = argv.slice(1, 4).filter((word) => /^[a-z][a-z-]{2,}$/.test(word) && !["cmd", "list"].includes(word) || word === "list")
      const help = helpText(topic)
      for (const word of words.slice(0, argv[0] === "control-plane" ? 2 : 1)) if (word !== "x") expect([argv.join(" "), word, help.includes(word)]).toEqual([argv.join(" "), word, true])
    }
  })

  test("daemon commands are accepted", () => {
    for (const word of ["start", "run", "status", "logs", "stop", "restart"]) expect([word, parseDaemonService(["daemon", word]) !== undefined]).toEqual([word, true])
    expect(parseDaemonService(["daemon", "service", "plan"])).toBeDefined()
    for (const word of ["start", "run", "status", "logs", "stop", "restart", "service"]) expect(helpText("daemon")).toContain(word)
  })
})

import { EXPERIMENTAL_FLAGS, FEATURES, OUTPUT_STYLES, TIERS } from "@mendcode/protocol/wire"

/**
 * The words a command takes after its name, for the `/` menu and Tab (docs/commands.md, "Arguments"). A key is the command and the
 * words already typed (`pr`, `pr publish`); `*` stands for any one word (`experimental *` is the on|off after a flag). Only fixed words
 * are listed: a path, a number or free text is the user's to type, so nothing is guessed for it. Pure.
 */
export type SlashArgument = { word: string; summary: string; /** More words follow: Tab and Enter insert it with a space instead of running it. */ more?: true; feature?: import("@mendcode/protocol/wire").FeatureId }

const onOff = (what: string): SlashArgument[] => [{ word: "on", summary: `Turn ${what} on` }, { word: "off", summary: `Turn ${what} off` }]
const toggle = (what: string): SlashArgument[] => [...onOff(what), { word: "toggle", summary: `Switch ${what}` }]
const words = (summary: string, list: readonly string[]): SlashArgument[] => list.map((word) => ({ word, summary }))

const ARGUMENTS: Readonly<Record<string, () => readonly SlashArgument[]>> = {
  pr: () => [
    { word: "on", summary: "Turn on PR watching and the PR reviewer" },
    { word: "off", summary: "Turn off PR watching and the PR reviewer" },
    { word: "review", summary: "Review a pull request now: [pr], the branch's by default" },
    { word: "comments", summary: "Show a pull request's review comments: [pr]" },
    { word: "watch", summary: "Watch one pull request: [pr]" },
    { word: "unwatch", summary: "Stop watching a pull request: [pr]" },
    { word: "check", summary: "Read a pull request's state once: [pr]" },
    { word: "watch-repo", summary: "Review this repository's new pull requests: [all|requested]" },
    { word: "unwatch-repo", summary: "Stop reviewing this repository's pull requests" },
    { word: "repos", summary: "List the watched repositories" },
    { word: "publish", summary: "Allow or stop posting reviews to GitHub", more: true },
    { word: "list", summary: "List this session's watched pull requests" },
  ],
  "pr watch-repo": () => [{ word: "all", summary: "Every pull request: one reviewer for the repository" }, { word: "requested", summary: "Only pull requests that request your review or are assigned to you" }],
  "pr publish": () => [{ word: "on", summary: "Post reviews to this repository" }, { word: "off", summary: "Keep reviews in the session only" }],
  experimental: () => EXPERIMENTAL_FLAGS.map((flag) => ({ word: flag.id, summary: flag.summary, more: true as const })),
  "experimental *": () => toggle("the flag"),
  tier: () => [...words("Use this tier", TIERS), { word: "off", summary: "No tier: every flag decides" }, ...Object.keys(FEATURES).map((id) => ({ word: id, summary: "Set this feature: on, off or default", more: true as const }))],
  "tier *": () => [...onOff("the feature"), { word: "default", summary: "Follow the tier" }],
  "output-style": () => words("Answer in this style", OUTPUT_STYLES),
  fast: () => [...onOff("the priority service tier"), { word: "status", summary: "Show whether it is on" }],
  graph: () => [...onOff("code graph indexing"), { word: "auto", summary: "Index when the project is large enough" }, { word: "default", summary: "Set the default for new projects", more: true }],
  "graph default": () => [...onOff("indexing"), { word: "auto", summary: "Index large projects" }],
  daemon: () => [{ word: "status", summary: "Show the daemon's state" }, { word: "restart", summary: "Restart it when no work runs" }],
  git: () => words("Open this tab", ["changes", "commit", "worktrees", "pr"]),
  commit: () => [{ word: "push", summary: "Commit and push" }, { word: "pr", summary: "Commit, push and open a pull request" }],
  stash: () => [{ word: "list", summary: "List stashed prompts" }, { word: "pop", summary: "Restore one: [n]" }, { word: "drop", summary: "Delete one: [n]" }, { word: "clear", summary: "Delete every stashed prompt" }],
  copy: () => [{ word: "pick", summary: "Choose what to copy" }, { word: "transcript", summary: "Copy the whole transcript" }],
  fork: () => [{ word: "pick", summary: "Choose the message to fork from" }, { word: "merge", summary: "Merge a fork back: [id]" }],
  changes: () => [{ word: "session", summary: "Every change of the session" }, { word: "message", summary: "The changes of one message: <n>", more: true }, { word: "replay", summary: "Replay the changes: [n]" }],
  export: () => words("Export in this format", ["markdown", "json", "html"]),
  import: () => [...words("Import a session from it", ["claude-code", "codex"]), { word: "setup", summary: "Import its settings", more: true }],
  "import setup": () => words("Import this tool's settings", ["claude-code", "codex"]),
  queue: () => [{ word: "after-response", summary: "Send queued messages after the answer" }, { word: "after-tools", summary: "Send them after the current tools" }, { word: "immediate", summary: "Send them at once" }],
  sandbox: () => [{ word: "on", summary: "Commands write only in the workspace" }, { word: "off", summary: "No sandbox" }, { word: "read-only", summary: "Commands cannot write" }, { word: "workspace-write", summary: "Commands write only in the workspace" }, { word: "toggle", summary: "Switch the sandbox" }, { word: "network", summary: "Allow or block the network", more: true }, { word: "allow", summary: "Allow a path: <path>" }, { word: "deny", summary: "Deny a path: <path>" }],
  "sandbox network": () => onOff("the network"),
  "add-dir": () => [{ word: "save", summary: "Add a directory for good: <path>" }, { word: "remove", summary: "Remove a directory: <path>" }],
  "remote-control": () => [...onOff("remote control"), { word: "pair", summary: "Pair a chat" }, { word: "unpair", summary: "Unpair a chat: [chat id]" }],
  voice: () => [...onOff("voice"), ...words("Dictation", ["status", "start", "stop", "cancel"]), { word: "language", summary: "Set the language: <code|auto>" }],
  ide: () => [{ word: "on", summary: "Connect an editor: [zed|vscode]" }, { word: "off", summary: "Disconnect the editor" }, { word: "clear", summary: "Forget the editor's selection" }, { word: "refresh", summary: "Read the editor again" }, { word: "open", summary: "Open a file in the editor: [path:line]" }],
  share: () => [{ word: "local", summary: "Share as a local file" }, { word: "gist", summary: "Share as a secret gist (--yes)" }, { word: "policy", summary: "Set the sharing policy", more: true }, ...words("Shared session", ["status", "create", "sync", "remove"])],
  "share policy": () => words("Sharing policy", ["manual", "auto", "disabled"]),
  backlog: () => [{ word: "list", summary: "List the backlog" }, { word: "add", summary: "Add an item: <text>" }, ...words("Change an item: <id>", ["done", "reopen", "remove", "open"]), { word: "clear", summary: "Empty the backlog" }],
  compound: () => [...onOff("compound runs"), { word: "configure", summary: "Configure: <json>" }, { word: "run", summary: "Run a profile: <profile> <json>" }],
  "prompt-mode": () => words("Prompt context", ["minimal", "focus", "guide", "full", "custom", "cycle"]),
  "prompt-chrome": () => words("Prompt frame", ["box", "top-bottom", "minimal", "ascii-box"]),
  presentation: () => words("Chat presentation", ["raw", "minimal", "mendcode", "full", "balanced", "auto"]),
  "message-rendering": () => words("Message rendering", ["plain", "markdown", "full"]),
  "submit-scroll": () => words("After sending", ["bottom", "clear"]),
  scrollbar: () => words("Transcript scrollbar", ["auto", "always", "off"]),
  "jump-to-latest": () => words("Jump-to-latest button", ["right", "center", "left", "off"]),
  comments: () => words("Comments", ["list", "reply", "clear", "on", "off", "auto", "settings"]),
  activity: () => [...words("Activity status", ["transcript", "above", "inside", "off"]), { word: "reset", summary: "Default activity parts" }],
  sidebar: () => words("Sessions sidebar", ["auto", "always", "hidden"]),
  footer: () => [{ word: "icons", summary: "Footer icons", more: true }, { word: "rows", summary: "Number of footer rows: 0..n" }, { word: "row", summary: "Set one row's segments: <n> [segments…]" }],
  pet: () => words("Pet size", ["small", "medium", "large"]),
  mascot: () => [{ word: "mend", summary: "Show Mend" }, { word: "off", summary: "No mascot" }],
  accessible: () => toggle("accessible mode"),
  vim: () => toggle("vim keys"),
  multiline: () => toggle("multiline input"),
  trust: () => [...onOff("trust for this project"), { word: "status", summary: "Show whether it is trusted" }],
  panel: () => ["pulse", "crew", "ledger", "focus", "full", "galaxy", "next", "off", "edit", "reset", "width", "widget"].map((word) => ({ word, summary: "Customize the right panel", feature: word === "galaxy" ? "panel_orbit" as const : "panel" as const })),
  workflows: () => [{ word: "run", summary: "Run a workflow: <file.js|name> [args]" }, { word: "new", summary: "Create one: <name>" }, { word: "convert", summary: "Convert a plan: <plan.json>" }, { word: "budget", summary: "Set a run's budget: <id> …" }, { word: "update", summary: "Update a run: <id> <file.js>" }, { word: "resume", summary: "Resume a run: <id>" }],
  agents: () => words("Act on a sub-agent: <session-id>", ["summary", "rename", "tag", "pause", "stop", "message"]),
  mcp: () => [{ word: "auth", summary: "Sign in to a server: <server>" }],
}

/** The completions of the word under the cursor: `{ path: "pr publish", partial: "o" }` for `pr publish o`. */
export function argumentContext(command: string, args: string): { key: string; typed: readonly string[]; partial: string } | undefined {
  const parts = args.split(/\s+/)
  const partial = parts.pop() ?? ""
  const typed = parts.filter(Boolean)
  for (const key of [[command, ...typed].join(" "), typed.length ? [command, ...typed.slice(0, -1), "*"].join(" ") : ""]) if (key && ARGUMENTS[key]) return { key, typed, partial }
  return undefined
}

/** The fixed words that fit, exact first, then prefixes, then a word that only contains the partial. Empty when the command takes none here. */
export function argumentMatches(command: string, args: string): Array<SlashArgument & { name: string }> {
  const context = argumentContext(command, args)
  if (!context) return []
  const partial = context.partial.toLowerCase()
  const options = ARGUMENTS[context.key]!()
  const rank = (word: string) => word === partial ? 0 : word.startsWith(partial) ? 1 : word.includes(partial) ? 2 : -1
  return options
    .map((option) => ({ option, rank: rank(option.word) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map(({ option }) => ({ ...option, name: [command, ...context.typed, option.word].join(" ") }))
}

export const hasArguments = (command: string) => Boolean(ARGUMENTS[command])

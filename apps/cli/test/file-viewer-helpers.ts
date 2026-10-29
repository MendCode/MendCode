import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { viewFile } from "../../../packages/daemon/src/file-view"
import { FileApiError } from "../../../packages/daemon/src/file-rest-process"
import { appHarness, conversation, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { configureKeyLabels } from "../src/ui/key-labels"

/**
 * The file viewer's test bench: a project on disk, the real daemon read (`viewFile`) behind the app's `send`, and a conversation that
 * cites some of its files. Shared by the tests and by `scripts/render-file-viewer-frames.ts`, so a frame is a screen of the wired app.
 */

export const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
export const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
export const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
export const wheelDown = (col: number, row: number) => `\x1b[<65;${col + 1};${row + 1}M`
export const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))
/** The file reads `chat`'s daemon still owes its app. */
let inFlight = 0
const SETTLE_MS = 25
const SETTLE_LIMIT_MS = 10_000

/**
 * The pause after a key or a click: the 25 ms it always was, and then for as long as a file read the app asked for has not been
 * answered. With twelve test processes on the machine a read took longer than the 25 ms, and the frame after it showed no file. A
 * read that is never answered ends the wait at the limit, and the assertion after it says what the screen shows.
 */
export async function settle() {
  const end = performance.now() + SETTLE_LIMIT_MS
  await Bun.sleep(SETTLE_MS)
  // Two looks in a row with nothing owed: the app has had a turn of the timer queue to act on the last answer, which may ask again.
  for (let quiet = inFlight === 0 ? 1 : 0; quiet < 2 && performance.now() < end; quiet = inFlight === 0 ? quiet + 1 : 0) await Bun.sleep(1)
}

export const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n"

const RUST = [
  "use std::collections::HashMap;",
  "",
  "/// The application state: the open documents and the key bindings.",
  "pub struct App {",
  "    pub docs: HashMap<String, Doc>,",
  "    pub keys: Vec<Binding>,",
  "}",
  "",
  "impl App {",
  "    pub fn new() -> Self {",
  "        // Start with no documents and the default bindings.",
  "        App { docs: HashMap::new(), keys: Binding::defaults() }",
  "    }",
  "}",
]

/** A prose document of 65 lines with long paragraphs, a heading, lists, code spans, a fence and a link: the kind of file the owner opened. */
const WORKTREES = [
  "# Worktrees",
  "",
  "A worktree is a second checkout of the same repository, with its own branch and its own files on disk, so two agents can work at the same time without touching each other's changes.",
  "",
  "## Why they exist",
  "",
  "- Each agent gets `.claude/worktrees/<name>` and a branch of the same name, so its edits never land in the main checkout by accident.",
  "- The main checkout stays on `main` and is never reset, stashed or cleaned by an agent.",
  "- Stashes are shared by every worktree, so an agent sets work aside with a temporary commit instead.",
  "",
  "## Rules",
  "",
  "1. Work inside your own worktree and run every command from its directory; a command that cannot be shown to stay inside it is refused.",
  "2. Commit small and often on the worktree branch; the coordinator merges it, you never push.",
  "3. Remove a worktree only with its exact absolute path, never with a wildcard or a relative path.",
  "",
  "> A worktree that has no uncommitted changes and no commits of its own is removed automatically when its agent finishes.",
  "",
  "```ts",
  "const branch = `worktree-${name}`",
  "await git([\"worktree\", \"add\", dir, \"-b\", branch])",
  "```",
  "",
  "See [the git manual](https://git-scm.com/docs/git-worktree) for the commands, and `docs/agents.md` for how the coordinator names them.",
  ...Array.from({ length: 40 }, (_, index) => (index % 5 === 4 ? "" : `Note ${index + 1}: a worktree keeps its own index and HEAD, and shares the object store with the repository it was made from.`)),
].join("\n") + "\n"

/**
 * A 5,000-line file whose line 3,000 is inside something opened at line 10 and closed at line 3,500: a block comment (TS, Rust), a
 * triple-quoted string (Python) or a fenced code block (Markdown). Line 3,000 reads like code, so only the carried state says what it is.
 */
export const LONG_KINDS = {
  ts: { file: "long.ts", open: "/* the notes start here", close: "*/", inside: "const insideComment = 3000 // not code" },
  rust: { file: "long.rs", open: "/* the notes start here", close: "*/", inside: "fn inside_comment() -> u32 { 3000 }" },
  py: { file: "long.py", open: 'NOTES = """the notes start here', close: '"""', inside: "def inside_string(): return 3000" },
  md: { file: "long.md", open: "```ts", close: "```", inside: "const insideFence = 3000 // a fenced line" },
} as const
export type LongKind = keyof typeof LONG_KINDS

export function longSource(kind: LongKind): string {
  const { open, close, inside } = LONG_KINDS[kind]
  return Array.from({ length: 5_000 }, (_, index) => {
    const line = index + 1
    if (line === 10) return open
    if (line === 3_000) return inside
    if (line === 3_500) return close
    return line < 10 || line > 3_500 ? (kind === "py" ? `value_${line} = ${line}` : kind === "md" ? `Paragraph ${line} of the notes.` : `const line${line} = ${line}`) : `notes ${line}`
  }).join("\n") + "\n"
}

/** A project on disk with the files the tests open. */
export function project(): string {
  const dir = tempDir("mendcode-file-viewer-")
  mkdirSync(path.join(dir, "src/files"), { recursive: true })
  writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n\nRules for this repository.\n" + numbered(154, "- rule"))
  writeFileSync(path.join(dir, "src/app.rs"), Array.from({ length: 200 }, (_, index) => RUST[index] ?? (index === 119 ? "fn target() { let key = \"value\"; }" : `// filler ${index + 1}`)).join("\n") + "\n")
  writeFileSync(path.join(dir, "src/files/link.rs"), numbered(90, "link"))
  writeFileSync(path.join(dir, "DESIGN.md"), numbered(40, "design"))
  writeFileSync(path.join(dir, "worktrees.md"), WORKTREES)
  writeFileSync(path.join(dir, "big.log"), numbered(11_000, "entry"))
  writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]))
  return dir
}

export type Setup = {
  profile?: Partial<TuiProfile>
  tier?: "minimalist" | "balanced" | "full" | null
  width?: number
  height?: number
  /** What the assistant says (it may cite the project's own directory). */
  text?: string | ((dir: string) => string)
  /** What `changes.query` answers for the project. */
  changes?: (dir: string) => unknown
  /** Settings merged over the test's (a panel preset, extra directories). */
  settings?: Record<string, unknown>
  /** The contents of `keybindings.json` (a rebound key). */
  keybindings?: Record<string, string | null>
  /** The daemon's answers carry no `lex`: the highlighting a window had before the daemon lexed what is above it. */
  stripLex?: boolean
  /** The host the key hints are worded for: a new app words them canonically, so this is set after it starts. */
  platform?: "darwin" | "linux"
}

export async function chat(setup: Setup = {}) {
  const dir = project()
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...setup.profile })
  if (setup.keybindings) writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify(setup.keybindings))
  const reply = (command: CommandInput): Promise<CommandReply> | CommandReply | undefined => {
    if (command.type === "file.view") {
      inFlight++
      return viewFile({ directory: command.directory, path: command.path, from: command.from, count: command.count, search: command.search, known: command.known, lang: command.lang })
        .finally(() => { inFlight-- })
        // `stripLex` answers the way the daemon did before it told the client what an open comment above the window is.
        .then((result) => ({ ok: true, result: setup.stripLex ? { ...result, lex: undefined } : result }) as CommandReply)
        .catch((error) => ({ ok: false, error: { code: "invalid_command", message: error instanceof FileApiError ? error.message : String(error) } }) as CommandReply)
    }
    if (command.type === "changes.query") return { ok: true, result: setup.changes?.(dir) ?? { root: dir, files: [], omittedFiles: 0 } } as CommandReply
    return undefined
  }
  const h = appHarness({ dataDir, directory: dir, width: setup.width ?? 160, height: setup.height ?? 45, reply })
  h.app.applySettings({ onboarded: true, ...(setup.tier === null ? {} : { tier: setup.tier ?? "balanced" }), reducedMotion: true, ...(setup.settings ?? {}) })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Where is it?", typeof setup.text === "function" ? setup.text(dir) : setup.text ?? "See src/app.rs:120 and `src/files/link.rs:56-79`, also DESIGN.md#L10-L20 and ./AGENTS.md.")
  if (setup.platform) configureKeyLabels({ setting: "auto", platform: setup.platform, altWorks: false })
  h.app.render()
  return { h, dir, talk }
}

/** A plain click (press and release) on the first cell of `needle` plus `offset`, then the frame that follows the daemon's answer. */
export async function click(h: Harness, needle: string, offset = 1) {
  const row = rowOf(h, needle)
  if (row < 0) throw new Error(`[TEST]: "${needle}" is not on screen`)
  const col = h.text()[row]!.indexOf(needle) + offset
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  await settle()
  h.app.render()
}

export const frame = (h: Harness) => h.text().join("\n")
/** The right part of the screen: where the slot is. */
export const slot = (h: Harness, cells = 56) => h.text().map((row) => row.slice(Math.max(0, h.size.width - cells)))

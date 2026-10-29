import fs from "node:fs"
import path from "node:path"

/**
 * What changed in MendCode, newest first, shown by `/changelog`. It is bundled with the app (no network). `id` is the
 * date the entry was written and orders entries; the terminal remembers the newest id it has shown, so the next
 * `/changelog` marks what is new since then. Add an entry at the top for each user-visible change set.
 */
export type ChangelogEntry = { id: string; version: string; title: string; items: string[] }

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    id: "2026-10-28",
    version: "0.0.1-dev",
    title: "Pull request reviews, argument completion, message times",
    items: [
      "/pr on and /pr off turn the pull request watcher and reviewer on or off together; /pr comments replaces /pr-comments",
      "The reviewer waits 10 minutes between reviews of one pull request and does at most 20 an hour per repository (cooldown in .mendcode/review.yaml); /pr watch-repo requested reviews only what is assigned or requested of you",
      "Reviews read like a reviewer's: a verdict, a table of findings linked to their lines, collapsible details and a prompt for AI agents under each comment",
      "Tab completes the arguments of slash commands, not only their names: /pr pub then Tab gives /pr publish",
      "/timestamps also ends a turn's line with done and the time; session_read gives the model each message's time",
      "A custom message view gets the built-in rows, so a script can add its own line under any message",
      "Graph tools asked about a folder of another indexed project answer from that project's graph",
      "s on the model page turns fast mode on or off for models that offer it",
      "A held queue says why (Held since your cancel) and that ctrl+s sends it",
    ],
  },
  {
    id: "2026-10-08",
    version: "0.0.1-dev",
    title: "Drafts per session",
    items: [
      "A session with only an unsent draft reads Draft · first words (Draft · 1 image for attachments), not Untitled session, in the sidebar, /sessions and the palette",
      "Opening a session puts its draft back in the prompt by itself; the prompt you leave is saved as that session's draft",
      "An empty prompt saves no draft, and the unsent-draft notice names images and attachments instead of 0 chars",
    ],
  },
  {
    id: "2026-10-03",
    version: "0.0.1-dev",
    title: "Session navigation",
    items: [
      "/tree shows the fork family of a session as a tree: filter, search, open any branch, see bookmarks and ask for a branch summary",
      "/label <text> bookmarks the latest message; labels also show in /timeline, where l edits them",
      "/recap writes a short summary of the session so far with the model, on demand",
      "/changelog (this page) lists what changed, with what is new since you last looked",
    ],
  },
  {
    id: "2026-10-02",
    version: "0.0.1-dev",
    title: "Drafts, images and diagrams",
    items: [
      "Unsent drafts survive restarts: ctrl+r restores one, /drafts lists those of other sessions",
      "Selecting text with the mouse copies it as plain text (copyOnSelect)",
      "Pasting an image from the clipboard works on every OS and shows a sized [Image #N] chip",
      "Theme picker with live preview, system light/dark and mode lock: /theme",
      "Compaction panel modes: panel, stats, arcade, scratchpad and quiet",
      "Mermaid parses real-world model output, math renders as Unicode and <details> collapses",
      "The latest prompt stays pinned under the top bar while you scroll (/sticky-prompt)",
    ],
  },
  {
    id: "2026-10-01",
    version: "0.0.1-dev",
    title: "Terminal look",
    items: [
      "Quiet chat design after v1: plain messages, one-line footer, left session sidebar",
      "Full session history page (/history), model, variant and skill pickers",
      "Usage dashboard and panel-grid pages, context page as a category grid",
      "Persistent side chat for /btw and a right sidebar the agent builds",
      "Customize the interface from extensions and by asking the agent",
    ],
  },
]

/** Entries newer than the last id the terminal showed; all of them when it never showed one. */
export function entriesSince(seen: string | undefined): ChangelogEntry[] {
  return CHANGELOG.filter((entry) => !seen || entry.id > seen)
}

const seenFile = (dataDir: string) => path.join(dataDir, "tui", "changelog-seen")

/** The newest entry id this terminal showed, kept in `<dataDir>/tui/changelog-seen`; undefined when there is none. */
export function readSeen(dataDir: string): string | undefined {
  try {
    const text = fs.readFileSync(seenFile(dataDir), "utf8").trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
  } catch {
    return undefined
  }
}

/** Records the newest entry as shown. A failed write only means the entries show as new again. */
export function writeSeen(dataDir: string, id: string) {
  try {
    fs.mkdirSync(path.dirname(seenFile(dataDir)), { recursive: true })
    fs.writeFileSync(seenFile(dataDir), `${id}\n`)
  } catch {
    // Nothing to do: the marker is a convenience.
  }
}

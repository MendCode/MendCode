import type { HighlightState } from "./syntax"

/**
 * The file viewer's read (`file.view`, docs/file-viewer.md): data and types only (one type import), so the thin terminal client and the
 * daemon share it. The daemon answers one window of lines per request and never more than the limits below.
 */

/** A file over this many bytes is not read at all: the viewer says so in one line. */
export const FILE_VIEW_MAX_BYTES = 4 * 1024 * 1024
/** Most lines one reply carries; the terminal asks for what its viewport needs. */
export const FILE_VIEW_MAX_ROWS = 400
/** A line longer than this is cut (the reply says how many were). */
export const FILE_VIEW_MAX_LINE = 2000
/** Most matching line numbers one reply lists for a search. */
export const FILE_VIEW_MAX_HITS = 500
/** Keeps a reply under the protocol frame whatever the lines hold. */
export const FILE_VIEW_MAX_REPLY_BYTES = 150_000

export type FileViewKind =
  /** Lines in `rows`. */
  | "text"
  /** NUL bytes or a binary format: size and type only. */
  | "binary"
  /** A device, pipe, socket: never opened. */
  | "special"
  | "directory"
  | "missing"
  /** Outside the project and its extra directories (or a symlink out of them): never read. */
  | "outside"
  /** Over `FILE_VIEW_MAX_BYTES`. */
  | "large"

export type FileViewHits = { lines: number[]; total: number }

/** Most entries a folder listing carries (the rest are counted in `entriesTotal`). */
export const FILE_VIEW_MAX_ENTRIES = 500
/** Most entries of one folder the daemon reads: a folder with more is listed from its first ones, and `entriesTotal` stops here. */
export const FILE_VIEW_MAX_SCAN = 20_000

/** One entry of a folder: `link` is a symbolic link (not followed: opening it goes through the same containment as any path). */
export type FileViewEntry = { name: string; kind: "dir" | "file" | "link" | "other"; size?: number }

export type FileView = {
  /** Relative to the directory asked about (forward slashes). */
  path: string
  kind: FileViewKind
  size: number
  /** Changes whenever the file does (size and modification time); send it back as `known` to ask "has it changed?". */
  version: string
  /** The `known` version still matches: nothing else is in the reply. */
  unchanged?: true
  /** The type of a binary file, e.g. `image/png`. */
  mime?: string
  /** All lines of the file (`text`). */
  lines?: number
  /** The line number of the first of `rows`, 1-based. */
  from?: number
  rows?: string[]
  /** Lines of this window that were cut at `FILE_VIEW_MAX_LINE`. */
  cut?: number
  /** Secrets masked in this window, the way diffs and tool output are. */
  redacted?: number
  /** Lines holding `search`, ascending (first `FILE_VIEW_MAX_HITS`). */
  hits?: FileViewHits
  /** The tokenizer's state at the start of `rows` (a block comment, a triple-quoted string or a Markdown fence opened above the window); absent when nothing is open or `lang` was not asked. */
  lex?: HighlightState
  /** A `directory`'s entries: folders first, then files, each sorted by name, at most `FILE_VIEW_MAX_ENTRIES`; `.git` is never listed. */
  entries?: FileViewEntry[]
  /** How many entries the folder holds in all (more than `entries` has when the listing was cut). */
  entriesTotal?: number
}

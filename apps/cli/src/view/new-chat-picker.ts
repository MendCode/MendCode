import type { Line } from "../ui/theme"
import { fit, spread } from "./deck"
import { looksLikePath } from "./new-chat-browse"
import { lineWidth, truncateEnd } from "./wrap"

/**
 * The "New chat in…" picker (docs/sidebar.md): the folders a chat can start in, drawn over the left list in its own cells. The open
 * folder comes first, then the folders with sessions; typing filters them, and text that starts like a path (`/`, `~`, `./`, `../`)
 * lists directories from the disk instead, so a folder with no session yet can be chosen. Loaded by the first picker opened.
 */
export type FolderChoice = {
  directory: string
  label: string
  /** The folder as shown under the list: its path with the home folder as `~`. */
  detail: string
  kind: "open" | "known" | "path" | "browse" | "create"
  /** For a directory read from the disk (and the `Browse folders…` row): what Tab leaves in the field to walk into it. */
  typed?: string
  /** A project of the sync hub that is not a folder here: a chat started in it runs on that machine. */
  hub?: string
  /** The folder is the top of a git repository. */
  git?: boolean
  /** The row is the directory the typed path itself names. */
  here?: boolean
}

const PAD_X = 2
const MAX_CHOICES = 60

const baseName = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory
const tilde = (directory: string, home: string) => home && (directory === home || directory.startsWith(`${home}/`)) ? `~${directory.slice(home.length)}` : directory

export { looksLikePath }

/** What a typed path offers from the disk: the directory it names, those that continue it, and the folder it would create. */
export type BrowseFound = {
  typedDirectory?: string | undefined
  typedGit?: boolean | undefined
  completions?: ReadonlyArray<{ directory: string; typed: string; git?: boolean }>
  /** How many completions start with the typed name; the folder to create goes after them and before the looser matches. */
  prefixCount?: number | undefined
  create?: string | undefined
}

/**
 * The rows for what is typed. `folders` is the open folder first, then the others in the order to show. Not a path: the folders
 * whose path holds every typed word (names sharing a folder name told apart by their parent), a project of the hub marked with the
 * hub's name, and, with nothing typed, a `Browse folders…` row after the open folder. A path: the typed directory itself, those that
 * continue it and, for a name nothing starts with, the folder to create (see `BrowseFound`).
 */
export function folderChoices({ folders, opened, query, home, hub, browseRoot, ...found }: { folders: readonly string[]; opened?: string | undefined; query: string; home: string; hub?: { name: string; folders: ReadonlySet<string> } | undefined; browseRoot?: string | undefined } & BrowseFound): FolderChoice[] {
  if (looksLikePath(query)) {
    const seen = new Set<string>()
    const rows: FolderChoice[] = []
    const add = (directory: string, typed: string | undefined, git: boolean | undefined) => {
      if (seen.has(directory)) return
      seen.add(directory)
      rows.push({ directory, label: typed === undefined ? tilde(directory, home) : `${baseName(directory)}/`, detail: tilde(directory, home), kind: "path", ...(typed !== undefined ? { typed } : { here: true }), ...(git ? { git } : {}) })
    }
    if (found.typedDirectory) add(found.typedDirectory, undefined, found.typedGit)
    const completions = found.completions ?? []
    const closer = Math.min(found.prefixCount ?? completions.length, completions.length)
    for (const completion of completions.slice(0, closer)) add(completion.directory, completion.typed, completion.git)
    if (found.create) rows.push({ directory: found.create, label: `+ create folder ${baseName(found.create)}`, detail: tilde(found.create, home), kind: "create" })
    for (const completion of completions.slice(closer)) add(completion.directory, completion.typed, completion.git)
    return rows.slice(0, MAX_CHOICES)
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const kept = folders.filter((directory) => words.every((word) => directory.toLowerCase().includes(word)))
  const counts = new Map<string, number>()
  for (const directory of kept) counts.set(baseName(directory), (counts.get(baseName(directory)) ?? 0) + 1)
  const rows = kept.slice(0, MAX_CHOICES).map((directory): FolderChoice => ({
    directory,
    label: (counts.get(baseName(directory)) ?? 0) > 1 ? directory.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("/") : baseName(directory),
    detail: tilde(directory, home),
    kind: directory === opened ? "open" : "known",
    ...(hub?.folders.has(directory) ? { hub: hub.name } : {}),
  }))
  if (!words.length && browseRoot) rows.splice(rows[0]?.kind === "open" ? 1 : 0, 0, { directory: browseRoot, label: "Browse folders…", detail: browseRoot, kind: "browse", typed: browseRoot })
  return rows
}

/** What a row says at its right end: the open folder, the hub that runs it, a git repository, the typed directory itself, where `Browse folders…` goes, a folder to make. */
const tagOf = (choice: FolderChoice): string =>
  choice.kind === "open" ? "open" : choice.hub ? `· ${choice.hub}` : choice.kind === "browse" ? choice.detail : choice.kind === "create" ? "new" : choice.here ? choice.git ? "here · git" : "here" : choice.git ? "git" : ""

/** The picker, exactly `height` rows by `width` cells, every row closed by the list's rule; `hits` name the rows a click picks (`pick:<index>`). */
export function renderNewChatPicker({ title, query, choices, selected, width, height, ascii, confirming, browsing = looksLikePath(query) }: { title: string; query: string; choices: readonly FolderChoice[]; selected: number; width: number; height: number; ascii?: boolean | undefined; confirming?: boolean | undefined; browsing?: boolean | undefined }): { rows: Line[]; hits: Array<{ row: number; id: string }> } {
  const inner = Math.max(1, width - 1 - PAD_X - 2)
  const body: Array<{ line: Line; lead?: Line; fill?: boolean }> = []
  body.push({ line: [{ text: truncateEnd(title, inner), fg: "primary", bold: true }] })
  body.push({ line: spread([{ text: "> ", fg: "muted" }, { text: truncateEnd(query, Math.max(1, inner - 8)), fg: "text" }, { text: " ", bg: "primary" }], [{ text: String(choices.length), fg: query && !choices.length ? "warning" : "muted" }], inner) })
  const [first, second] = confirming ? ["↵ again makes the folder", "any other key cancels"] : browsing ? ["↵ start  tab complete  → in", "← up  ctrl+u clear  esc back"] : ["type ~/ or a path to browse", "↵ start  tab completes  esc back"]
  body.push({ line: [{ text: truncateEnd(first!, inner), fg: confirming ? "warning" : "muted" }] })
  body.push({ line: [{ text: truncateEnd(second!, inner), fg: confirming ? "warning" : "muted" }] })
  body.push({ line: [] })
  const hits: Array<{ row: number; id: string }> = []
  const detailRows = 2
  const room = Math.max(1, height - body.length - detailRows)
  if (!choices.length) body.push({ line: [{ text: browsing ? "No such directory" : query ? "No folder matches · type a path" : "No folder yet · type a path", fg: "muted" }] })
  const at = Math.max(0, Math.min(selected, choices.length - 1))
  const start = Math.max(0, Math.min(at - room + 1, choices.length - room))
  const end = Math.min(choices.length, start + room)
  for (let index = start; index < end; index++) {
    const choice = choices[index]!
    const picked = index === at
    const tag = tagOf(choice)
    const right: Line = tag ? [{ text: truncateEnd(tag, Math.max(4, Math.floor(inner / 2))), fg: choice.hub ? "primary" : "muted" }] : []
    hits.push({ row: body.length, id: `pick:${index}` })
    body.push({
      line: spread([{ text: truncateEnd(choice.label, Math.max(4, inner - lineWidth(right) - 2)), fg: picked || choice.kind === "open" ? "text" : "muted", bold: picked }], right, inner),
      lead: picked ? [{ text: ascii ? ">" : "›", fg: "muted" }, { text: " " }] : [{ text: "  " }],
      ...(picked ? { fill: true } : {}),
    })
  }
  while (body.length < height - detailRows) body.push({ line: [] })
  // The whole path of the picked folder, cut from the left so its end (the part that tells folders apart) stays.
  const current = choices[at]
  const detail = current ? `${current.hub ? `${current.hub}: ` : ""}${current.detail}` : ""
  const cut = Array.from(detail)
  if (detail && height > body.length) body.push({ line: [] }, { line: [{ text: cut.length > inner ? `…${cut.slice(cut.length - inner + 1).join("")}` : detail, fg: "muted" }] })
  const rows = body.slice(0, height).map(({ line, lead, fill }): Line => {
    const row: Line = [{ text: " " }, ...(lead ?? [{ text: " ".repeat(PAD_X) }]), ...fit(line, inner), { text: " ", fg: "muted" }]
    return [...(fill ? row.map((span) => ({ ...span, bg: "element" as const })) : row), { text: "│", fg: "border" }]
  })
  while (rows.length < height) rows.push([{ text: " ".repeat(width - 1) }, { text: "│", fg: "border" }])
  return { rows, hits: hits.filter((hit) => hit.row < height) }
}

import type { Line } from "../ui/theme"
import { fit, spread } from "./deck"
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
  kind: "open" | "known" | "path"
  /** For a directory read from the disk: what Tab leaves in the field to walk into it. */
  typed?: string
}

const PAD_X = 2
const MAX_CHOICES = 60

const baseName = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory
const tilde = (directory: string, home: string) => home && (directory === home || directory.startsWith(`${home}/`)) ? `~${directory.slice(home.length)}` : directory

/** Whether the typed text names a path (and so is completed from the disk) instead of filtering the known folders. */
export const looksLikePath = (query: string) => /^(~|\/|\.{1,2}(\/|$))/.test(query.trim())

/**
 * The rows for what is typed. `folders` is the open folder first, then the others in the order to show. Not a path: the folders
 * whose path holds every typed word, names sharing a folder name told apart by their parent. A path: `typedDirectory` (the typed
 * text itself, when it is a directory) and then `completions`, the directories that continue it.
 */
export function folderChoices({ folders, opened, query, home, typedDirectory, completions = [] }: { folders: readonly string[]; opened?: string | undefined; query: string; home: string; typedDirectory?: string | undefined; completions?: ReadonlyArray<{ directory: string; typed: string }> }): FolderChoice[] {
  if (looksLikePath(query)) {
    const seen = new Set<string>()
    const rows: FolderChoice[] = []
    for (const found of [...(typedDirectory ? [{ directory: typedDirectory, typed: undefined as string | undefined }] : []), ...completions]) {
      if (seen.has(found.directory)) continue
      seen.add(found.directory)
      rows.push({ directory: found.directory, label: found.typed === undefined ? tilde(found.directory, home) : `${baseName(found.directory)}/`, detail: tilde(found.directory, home), kind: "path", ...(found.typed !== undefined ? { typed: found.typed } : {}) })
    }
    return rows.slice(0, MAX_CHOICES)
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const kept = folders.filter((directory) => words.every((word) => directory.toLowerCase().includes(word)))
  const counts = new Map<string, number>()
  for (const directory of kept) counts.set(baseName(directory), (counts.get(baseName(directory)) ?? 0) + 1)
  return kept.slice(0, MAX_CHOICES).map((directory): FolderChoice => ({
    directory,
    label: (counts.get(baseName(directory)) ?? 0) > 1 ? directory.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("/") : baseName(directory),
    detail: tilde(directory, home),
    kind: directory === opened ? "open" : "known",
  }))
}

/** The picker, exactly `height` rows by `width` cells, every row closed by the list's rule; `hits` name the rows a click picks (`pick:<index>`). */
export function renderNewChatPicker({ title, query, choices, selected, width, height, ascii }: { title: string; query: string; choices: readonly FolderChoice[]; selected: number; width: number; height: number; ascii?: boolean | undefined }): { rows: Line[]; hits: Array<{ row: number; id: string }> } {
  const inner = Math.max(1, width - 1 - PAD_X - 2)
  const body: Array<{ line: Line; lead?: Line; fill?: boolean }> = []
  body.push({ line: [{ text: truncateEnd(title, inner), fg: "primary", bold: true }] })
  body.push({ line: spread([{ text: "> ", fg: "muted" }, { text: truncateEnd(query, Math.max(1, inner - 8)), fg: "text" }, { text: " ", bg: "primary" }], [{ text: String(choices.length), fg: query && !choices.length ? "warning" : "muted" }], inner) })
  body.push({ line: [{ text: looksLikePath(query) ? "↵ start  tab into  esc back" : "↵ start  type a name or a path", fg: "muted" }] })
  body.push({ line: [] })
  const hits: Array<{ row: number; id: string }> = []
  const detailRows = 2
  const room = Math.max(1, height - body.length - detailRows)
  if (!choices.length) body.push({ line: [{ text: looksLikePath(query) ? "No such directory" : query ? "No folder matches · type a path" : "No folder yet · type a path", fg: "muted" }] })
  const at = Math.max(0, Math.min(selected, choices.length - 1))
  const start = Math.max(0, Math.min(at - room + 1, choices.length - room))
  const end = Math.min(choices.length, start + room)
  for (let index = start; index < end; index++) {
    const choice = choices[index]!
    const picked = index === at
    const right: Line = choice.kind === "open" ? [{ text: "open", fg: "muted" }] : []
    hits.push({ row: body.length, id: `pick:${index}` })
    body.push({
      line: spread([{ text: truncateEnd(choice.label, Math.max(4, inner - lineWidth(right) - 2)), fg: picked || choice.kind === "open" ? "text" : "muted", bold: picked }], right, inner),
      lead: picked ? [{ text: ascii ? ">" : "›", fg: "muted" }, { text: " " }] : [{ text: "  " }],
      ...(picked ? { fill: true } : {}),
    })
  }
  while (body.length < height - detailRows) body.push({ line: [] })
  // The whole path of the picked folder, cut from the left so its end (the part that tells folders apart) stays.
  const detail = choices[at]?.detail ?? ""
  const cut = Array.from(detail)
  if (detail && height > body.length) body.push({ line: [] }, { line: [{ text: cut.length > inner ? `…${cut.slice(cut.length - inner + 1).join("")}` : detail, fg: "muted" }] })
  const rows = body.slice(0, height).map(({ line, lead, fill }): Line => {
    const row: Line = [{ text: " " }, ...(lead ?? [{ text: " ".repeat(PAD_X) }]), ...fit(line, inner), { text: " ", fg: "muted" }]
    return [...(fill ? row.map((span) => ({ ...span, bg: "element" as const })) : row), { text: "│", fg: "border" }]
  })
  while (rows.length < height) rows.push([{ text: " ".repeat(width - 1) }, { text: "│", fg: "border" }])
  return { rows, hits: hits.filter((hit) => hit.row < height) }
}

/**
 * The project backlog (feature `backlog`, docs/sidebar.md): the user's own list of pending things for a project, kept by the
 * daemon across sessions. Zod-free data, shared by the daemon, the terminal and the headless command.
 */

/** The list is small on purpose: past `items` an add is refused until finished ones are cleared. */
export const BACKLOG_LIMITS = { items: 200, text: 300, path: 400, commit: 64 } as const

/** Where an item was born, so it can be opened from there: the session it was added in and, when given, a file or a commit. */
export type BacklogOrigin = { sessionId?: string | undefined; path?: string | undefined; commit?: string | undefined }
/** `id` is the number the user types; it is never reused within a project. */
export type BacklogItem = { id: number; text: string; done: boolean; createdAt: number; doneAt?: number | undefined; origin?: BacklogOrigin | undefined }
export type BacklogReport = { directory: string; items: BacklogItem[] }
/** One change of the user's (`backlog.change`). */
export type BacklogEdit =
  | { op: "add"; text: string; origin?: BacklogOrigin | undefined }
  | { op: "done" | "reopen" | "remove"; id: number }
  | { op: "clear-done" }

/** Open items first, each group oldest first: the order every surface lists them in. */
export const backlogOrder = (items: readonly BacklogItem[]): BacklogItem[] => [...items].sort((a, b) => Number(a.done) - Number(b.done) || a.id - b.id)

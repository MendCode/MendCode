export type MemoryNoticeAction = "saved" | "updated" | "removed"

const PREVIEW_CHARS = 60

/** The first 60 characters of a memory on one line. */
export function memoryPreview(text: string) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
}

/** `Memory  saved · project · "Use bun"`: what a memory write says in the transcript; the toast carries the same facts. */
export function memoryNoticeText(input: { action: MemoryNoticeAction; scope: string; text: string }) {
  return `Memory  ${input.action} · ${input.scope} · "${memoryPreview(input.text)}"`
}

/** Item meta for a memory write: the marker the transcript keys on, and what `/memory undo` and the open card read. */
export function memoryNoticeMeta(input: { action: MemoryNoticeAction; memoryId: string; scope: string; text: string }) {
  return { memorySaved: true, memoryChange: input.action, memoryId: input.memoryId, memoryScope: input.scope, memoryText: input.text.replace(/\s+/g, " ").trim().slice(0, 2_000) }
}

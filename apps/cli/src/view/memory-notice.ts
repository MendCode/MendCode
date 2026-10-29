import type { ToastVariant } from "./toast"

/** The first 60 characters of a memory on one line. */
export function memoryPreview(text: string) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

export type MemoryChange = { change: "added" | "updated" | "deleted" | "linked"; scope?: string | undefined; status?: string | undefined; text?: string | undefined }
export type MemoryToast = { title: string; message: string; variant: ToastVariant; hint?: string }

/**
 * What a `memory.changed` event says: `Memory saved`, `Memory updated` or `Memory removed`, then the scope and the start of the
 * memory. Never a bare title: an event that does not say what changed (a link, a draft, an older daemon) shows nothing.
 * Only a memory that is saved says anything; proposals have their own places (the approval card, `/memory`).
 */
export function memoryToast(event: MemoryChange): MemoryToast | undefined {
  if (!event.text?.trim() || !event.scope || event.change === "linked") return undefined
  if (event.status !== "saved") return undefined
  const detail = `${event.scope} · "${memoryPreview(event.text)}"`
  if (event.change === "added") return { title: "Memory saved", message: detail, variant: "success", hint: "/memory undo" }
  if (event.change === "updated") return { title: "Memory updated", message: detail, variant: "info" }
  return { title: "Memory removed", message: detail, variant: "info" }
}

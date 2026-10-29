import type { BlobRef } from "@mendcode/protocol"
import type { ModelMessage } from "./provider"

/** Newest distinct session images in conversation order; no remote downloads. */
export async function recentImageReferences(messages: ModelMessage[], count: number, readBlob?: (ref: BlobRef) => Promise<Uint8Array>) {
  if (count < 1 || count > 5) return []
  const refs: BlobRef[] = []
  const seen = new Set<string>()
  for (const message of messages.toReversed()) {
    if (message.role !== "user") continue
    for (const ref of (message.attachments ?? []).toReversed()) {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(ref.mime) || seen.has(ref.sha256)) continue
      seen.add(ref.sha256)
      refs.push(ref)
      if (refs.length === count) break
    }
    if (refs.length === count) break
  }
  if (!readBlob) return []
  const images = []
  for (const ref of refs.toReversed()) {
    if (ref.bytes > 50 * 1024 * 1024) throw new Error("Image reference exceeds 50 MB")
    const bytes = await readBlob(ref)
    if (bytes.length > 50 * 1024 * 1024) throw new Error("Image reference exceeds 50 MB")
    images.push({ mime: ref.mime, bytes })
  }
  return images
}

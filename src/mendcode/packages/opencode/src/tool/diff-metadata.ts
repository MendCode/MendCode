export const MAX_PERSISTED_DIFF_BYTES = 512 * 1024
export const PERSISTED_DIFF_COPY_BYTES = MAX_PERSISTED_DIFF_BYTES / 2
export const APPLY_PATCH_DIFF_BYTES = PERSISTED_DIFF_COPY_BYTES
export const APPLY_PATCH_FILES_BYTES = PERSISTED_DIFF_COPY_BYTES

export function previewDiff(text: string, maxBytes: number) {
  const source = Buffer.from(text, "utf8")
  if (source.byteLength <= maxBytes) {
    return { content: text, truncated: false as const, originalBytes: source.byteLength }
  }

  const marker = Buffer.from(
    `\n\n... diff truncated; original ${source.byteLength.toLocaleString()} bytes ...\n\n`,
    "utf8",
  )
  if (marker.byteLength >= maxBytes) {
    return {
      content: marker.subarray(0, Math.max(0, maxBytes)).toString("utf8"),
      truncated: true as const,
      originalBytes: source.byteLength,
    }
  }

  const budget = maxBytes - marker.byteLength
  let head = Math.floor(budget / 2)
  let tail = source.byteLength - (budget - head)
  while (head > 0 && (source[head] & 0xc0) === 0x80) head--
  while (tail < source.byteLength && (source[tail] & 0xc0) === 0x80) tail++

  return {
    content: Buffer.concat([source.subarray(0, head), marker, source.subarray(tail)]).toString("utf8"),
    truncated: true as const,
    originalBytes: source.byteLength,
  }
}

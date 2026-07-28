import { Effect } from "effect"
import { AppFileSystem } from "@mendcode/core/filesystem"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)
const NON_TEXT_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const BINARY_SAMPLE_BYTES = 16 * 1024

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export function decode(bytes: Uint8Array) {
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
}

export function isBinary(bytes: Uint8Array) {
  if (bytes.length === 0) return false

  const samples =
    bytes.length <= BINARY_SAMPLE_BYTES * 2
      ? [bytes]
      : [bytes.subarray(0, BINARY_SAMPLE_BYTES), bytes.subarray(bytes.length - BINARY_SAMPLE_BYTES)]
  const decoder = new TextDecoder("utf-8", { fatal: true })

  for (const sample of samples) {
    try {
      if (NON_TEXT_PATTERN.test(decoder.decode(sample))) return true
    } catch {
      return true
    }
  }

  return false
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: AppFileSystem.Interface, filePath: string) {
  return decode(yield* fs.readFile(filePath))
})

export const syncFile = Effect.fn("Bom.syncFile")(function* (
  fs: AppFileSystem.Interface,
  filePath: string,
  bom: boolean,
) {
  const current = yield* readFile(fs, filePath)
  if (current.bom === bom) return current.text
  yield* fs.writeWithDirs(filePath, join(current.text, bom))
  return current.text
})

import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { decodeImageBytes, webpSize, type PetImage } from "../pets/decode"

/** Experimental bots: an `avatar` path in a bot's file is untrusted input, so it is held to the pets' rules with smaller limits (a face is a few cells). */
export const MAX_AVATAR_BYTES = 1024 * 1024
export const MAX_AVATAR_SIDE = 512
const EXTENSIONS = [".png", ".webp"]
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const inside = (folder: string, file: string) => {
  const path = relative(folder, file)
  return path !== "" && !path.startsWith("..") && !isAbsolute(path)
}

/** Width and height from the file header alone, so a hostile file cannot make us allocate before the size check. */
function headerSize(bytes: Uint8Array): { width: number; height: number } {
  const tag = (at: number) => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // The decoder takes the last IHDR it meets, so the one read here must be the only one, and the first chunk as the format says.
    if (view.getUint32(8) !== 13 || tag(12) !== "IHDR") throw new TypeError("[BOTS]: avatar PNG does not start with its header")
    for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
      if (at > 8 && tag(at + 4) === "IHDR") throw new TypeError("[BOTS]: avatar PNG has more than one header")
      if (tag(at + 4) === "IEND") break
    }
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") return webpSize(bytes)
  throw new TypeError("[BOTS]: avatar is not a PNG or WebP image")
}

/**
 * The picture a bot's `avatar` names, as pixels. The file must be a `.png` or `.webp` inside one of the `allowed` folders (after links are
 * resolved), at most 1 MiB and 512 by 512 pixels, and a PNG or WebP by content. A relative path is read from `base`.
 */
export async function loadBotAvatar({ path, allowed, base }: { path: string; allowed: readonly string[]; base?: string }): Promise<PetImage> {
  const real = await Promise.all(allowed.map((folder) => realpath(folder).catch(() => resolve(folder))))
  const wanted = resolve(base ?? allowed[0] ?? ".", path)
  if (![...allowed.map((folder) => resolve(folder)), ...real].some((folder) => inside(folder, wanted))) throw new RangeError("[BOTS]: avatar is outside the allowed folders")
  const file = await realpath(wanted).catch(() => { throw new TypeError(`[BOTS]: avatar ${path} cannot be read`) })
  if (!real.some((folder) => inside(folder, file))) throw new RangeError("[BOTS]: avatar is outside the allowed folders")
  if (!EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension))) throw new TypeError("[BOTS]: avatar must be a .png or .webp file")
  const info = await stat(file)
  if (!info.isFile()) throw new TypeError("[BOTS]: avatar is not a file")
  if (info.size > MAX_AVATAR_BYTES) throw new RangeError(`[BOTS]: avatar is larger than ${MAX_AVATAR_BYTES} bytes`)
  const bytes = new Uint8Array(await readFile(file))
  const { width, height } = headerSize(bytes)
  if (width < 1 || height < 1) throw new RangeError("[BOTS]: avatar has an empty image")
  if (width > MAX_AVATAR_SIDE || height > MAX_AVATAR_SIDE) throw new RangeError(`[BOTS]: avatar ${width}x${height} exceeds ${MAX_AVATAR_SIDE}px`)
  return decodeImageBytes(bytes)
}

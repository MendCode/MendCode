import { spawn } from "node:child_process"
import { copyFile, mkdir, open, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Opens `url` with the system's own handler (the default browser for http/https): `open`, `explorer.exe` or `xdg-open`. */
export const openUrl = (url: string) => new Promise<void>((resolve, reject) => {
  const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open"
  const child = spawn(program, [url], { stdio: "ignore", detached: true })
  child.once("error", () => reject(new Error("Could not open the browser")))
  child.once("spawn", () => { child.unref(); resolve() })
})

const IMAGE_MAGIC: Array<{ extension: string; matches(bytes: Uint8Array): boolean }> = [
  { extension: "png", matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { extension: "jpg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { extension: "gif", matches: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { extension: "webp", matches: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
]
const NAMED = /\.(png|jpe?g|gif|webp)$/i

/**
 * A generated image's Open and Reveal buttons: the file must be a regular file whose bytes are a PNG, JPEG, GIF or WebP image
 * (whatever its name), so the system's handler only ever gets a picture. Reveal shows it selected in its folder (Finder, Explorer)
 * or opens the folder (Linux). A file without an image extension (a stored blob is named by its hash) opens through a copy that
 * has one, in the system's temporary folder, so the viewer and not a text editor takes it.
 */
export async function openImage(input: { path: string; reveal?: boolean }, run: (program: string, args: string[]) => Promise<void> = launch) {
  const real = await realpath(input.path).catch(() => { throw new Error("[OPEN]: the image is no longer there") })
  const handle = await open(real, "r").catch(() => { throw new Error("[OPEN]: the image cannot be read") })
  let kind: (typeof IMAGE_MAGIC)[number] | undefined
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error("[OPEN]: not a file")
    const head = new Uint8Array(12)
    await handle.read(head, 0, 12, 0)
    kind = IMAGE_MAGIC.find((entry) => entry.matches(head))
    if (!kind) throw new Error("[OPEN]: not an image")
  } finally { await handle.close() }
  if (!input.reveal) {
    let target = real
    if (!NAMED.test(real)) {
      const dir = path.join(tmpdir(), "mendcode-open")
      await mkdir(dir, { recursive: true, mode: 0o700 })
      target = path.join(dir, `${path.basename(real)}.${kind.extension}`)
      await copyFile(real, target)
    }
    return run(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open", [target])
  }
  if (process.platform === "darwin") return run("open", ["-R", real])
  if (process.platform === "win32") return run("explorer.exe", [`/select,${real}`])
  return run("xdg-open", [path.dirname(real)])
}

const launch = (program: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(program, args, { stdio: "ignore", detached: true })
  child.once("error", () => reject(new Error("[OPEN]: no program to open it with")))
  child.once("spawn", () => { child.unref(); resolve() })
})

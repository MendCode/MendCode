import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { writeHeapSnapshot } from "node:v8"

export async function writeSnapshot(dir: string, name: "tui", capture = writeHeapSnapshot) {
  const folder = path.join(dir, "diagnostics")
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  const file = path.join(folder, `${name}-${Date.now()}-${crypto.randomUUID()}.heapsnapshot`)
  await writeFile(file, "", { flag: "wx", mode: 0o600 })
  capture(file)
  await chmod(file, 0o600)
  return file
}

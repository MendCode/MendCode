import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import path from "node:path"

/**
 * Links an existing ChatGPT login into the isolated home so a harness can use it without the kit ever reading,
 * copying or writing the credential. `authFrom` is a directory (a Codex home) holding `auth.json`; `models_cache.json`
 * is linked too when asked for (the native engine's model catalog reads it). Symlinks keep the source file the single copy.
 */
export function linkAuth(authFrom: string, codexHome: string, options: { modelsCache: boolean }): string[] {
  const source = path.resolve(authFrom)
  const auth = path.join(source, "auth.json")
  if (!existsSync(auth)) throw new Error(`[AUTH]: ${source} has no auth.json; point --auth-from at a directory that holds a ChatGPT login`)
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  const linked: string[] = []
  const files = options.modelsCache ? ["auth.json", "models_cache.json"] : ["auth.json"]
  for (const name of files) {
    const from = path.join(source, name)
    if (!existsSync(from)) continue
    symlinkSync(from, path.join(codexHome, name))
    linked.push(name)
  }
  return linked
}

export function randomId(bytes = 4): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex")
}

export function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : []
}

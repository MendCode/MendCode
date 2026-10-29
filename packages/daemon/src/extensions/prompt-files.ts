import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { PROMPT_FILES } from "@mendcode/extension-api"
import type { SystemPart } from "@mendcode/engine-native"
import type { ExtensionLayer } from "@mendcode/packages"

/** A prompt file bigger than this is ignored: it would swamp the context it is meant to shape. */
export const MAX_PROMPT_FILE_BYTES = 64 * 1024

export type PromptOverrides = { system?: string; appendSystem?: string; compaction?: string }

type Entry = { signature: string; overrides: PromptOverrides }

/**
 * `SYSTEM.md`, `APPEND_SYSTEM.md` and `COMPACTION.md` of the extension layers: the last layer that has a file wins,
 * so the project's own folder beats its packages, which beat the user's folder. Reads are cached by mtime and size,
 * so a turn costs a few `stat` calls and an edited file applies to the next model call.
 */
export function createPromptFiles({ layersFor, enabled }: { layersFor(directory: string): ExtensionLayer[]; enabled: boolean }) {
  const cache = new Map<string, Entry>()
  const kinds = Object.entries(PROMPT_FILES) as Array<[keyof typeof PROMPT_FILES, string]>

  function read(directory: string): PromptOverrides {
    if (!enabled) return {}
    const root = path.resolve(directory)
    const found: Array<{ kind: keyof typeof PROMPT_FILES; file: string; signature: string }> = []
    for (const layer of layersFor(root)) {
      for (const [kind, name] of kinds) {
        const file = path.join(layer.dir, name)
        const info = statSync(file, { throwIfNoEntry: false })
        if (info?.isFile() && info.size <= MAX_PROMPT_FILE_BYTES) found.push({ kind, file, signature: `${file}:${info.mtimeMs}:${info.size}` })
      }
    }
    const signature = found.map((entry) => entry.signature).join("\n")
    const cached = cache.get(root)
    if (cached?.signature === signature) return cached.overrides
    const overrides: PromptOverrides = {}
    for (const { kind, file } of found) {
      try {
        const text = readFileSync(file, "utf8").trim()
        if (text) overrides[kind] = text
      } catch {
        // A file that vanished between the stat and the read counts as absent.
      }
    }
    cache.set(root, { signature, overrides })
    return overrides
  }

  return { read }
}

export type PromptFiles = ReturnType<typeof createPromptFiles>

/**
 * The system prompt as parts: `SYSTEM.md` replaces the packaged base prompt (the same `{{cwd}}` template),
 * `rest` (instructions, skills, memory) follows, and `APPEND_SYSTEM.md` ends as a part of its own so `/context` shows it.
 */
export function systemPartsWith({ files, root, packaged, rest }: { files: PromptOverrides; root: string; packaged(root: string): string; rest: SystemPart[] }): SystemPart[] {
  return [
    { id: "base", label: files.system ? "base prompt (SYSTEM.md)" : "base prompt", text: files.system ? files.system.replaceAll("{{cwd}}", root) : packaged(root) },
    ...rest,
    ...(files.appendSystem ? [{ id: "append", label: "appended prompt (APPEND_SYSTEM.md)", text: files.appendSystem }] : []),
  ]
}

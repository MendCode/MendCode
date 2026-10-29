import type { OutputFilter } from "./types"

const GIT = /(?:^|[\s;&|(])git\s+(?:-[-\w=./]+\s+)*(status|diff|show|push|pull|fetch|clone|checkout|switch|merge|rebase|log)\b/
/** `git status` coaching text: `(use "git add <file>..." to update what will be committed)`. */
const HINT = /^\s*\(use "git [^"]+"[^)]*\)\s*$/
/** Transfer progress and the blob ids of a diff header: noise a model never acts on. */
const PROGRESS = /^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Writing|Unpacking) (?:objects|deltas)\b/
const INDEX = /^index [0-9a-f]{6,}\.\.[0-9a-f]{6,}(?: \d+)?$/

/** git status hints, diff `index` lines and transfer progress are dropped; every path, hunk and message stays. */
export const git: OutputFilter = {
  id: "git",
  matches: ({ tool, command }) => (tool === "shell" || tool === "shell_output") && GIT.test(command),
  apply(text) {
    return text.split("\n").filter((line) => !HINT.test(line) && !PROGRESS.test(line) && !INDEX.test(line)).join("\n")
  },
}

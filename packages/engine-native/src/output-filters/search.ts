import type { OutputFilter } from "./types"

const SEARCH = /^\s*(?:git\s+grep|grep|egrep|ugrep|rg|ripgrep|ag)\b/
const HIT = /^([^\s:][^:]*):(\d+):(.*)$/

/** `path:line:text` hits grouped under their path: the path is printed once per file instead of once per hit. */
export const search: OutputFilter = {
  id: "search",
  matches: ({ tool, command }) => (tool === "shell" || tool === "shell_output") && SEARCH.test(command) && !/\s-[a-zA-Z]*[lcL]\b|--count|--files-with/.test(command),
  apply(text) {
    const lines = text.split("\n")
    const hits = lines.filter((line) => HIT.test(line))
    if (hits.length < 8 || new Set(hits.map((line) => HIT.exec(line)![1])).size === hits.length) return text
    const out: string[] = []
    let current = ""
    for (const line of lines) {
      const hit = HIT.exec(line)
      if (!hit) {
        current = ""
        out.push(line)
        continue
      }
      if (hit[1] !== current) {
        current = hit[1]!
        out.push(`${current}:`)
      }
      out.push(`  ${hit[2]}: ${hit[3]}`)
    }
    return out.join("\n")
  },
}

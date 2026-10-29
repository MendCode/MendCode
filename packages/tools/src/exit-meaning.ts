/**
 * Commands whose exit code 1 is an answer rather than a failure: a search that matched nothing, a comparison that found a
 * difference, a condition that is false. Their own errors exit with 2 or more.
 */
const EXIT_ONE_MEANING: Readonly<Record<string, string>> = {
  grep: "no match", egrep: "no match", fgrep: "no match", zgrep: "no match", rg: "no match",
  diff: "files differ", cmp: "files differ",
  test: "false", "[": "false", "[[": "false",
}
const GIT_EXIT_ONE_MEANING: Readonly<Record<string, string>> = { grep: "no match", diff: "files differ" }

/**
 * What exit code 1 means when the last command of `command` is one of those (`printenv | grep X`, `a && diff x y`); undefined
 * for anything else, for a negated command and under `pipefail`, where the 1 may come from an earlier command.
 */
export function exitOneMeaning(command: string): string | undefined {
  if (command.includes("pipefail")) return undefined
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/\d*>&\d+|&>>?/g, " ")
  const last = bare.split(/\|\||&&|[|;&\n]/).map((part) => part.trim()).filter(Boolean).pop()
  if (!last) return undefined
  const words = last.replace(/^[({\s]+/, "").split(/\s+/)
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) words.shift()
  const name = (words[0] ?? "").split("/").pop() ?? ""
  if (name === "git") return GIT_EXIT_ONE_MEANING[words.find((word, index) => index > 0 && !word.startsWith("-")) ?? ""]
  return EXIT_ONE_MEANING[name]
}

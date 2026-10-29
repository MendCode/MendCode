/** Index of the first word that is not a flag (`--dir` and `--format` take a value); -1 when there is none. */
function commandOffset(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) return i
    if (token === "--dir" || token === "--format") i++
  }
  return -1
}

/**
 * Background-session shorthands over `session`, so a run started with `run --bg` is as easy to follow as a shell job:
 * `ps` → `session list --active`, `logs ID [-f]` → `session events ID [--follow]`, `kill ID` → `session cancel ID`.
 * `attach ID` opens the terminal UI on that session and is handled by the startup parser instead.
 */
export function jobAliases(argv: string[]): string[] {
  const index = commandOffset(argv)
  if (index < 0) return argv
  const word = argv[index]
  const head = argv.slice(0, index)
  const rest = argv.slice(index + 1)
  if (word === "ps") return [...head, "session", "list", "--active", ...rest]
  if (word === "logs") return [...head, "session", "events", ...rest.map((token) => token === "-f" ? "--follow" : token)]
  if (word === "kill") return [...head, "session", "cancel", ...rest]
  return argv
}

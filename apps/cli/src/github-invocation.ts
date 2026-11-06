/** Shared with transport flag parsing, without loading command help or the GitHub parser at startup. */
export const GITHUB_VALUE_FLAGS = new Set(["session", "dir", "data-dir", "project", "cwd", "engine", "format", "compat", "token", "model", "variant", "effort", "event", "prompt", "mentions", "connect", "server-url", "ca", "token-file", "socket", "release", "sha256"])

/** Locate command words without mistaking credential/transport option values for commands. */
export function githubInvocation(argv: string[]) {
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith("--")) { if (!token.includes("=") && GITHUB_VALUE_FLAGS.has(token.slice(2))) i++; continue }
    if (token === "-h" || token === "-v") continue
    words.push(token)
  }
  return words[0] === "github" ? words[1] === "run" ? "github.run" : "github.install" : words[0] === "pr" ? "pr" : undefined
}

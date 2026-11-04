import { PROGRAM_NAME } from "@mendcode/program"
import { quote } from "./agent-origin"

/** The whole command for the user's own terminal (nothing cut), in the folder it ran in when it did not name one. Loaded only when a run's higher mode is refused. */
export function operatorCommand(argv: readonly string[], directory: string) {
  const words = argv.map((word, index) => (/^--?(?:token|password|api-key|client-secret)$/i.test(argv[index - 1] ?? "") ? "…" : quote(word)))
  if (!argv.some((word) => /^--(?:cwd|project)(?:=|$)/.test(word))) words.splice(argv.indexOf("run") + 1, 0, "--cwd", quote(directory))
  return [PROGRAM_NAME, ...words].join(" ")
}

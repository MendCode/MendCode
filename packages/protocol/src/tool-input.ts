/** A tool input this long is still being written by the model for a while (a whole file, a long script): its card opens before it ends. */
export const EARLY_TOOL_CHARS = 1_500
/** A card that opened early hears how much of its input is written at most once per this many characters. */
export const INPUT_PROGRESS_CHARS = 2_000

/** How much of a tool input is written: its characters and the lines of its text (a file's content, a script). */
export const toolInputProgress = (json: string) => ({ chars: json.length, lines: (json.match(/\\n/g)?.length ?? 0) + 1 })

/**
 * The string fields of a tool input that is still streaming, in order, the unfinished last one included: enough for the call's title
 * (a path, a command's first line). Other values and nested objects are skipped; a key written twice keeps its first value.
 */
export function partialToolArgs(json: string): Record<string, string> {
  const args: Record<string, string> = {}
  for (const match of json.matchAll(/"([A-Za-z_]\w*)"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
    const key = match[1] as string
    if (key in args) continue
    try { args[key] = JSON.parse(`"${(match[2] as string).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "")}"`) as string } catch {}
  }
  return args
}

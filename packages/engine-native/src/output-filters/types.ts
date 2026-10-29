/** What a filter may look at: the tool, the command line it ran, and whether the result is an error. */
export type FilterInput = { tool: string; command: string; isError: boolean }

/**
 * One filter = one module in this folder. `apply` is pure and only drops or folds noise: it never reorders what stays,
 * never touches a line that looks like a failure, and the unfiltered text is always kept on disk by the engine.
 */
export type OutputFilter = {
  id: string
  matches(input: FilterInput): boolean
  apply(text: string): string
}

/** A line the filters must never fold away. */
export const FAILURE_LINE = /\b(error|fail(?:ed|ure|ing)?|fatal|panic|exception|traceback|warn(?:ing)?|denied|cannot|not found)\b|[✗✘×]|\(fail\)/i

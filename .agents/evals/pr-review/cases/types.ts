import type { PR_FINDING_CATEGORIES } from "@mendcode/protocol"

/**
 * One pull request of the PR-reviewer eval: the base repository, what the PR changes, and the defects seeded into it. A clean
 * case seeds none: every finding on it is a false positive. `line` is a line of the head file, on the diff's new side
 * (`run.ts --dry-run` checks that every seeded line is one the diff adds).
 */
export type SeededDefect = { path: string; line: number; category: (typeof PR_FINDING_CATEGORIES)[number]; note: string }
export type PrCase = {
  id: string
  title: string
  /** Files of the base commit. */
  base: Record<string, string>
  /** Files the PR writes (`null` deletes one). */
  head: Record<string, string | null>
  defects: SeededDefect[]
}

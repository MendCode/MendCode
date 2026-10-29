import { COLOR_NAMES, defineTheme, type ColorName } from "./define"
import mono from "./mono"

/** RGB references serve content calculations only. SGR uses the host's ANSI palette exclusively. */
export default defineTheme({
  ...mono,
  name: "terminal",
  label: "Terminal",
  ansi: Object.freeze(Object.fromEntries(COLOR_NAMES.map((role) => [role, ({
    primary: 2, accent: 2, heading: 2, code: 6, link: 12, success: 2,
    warning: 3, error: 1, info: 6, border: 8, borderActive: 7, muted: 8,
    secondary: 6, synComment: 8, synKeyword: 5, synString: 2,
    synNumber: 3, synFunction: 6, synType: 4, synFlag: 5, synPrompt: 8,
    mdHeading1: 2, mdHeading2: 2, mdInlineCode: 6, mdStrike: 8, mdLink: 12, mdFootnote: 12, mdQuote: 8, mdQuoteBar: 8,
    mdNote: 6, mdTip: 2, mdImportant: 5, mdWarning: 3, mdCaution: 1, mdTableHeader: 2, mdTableBorder: 8, mdListMarker: 8,
    mdTaskDone: 2, mdTaskOpen: 8, mdRule: 8, mdCodeLabel: 8, mdCodeBorder: 8, mdCopy: 8, mdDiagramLine: 2, mdDiagramAccent: 2,
    commentMark: 5, commentRule: 6, commentQuote: 8,
  } as Partial<Record<ColorName, number>>)[role] ?? "default"])) as Record<ColorName, number | "default">),
})

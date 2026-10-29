import type { ColorName } from "../ui/theme"
import type { TuiProfile } from "./tui-profile"

export type TableStyle = "box" | "rules" | "grid" | "minimal"
export type HeadingStyle = "banner" | "bold" | "underline" | "uppercase"
/** Where a visible `copy` hint is drawn: fenced code and table/diagram borders (`all`), fenced code only, or nowhere. Copying by key works in every case. */
export type CopyScope = "all" | "code" | "off"

/**
 * How the Markdown renderer draws. `enhanced` is the `full` renderer's engine (code headers, table styles, heading
 * styles, callouts, copy buttons, right-to-left text); the classic style is what the `markdown` renderer, the minimal
 * view and every other caller of `renderMarkdown` get, unchanged. `copy` only decides which hints are visible.
 */
export type MarkdownStyle = {
  enhanced: boolean
  table: TableStyle
  heading: HeadingStyle
  copy: CopyScope
  rtl: boolean
}

export const CLASSIC_STYLE: MarkdownStyle = { enhanced: false, table: "box", heading: "bold", copy: "off", rtl: false }

type MarkdownSettings = Pick<TuiProfile, "tableStyle" | "headingStyle" | "markdownCopyHints" | "markdownRtl" | "messageRenderer">

/**
 * The style a transcript draws assistant messages in. Only the `full` renderer is enhanced, and never in the minimal view
 * (plain, no buttons). `auto` settings resolve per view: the balanced view keeps bold headings and puts copy buttons on
 * code only; the full view underlines h1/h2 and adds table and diagram hints.
 */
export function markdownStyleFor(input: { profile: MarkdownSettings; mode: "minimal" | "balanced" | "full" }): MarkdownStyle {
  const { profile, mode } = input
  if (profile.messageRenderer !== "full" || mode === "minimal") return CLASSIC_STYLE
  const calm = mode === "balanced"
  return {
    enhanced: true,
    table: profile.tableStyle === "auto" ? "box" : profile.tableStyle,
    heading: profile.headingStyle === "auto" ? (calm ? "bold" : "underline") : profile.headingStyle,
    copy: profile.markdownCopyHints === "auto" ? (calm ? "code" : "all") : profile.markdownCopyHints,
    rtl: profile.markdownRtl,
  }
}

export const styleKey = (style: MarkdownStyle) => (style.enhanced ? `e:${style.table}:${style.heading}:${style.copy}:${style.rtl ? 1 : 0}` : "c")

/** The colour role of each Markdown token. The classic style keeps the roles the renderer always used; the enhanced one has a named slot per token. */
export type Roles = {
  h1: ColorName
  h2: ColorName
  h3: ColorName
  h4: ColorName
  inlineCode: ColorName
  strike: ColorName
  link: ColorName
  footnote: ColorName
  quote: ColorName
  quoteBar: ColorName
  note: ColorName
  tip: ColorName
  important: ColorName
  warning: ColorName
  caution: ColorName
  tableHeader: ColorName
  tableBorder: ColorName
  listMarker: ColorName
  taskDone: ColorName
  taskOpen: ColorName
  rule: ColorName
  codeLabel: ColorName
  codeBorder: ColorName
  copy: ColorName
  diagramLine: ColorName
  diagramAccent: ColorName
}

export const CLASSIC_ROLES: Roles = {
  h1: "heading", h2: "heading", h3: "heading", h4: "heading",
  inlineCode: "code", strike: "muted", link: "link", footnote: "muted",
  quote: "muted", quoteBar: "muted", note: "info", tip: "success", important: "accent", warning: "warning", caution: "error",
  tableHeader: "heading", tableBorder: "border", listMarker: "muted", taskDone: "success", taskOpen: "muted", rule: "muted",
  codeLabel: "muted", codeBorder: "border", copy: "muted", diagramLine: "heading", diagramAccent: "accent",
}

export const ENHANCED_ROLES: Roles = {
  h1: "mdHeading1", h2: "mdHeading2", h3: "mdHeading3", h4: "mdHeading4",
  inlineCode: "mdInlineCode", strike: "mdStrike", link: "mdLink", footnote: "mdFootnote",
  quote: "mdQuote", quoteBar: "mdQuoteBar", note: "mdNote", tip: "mdTip", important: "mdImportant", warning: "mdWarning", caution: "mdCaution",
  tableHeader: "mdTableHeader", tableBorder: "mdTableBorder", listMarker: "mdListMarker", taskDone: "mdTaskDone", taskOpen: "mdTaskOpen", rule: "mdRule",
  codeLabel: "mdCodeLabel", codeBorder: "mdCodeBorder", copy: "mdCopy", diagramLine: "mdDiagramLine", diagramAccent: "mdDiagramAccent",
}

export const rolesOf = (style: MarkdownStyle): Roles => (style.enhanced ? ENHANCED_ROLES : CLASSIC_ROLES)

export const CALLOUTS = ["note", "tip", "important", "warning", "caution"] as const
export type Callout = (typeof CALLOUTS)[number]

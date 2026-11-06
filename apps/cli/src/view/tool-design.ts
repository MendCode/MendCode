import { DEFAULT_TOOL_DESIGN_NAME, TOOL_DESIGN_NAME } from "@mendcode/protocol/wire"
import { COLOR_NAMES, type ColorName } from "../themes/define"
import { textWidth } from "./wrap"

/**
 * Tool designs (the `toolDesign` setting): the whole look of the tool cards as data, never as code. A design says how the
 * header starts (the kind's glyph or one bullet), how the label and target are joined, what the body hangs from (a rule beside
 * every row, a branch on its first row, nothing), how a diff is drawn (tinted rows, tinted code or signs only, with or without
 * line numbers), how many rows of a command's output show, and which theme role colours each part. The built-in `rail` is the
 * cards as they always were; the other built-ins and any `tool-designs/<name>.json` of a profile, the user's data folder or the
 * project's `.mendcode/` are read through the same parser, so a file can do exactly what a built-in does.
 */

/** A glyph and its ASCII stand-in (the `glyphs: ascii` mode and MENDCODE_GLYPHS=ascii). */
export type DesignGlyph = readonly [unicode: string, ascii: string]

export type ToolDesign = {
  name: string
  label: string
  description: string
  header: {
    /** `kind`: the glyph of the tool's kind (▤ read, $ shell, ✎ edit); `bullet`: the same `bullet` for every call. */
    mark: "kind" | "bullet"
    bullet: DesignGlyph
    /** `spaced`: `Edit src/a.ts`; `parens`: `Edit(src/a.ts)`. */
    call: "spaced" | "parens"
    /** False leaves the tool's name out of the header: the glyph and the target say it. */
    label: boolean
  }
  rail: {
    /** `line`: a rule beside every body row; `branch`: one mark on the first row under each header; `none`: blank. */
    kind: "line" | "branch" | "none"
    glyph: DesignGlyph
  }
  diff: {
    /** `row`: a changed line is tinted from the rule to the edge, its number and sign inside; `code`: only its code; `none`: no tint. */
    tint: "row" | "code" | "none"
    numbers: boolean
    signs: boolean
  }
  output: {
    /** Rows of a finished command's output a collapsed card shows. */
    rows: number
  }
  colors: {
    /** The resting (finished, successful) colour of the header's mark and of the rule; unset, the status colours them. */
    mark?: ColorName
    rule?: ColorName
    label: ColorName
    target: ColorName
    number: ColorName
    added: ColorName
    removed: ColorName
    addedBg: ColorName
    removedBg: ColorName
    output: ColorName
  }
}

export { DEFAULT_TOOL_DESIGN_NAME, TOOL_DESIGN_NAME }

/** The cards as they were before designs existed: the kind's glyph, a rule beside the body, tinted diff rows. */
export const DEFAULT_TOOL_DESIGN: ToolDesign = {
  name: DEFAULT_TOOL_DESIGN_NAME,
  label: "Rail",
  description: "The kind's glyph, a thin rule beside the body, tinted diff rows with line numbers",
  header: { mark: "kind", bullet: ["●", "*"], call: "spaced", label: true },
  rail: { kind: "line", glyph: ["│", "|"] },
  diff: { tint: "row", numbers: true, signs: true },
  output: { rows: 6 },
  colors: { label: "muted", target: "text", number: "muted", added: "success", removed: "error", addedBg: "diffAddedBg", removedBg: "diffRemovedBg", output: "muted" },
}

const MAX_OUTPUT_ROWS = 20
const SECTIONS = ["label", "description", "header", "rail", "diff", "output", "colors"] as const
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  header: ["mark", "bullet", "call", "label"],
  rail: ["kind", "glyph"],
  diff: ["tint", "numbers", "signs"],
  output: ["rows"],
  colors: ["mark", "rule", "label", "target", "number", "added", "removed", "addedBg", "removedBg", "output"],
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
/** The theme roles, made the first time a design is parsed (none is at start with the default design). */
let colorRoles: ReadonlySet<string> | undefined
const isColorRole = (value: string) => (colorRoles ??= new Set(COLOR_NAMES)).has(value)
/** Printable text without escapes or line breaks; a glyph must also take exactly one cell (the body's columns never move). */
const GLYPH = /^[^\x00-\x1f\x7f-\x9f]{1,4}$/u

/**
 * A design from its JSON: every field is optional and falls back to the default design's, an unknown field or a wrong value is a
 * problem (the design is then not used). `name` is the file's name.
 */
export function parseToolDesign(name: string, json: unknown): { design: ToolDesign } | { problem: string } {
  if (!TOOL_DESIGN_NAME.test(name)) return { problem: "design file names use letters, digits, dot, underscore and hyphen (max 40)" }
  if (!isRecord(json)) return { problem: "expected an object { label?, header?, rail?, diff?, output?, colors? }" }
  const problems: string[] = []
  for (const key of Object.keys(json)) if (!(SECTIONS as readonly string[]).includes(key)) problems.push(`unknown field ${key}`)
  for (const [section, fields] of Object.entries(FIELDS)) {
    const value = json[section]
    if (value === undefined) continue
    if (!isRecord(value)) problems.push(`${section}: expected an object`)
    else for (const key of Object.keys(value)) if (!fields.includes(key)) problems.push(`unknown field ${section}.${key}`)
  }
  if (problems.length) return { problem: problems.join("; ") }
  const base = DEFAULT_TOOL_DESIGN
  const part = (section: string): Record<string, unknown> => (isRecord(json[section]) ? json[section] : {})
  const oneOf = <T extends string>(where: string, value: unknown, allowed: readonly T[], fallback: T): T => {
    if (value === undefined) return fallback
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T
    problems.push(`${where}: expected ${allowed.join("|")}`)
    return fallback
  }
  const flag = (where: string, value: unknown, fallback: boolean) => {
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    problems.push(`${where}: expected true or false`)
    return fallback
  }
  const glyph = (where: string, value: unknown, fallback: DesignGlyph): DesignGlyph => {
    if (value === undefined) return fallback
    const pair = typeof value === "string" ? [value, value] : Array.isArray(value) && value.length === 2 ? value : undefined
    if (pair && pair.every((text) => typeof text === "string" && GLYPH.test(text) && textWidth(text) === 1)) return [pair[0] as string, pair[1] as string]
    problems.push(`${where}: expected a glyph or [glyph, ascii glyph], one cell each`)
    return fallback
  }
  const color = (where: string, value: unknown, fallback: ColorName | undefined): ColorName | undefined => {
    if (value === undefined) return fallback
    if (typeof value === "string" && isColorRole(value)) return value as ColorName
    problems.push(`${where}: expected a theme role (${COLOR_NAMES.slice(0, 15).join(", ")}, …)`)
    return fallback
  }
  const text = (where: string, value: unknown, fallback: string, max: number) => {
    if (value === undefined) return fallback
    if (typeof value === "string" && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)) return value.trim()
    problems.push(`${where}: expected text of at most ${max} characters`)
    return fallback
  }
  const header = part("header")
  const rail = part("rail")
  const diff = part("diff")
  const output = part("output")
  const colors = part("colors")
  const rows = output.rows === undefined ? base.output.rows : Number.isInteger(output.rows) && Number(output.rows) >= 0 && Number(output.rows) <= MAX_OUTPUT_ROWS ? Number(output.rows) : (problems.push(`output.rows: expected an integer 0..${MAX_OUTPUT_ROWS}`), base.output.rows)
  const shade = (key: keyof ToolDesign["colors"]) => color(`colors.${key}`, colors[key], base.colors[key])!
  const mark = color("colors.mark", colors.mark, undefined)
  const rule = color("colors.rule", colors.rule, undefined)
  const design: ToolDesign = {
    name,
    label: text("label", json.label, name, 40),
    description: text("description", json.description, "", 200),
    header: { mark: oneOf("header.mark", header.mark, ["kind", "bullet"], base.header.mark), bullet: glyph("header.bullet", header.bullet, base.header.bullet), call: oneOf("header.call", header.call, ["spaced", "parens"], base.header.call), label: flag("header.label", header.label, base.header.label) },
    rail: { kind: oneOf("rail.kind", rail.kind, ["line", "branch", "none"], base.rail.kind), glyph: glyph("rail.glyph", rail.glyph, base.rail.glyph) },
    diff: { tint: oneOf("diff.tint", diff.tint, ["row", "code", "none"], base.diff.tint), numbers: flag("diff.numbers", diff.numbers, base.diff.numbers), signs: flag("diff.signs", diff.signs, base.diff.signs) },
    output: { rows },
    colors: { ...(mark ? { mark } : {}), ...(rule ? { rule } : {}), label: shade("label"), target: shade("target"), number: shade("number"), added: shade("added"), removed: shade("removed"), addedBg: shade("addedBg"), removedBg: shade("removedBg"), output: shade("output") },
  }
  if (design.diff.tint === "none" && !design.diff.signs) problems.push("diff: with tint none the signs are what tells an added line from a removed one; keep signs true")
  return problems.length ? { problem: problems.join("; ") } : { design }
}

/** A design file as the daemon lists it (`tool-designs/<name>.json` in each layer): parsed, not yet checked. */
export type ToolDesignFile = { name: string; file: string; json?: unknown; problem?: string | undefined }
export type ToolDesignProblem = { name: string; file: string; message: string }

/** Files to designs; a bad file is a problem, never a throw. */
export function toolDesignsFromFiles(files: readonly ToolDesignFile[]): { designs: ToolDesign[]; problems: ToolDesignProblem[] } {
  const designs: ToolDesign[] = []
  const problems: ToolDesignProblem[] = []
  for (const file of files) {
    const parsed = file.problem ? { problem: file.problem } : parseToolDesign(file.name, file.json)
    if ("design" in parsed) designs.push(parsed.design)
    else problems.push({ name: file.name, file: file.file, message: parsed.problem })
  }
  return { designs, problems }
}

let builtIns: ToolDesign[] | undefined
/** Designs from files; a file wins over a built-in of the same name. */
let fileDesigns: ToolDesign[] = []

/**
 * The example designs, written exactly as a `tool-designs/<name>.json` file would be (copy one out as a starting point). They
 * live here rather than as JSON files beside this module so the terminal loads no extra module for them at start, and are only
 * built when a design is listed or chosen.
 */
const shipped = (): ReadonlyArray<{ name: string; json: unknown }> => [
  {
    name: "branch",
    json: {
      label: "Branch",
      description: "One bullet per call, the label holding its target, the body hanging from a branch, diffs tinted edge to edge",
      header: { mark: "bullet", bullet: ["●", "*"], call: "parens", label: true },
      rail: { kind: "branch", glyph: ["╰", "`"] },
      diff: { tint: "row", numbers: true, signs: true },
      output: { rows: 4 },
      colors: { mark: "success", label: "text", target: "text", number: "muted", added: "success", removed: "error", addedBg: "diffAddedBg", removedBg: "diffRemovedBg", output: "muted" },
    },
  },
  {
    name: "terse",
    json: {
      label: "Terse",
      description: "The kind's glyph and the target only, no rule, diffs as coloured signs without line numbers or tints",
      header: { mark: "kind", call: "spaced", label: false },
      rail: { kind: "none" },
      diff: { tint: "none", numbers: false, signs: true },
      output: { rows: 3 },
      colors: { label: "muted", target: "text", number: "muted", added: "success", removed: "error", addedBg: "diffAddedBg", removedBg: "diffRemovedBg", output: "muted" },
    },
  },
]

/** The built-in designs: the default, then the examples above, parsed the first time they are asked for. */
function builtInDesigns(): ToolDesign[] {
  if (builtIns) return builtIns
  const examples = toolDesignsFromFiles(shipped().map(({ name, json }) => ({ name, file: "built-in", json })))
  builtIns = [DEFAULT_TOOL_DESIGN, ...examples.designs]
  return builtIns
}

function allDesigns(): ToolDesign[] {
  const replaced = new Set(fileDesigns.map((design) => design.name))
  // The default stays the default: a file named `rail` cannot change what an unset setting draws.
  return [...builtInDesigns().filter((design) => design.name === DEFAULT_TOOL_DESIGN_NAME || !replaced.has(design.name)), ...fileDesigns.filter((design) => design.name !== DEFAULT_TOOL_DESIGN_NAME)]
}

/** Replaces the file designs (a profile turned on or off, a file written). */
export function registerToolDesigns(designs: readonly ToolDesign[]) {
  fileDesigns = [...designs]
}

/** The daemon's list of design files (`themes.list`'s `toolDesigns`) parsed and registered; returns the files that could not be used. */
export function registerToolDesignFiles(files: readonly ToolDesignFile[] | undefined): ToolDesignProblem[] {
  const { designs, problems } = toolDesignsFromFiles(files ?? [])
  registerToolDesigns(designs)
  return problems
}

export function toolDesignNames(): string[] {
  return allDesigns().map((design) => design.name)
}

export function toolDesignList(): readonly ToolDesign[] {
  return allDesigns()
}

/** The design called `name`, or the default when there is none of that name (a profile that brought it was turned off). */
export function toolDesignOf(name: string | undefined): ToolDesign {
  if (!name || name === DEFAULT_TOOL_DESIGN_NAME) return DEFAULT_TOOL_DESIGN
  return allDesigns().find((design) => design.name === name) ?? DEFAULT_TOOL_DESIGN
}

/** The glyph a design draws in this glyph mode. */
export const glyphText = (glyph: DesignGlyph, ascii: boolean) => glyph[ascii ? 1 : 0]

import { readFileSync } from "node:fs"
import type { PromptFamily, PromptFocus } from "@mendcode/protocol/wire"
import basicsFile from "../prompts/focus/basics.prompt.md" with { type: "file" }
import codexFile from "../prompts/focus/codex.prompt.md" with { type: "file" }
import claudeFile from "../prompts/focus/claude.prompt.md" with { type: "file" }
import geminiFile from "../prompts/focus/gemini.prompt.md" with { type: "file" }
import kimiFile from "../prompts/focus/kimi.prompt.md" with { type: "file" }
import deepseekFile from "../prompts/focus/deepseek.prompt.md" with { type: "file" }
import mistralFile from "../prompts/focus/mistral.prompt.md" with { type: "file" }
import glmFile from "../prompts/focus/glm.prompt.md" with { type: "file" }
import minimaxFile from "../prompts/focus/minimax.prompt.md" with { type: "file" }
import grokFile from "../prompts/focus/grok.prompt.md" with { type: "file" }
import localFile from "../prompts/focus/local.prompt.md" with { type: "file" }
import operatorGuideFile from "../prompts/operator-guide.md" with { type: "file" }
import selfKnowledgeFile from "../prompts/self-knowledge.md" with { type: "file" }
import visiblePlanFile from "../prompts/visible-plan.md" with { type: "file" }
import graphAutopilotFile from "../prompts/graph-autopilot.md" with { type: "file" }
import { PROGRAM_NAME } from "@mendcode/program"

/**
 * Characters of static guidance each mode may add, and the ceilings of the composed prompt (measured with the packaged base prompt and
 * no project instructions, skills or memory). Every mode but `custom` carries the one-line pointer to `mendcode docs` (`selfKnowledge`);
 * beyond it `minimal` adds none and `focus` the short core of the basics and at most one model note; the long guidance is the opt-in
 * `guide` mode. `guide` adds the working basics, one family body and at most one model note; `full` adds the generated operator guide on
 * top of that. Tests hold every file to these.
 */
export const PROMPT_BUDGETS = {
  // Measured with gpt-6-luna on "make my footer like my other tool's" in a project that is not MendCode: "For any MendCode feature or
  // setting, first run docs ..." was followed 1 of 3 (the model looked for a footer in the project); naming the terminal's own parts as
  // MendCode's, not the project's, was followed 13 of 14 (185 bytes). That line ended in an unscoped "first run docs --search", and the
  // model opened plain coding tasks with a docs search in 5 of 10 runs (one wasted model call each); "for those only" made it 0 of 6 and
  // the footer request was still followed 3 of 3 (188 bytes). Later a user asked for widgets in "my Galaxy panel" from their home folder and
  // gpt-6.1-sol asked which app that was: the line now names the Galaxy panel, widgets and the pet too (not measured again; 208 bytes keep minimal under 700).
  // Requests to change the screen ("hide the footer", "move the sidebar right") went to the project in 18 of 20 gpt-6-luna runs. Naming the
  // screen and its parts (start screen, logo, sidebars, bars, prompt, footer, labels) instead of "a terminal app" and "widgets": on the eight
  // requests that still went to the project, 4 of 24 runs did with the shorter line, 1 of 24 with this one (scripts/eval-customize.ts, with
  // customize_ui listed). 237 characters; minimal is 728.
  // gpt-6.1-sol asked which app that was: the line now names the Galaxy panel, widgets and the pet too (208 bytes). On 15 requests to change
  // MendCode's behavior (scripts/eval-extend.ts) gpt-6-luna built 3 with that line: it put /hola, a system prompt line or a tool log into the
  // project, and answered "block rm -rf" or "never read private/" with a promise. Naming slash commands, models and its own tools, hooks
  // and system prompt as MendCode's, plus "a rule for later is an extension, not a promise" (365 bytes, with the mendcode_extend tool) made it 13 of 15
  // twice; the misses moved around. "before or when X do Y" and "not ... a one-time check" (it had checked git status once for "before any
  // write, refuse on a dirty tree"), with the tool's check action and the cards, made it 14 and 15 of 15 (395 bytes).
  // Both lines merged (screen parts, then behavior): 428 bytes, measured again with both evals.
  // 430 -> 470: "(never read its binary or source)": a model asked to change the context window ran strings and python over the binary for a minute.
  // 470 -> 630: the one-line language rule (reply in the user's latest message language, never switch on its own) rides on this line in every mode but custom.
  selfKnowledge: 630,
  // `focus` (the default) had only a one-sentence family note: the core gives it the guide's every-call habits (preambles, `todo`,
  // `path:line`, result first) and the model note joins it; together they stay under 1,200 characters over that focus (not measured with an eval).
  focus: { core: 600 },
  guide: { basics: 1_100, family: 3_000, modelNote: 600 },
  // 1,500: the guide names every card topic (45 of them now, 22 before) so the model picks one without a call; the prose was trimmed first.
  // 1,500 -> 1,750: the `change` map card name and the rule not to read the binary or source to change MendCode.
  full: { operatorGuide: 1_750 },
  // full 7,400 -> 7,800: the base prompt's terminal rendering block (+389 characters, sent to every engine) put codex full at 7,619.
  // full 8,050 -> 8,100: the language rule on the docs pointer (+161 characters) put codex full at 8,081.
  composed: { guide: 6_500, full: 8_100 },
} as const

export type ModelNote = { label: string; match: RegExp; text: string }
export type FamilyGuidance = { family: PromptFamily; provenance: string; body: string; notes: ModelNote[] }

/** One file per family. The files are embedded in the binary; their text is read on first use and kept. */
const FAMILY_FILES: Record<PromptFamily, string> = {
  codex: codexFile, claude: claudeFile, gemini: geminiFile, kimi: kimiFile, deepseek: deepseekFile, mistral: mistralFile,
  glm: glmFile, minimax: minimaxFile, grok: grokFile, local: localFile,
}

const NOTE_MARKER = /^<!-- model "([^"]+)" \/(.+)\/([a-z]*) -->$/

function frontmatter(source: string): { fields: Record<string, string>; body: string } {
  const text = source.replace(/\r\n?/g, "\n")
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!head) throw new TypeError("[GUIDANCE]: a prompt file starts with a --- header")
  const fields: Record<string, string> = {}
  for (const line of head[1]!.split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { fields, body: text.slice(head[0].length).trim() }
}

/** A family file is a header (`family`, `provenance`), a body for every model of the family, then model notes, each opened by `<!-- model "Label" /regex/flags -->`. */
export function parseFamilyGuidance(source: string): FamilyGuidance {
  const { fields, body } = frontmatter(source)
  for (const key of ["family", "provenance"]) if (!fields[key]) throw new TypeError(`[GUIDANCE]: header field ${key} is required`)
  const base: string[] = []
  const notes: ModelNote[] = []
  let open: { label: string; match: RegExp; lines: string[] } | undefined
  for (const line of body.split("\n")) {
    const marker = NOTE_MARKER.exec(line)
    if (marker) {
      if (open) notes.push({ label: open.label, match: open.match, text: open.lines.join("\n").trim() })
      open = { label: marker[1]!, match: new RegExp(marker[2]!, marker[3]!), lines: [] }
    } else (open ? open.lines : base).push(line)
  }
  if (open) notes.push({ label: open.label, match: open.match, text: open.lines.join("\n").trim() })
  return { family: fields.family as PromptFamily, provenance: fields.provenance!, body: base.join("\n").trim(), notes }
}

const cache = new Map<string, unknown>()
const once = <T>(key: string, load: () => T): T => {
  if (!cache.has(key)) cache.set(key, load())
  return cache.get(key) as T
}

/** The family's guidance file; `neutral` (no family claims the model) has none and gets the working basics alone. */
export function familyGuidance(family: PromptFocus): FamilyGuidance | undefined {
  return family === "neutral" ? undefined : once(`family:${family}`, () => parseFamilyGuidance(readFileSync(FAMILY_FILES[family], "utf8")))
}

/** The basics file holds two blocks: the working basics `guide` sends, then, after a `<!-- focus -->` line, the short core `focus` sends instead. */
const FOCUS_MARKER = /^<!-- focus -->$/m
function basicsBlocks(): { guide: string; focus: string } {
  return once("basics", () => {
    const body = frontmatter(readFileSync(basicsFile, "utf8")).body
    const marker = FOCUS_MARKER.exec(body)
    if (!marker) throw new TypeError("[GUIDANCE]: basics.prompt.md needs a <!-- focus --> block")
    return { guide: body.slice(0, marker.index).trim(), focus: body.slice(marker.index + marker[0].length).trim() }
  })
}

/** The block every family shares in `guide`: how this harness's tools behave. */
export function focusBasics(): string {
  return basicsBlocks().guide
}

/** What `focus` carries of the basics: preambles, `todo`, `path:line`, result-first answers. `guide` sends the full basics and not this. */
export function focusCore(): string {
  return basicsBlocks().focus
}

/** What `guide` adds for a family: the working basics, then the family body when the family has one. */
export function guideText(family: PromptFocus): string {
  return [focusBasics(), familyGuidance(family)?.body].filter(Boolean).join("\n\n")
}

/** The first model note of the family whose pattern matches the model id (the more specific notes are written first). */
export function modelNote(family: PromptFocus, modelID: string | undefined): ModelNote | undefined {
  const id = (modelID ?? "").trim()
  return id ? familyGuidance(family)?.notes.find((note) => note.match.test(id)) : undefined
}

/**
 * The graph autopilot's two lines (feature `graph_autopilot`): `native`, one line in the system prompt while `graph_find` is listed;
 * `harness`, appended to what MendCode tells Claude Code, Codex and ACP agents about its graph tools. Static text, so a turn's prompt never changes.
 */
export function graphAutopilotText(): { native: string; harness: string } {
  return once("graph-autopilot", () => {
    const [native = "", harness = ""] = readFileSync(graphAutopilotFile, "utf8").split(/^<!-- harness -->$/m).map((block) => block.trim())
    if (!native || !harness) throw new TypeError("[GUIDANCE]: graph-autopilot.md needs a native line, a <!-- harness --> line and a harness line")
    return { native, harness }
  })
}

/** The generated texts name the program as `{{program}}`: the name the user typed (`mendcode`, or a developer's wrapper) is only known at run time. */
const withProgram = (text: string) => text.replaceAll("{{program}}", PROGRAM_NAME)

/** The operator guide generated from docs/ and the card topics (`bun scripts/self-knowledge.ts`), sent in `full` mode. */
export function operatorGuideText(): string {
  return once("guide", () => withProgram(readFileSync(operatorGuideFile, "utf8").trim()))
}

/** The one line every mode but `custom` carries: the model runs inside MendCode and reads its own reference cards with a command, not the web. */
export function selfKnowledgeText(): string {
  return once("self-knowledge", () => withProgram(readFileSync(selfKnowledgeFile, "utf8").trim()))
}

/**
 * The visible plan's two lines (feature `visible_plan`): `native`, sent by focus, guide and full while `todo` is listed; `harness`,
 * appended for an engine with its own todo or plan tool (Claude Code, Codex, ACP agents), whose list the terminal pins as well.
 */
export function visiblePlanText(): { native: string; harness: string } {
  return once("visible-plan", () => {
    const [native = "", harness = ""] = readFileSync(visiblePlanFile, "utf8").split(/^<!-- harness -->$/m).map((block) => block.trim())
    if (!native || !harness) throw new TypeError("[GUIDANCE]: visible-plan.md needs a native line, a <!-- harness --> line and a harness line")
    return { native, harness }
  })
}

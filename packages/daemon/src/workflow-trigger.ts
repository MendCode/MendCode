import { DEFAULT_WORKFLOW_SIZE, WORKFLOW_SIZE_GUIDE, type WorkflowSize } from "@mendcode/protocol"
import { isMachineNotice } from "./reply-language"

/**
 * Ask for a workflow (docs/workflows.md, "Ask for a workflow"). A prompt with the word `fanout` (or `ultracode`) lets the model write
 * and run a workflow script for that request; the `workflows.auto` setting does the same for every prompt. The words are the user's
 * consent: the script starts without a prompt (deny rules and plan mode still apply) and shows its estimate instead. A word inside
 * backticks or after a backslash is only a mention, and `--no-fanout` skips the trigger for one prompt.
 *
 * Pure text and settings, no I/O: the daemon loads this module with the first prompt that has the word or a session with auto on.
 */
const WORD = /(?<![\w\\-])(?:fanout|ultracode)(?![\w-])/i
const SKIP = /(?<![\w-])--no-fanout(?![\w-])/i
/** A code span opens with a run of backticks and ends with a run of the same length: three or more may span lines (a fence), one or two stay on a line. */
const MENTION = /(?<!`)(`{3,})(?!`)[\s\S]*?(?<!`)\1(?!`)|(?<!`)(`{1,2})(?!`)[^\n]*?(?<!`)\2(?!`)/g

export type FanoutTrigger = "keyword" | "auto"

/** Why this prompt asks for orchestration, or undefined when it does not. Notices an engine sends in the user's place never do. */
export function fanoutTrigger(text: string, setting: { auto?: boolean | undefined } | undefined): FanoutTrigger | undefined {
  if (!text.trim() || isMachineNotice(text) || SKIP.test(text)) return undefined
  if (WORD.test(text.replace(MENTION, " "))) return "keyword"
  return setting?.auto === true ? "auto" : undefined
}

/** The one line (paragraph) added to the user's message for a triggered prompt. */
export function fanoutNote(input: { trigger: FanoutTrigger; size: WorkflowSize | undefined }): string {
  const size = WORKFLOW_SIZE_GUIDE[input.size ?? DEFAULT_WORKFLOW_SIZE]
  const why = input.trigger === "keyword" ? "the user's message has the word fanout" : "the user turned on automatic workflows"
  return `Workflows are on for this message (${why}). When the work splits into independent pieces or its next step depends on earlier results, write a workflow script and start it with the workflow_script tool (find it with tool_search; call it once with help true for the API). It starts at once and the user follows it in /workflows. Size guideline, ${size.text}; declare meta.budget with the caps you plan. When the work is small or strictly serial, do it yourself.`
}

import type { OutputStyle } from "@mendcode/protocol/wire"

/** Tone presets for the native system prompt (`/output-style`). They shape how answers read, never what tools may do. */
const STYLE_TEXT: Readonly<Record<Exclude<OutputStyle, "default">, string>> = {
  caveman: "Output style: caveman. Use short, plain fragments. Drop filler and repetition. Preserve exact paths, commands, numbers, caveats and uncertainty. Only prose is compressed: code, tool use and verification remain thorough. Never claim measured token savings.",
  explanatory: [
    "Output style: explanatory.",
    "While you work, add a short \"Insight\" note after a meaningful step that explains why the code or approach is what it is: the trade-off, the codebase convention it follows or the pitfall it avoids.",
    "Keep notes to one or two sentences, specific to this codebase, and never replace the work or the final summary with them.",
  ].join("\n"),
  learning: [
    "Output style: learning.",
    "Work with the user, not only for them. Explain the reasoning behind each step in plain words, and name the concept when one is new.",
    "When a small, self-contained piece of logic would teach the most (a few lines, a decision, a test case), leave it as a clearly marked `TODO(you)` with the context needed and ask the user to write it; do the rest yourself and wait for their answer before moving on.",
    "Do not leave a TODO in code the user did not agree to write, and never in a change that must ship unattended.",
  ].join("\n"),
  terse: [
    "Output style: terse.",
    "Answer in as few words as the user can act on. No preamble, no restating the request, no closing recap beyond what changed and what to check.",
    "Prefer a command, a path or a one-line verdict over a paragraph. Keep code, tool use and verification as thorough as always; only the prose is short.",
  ].join("\n"),
}

/** The instruction block for a style, or an empty string for `default` and unknown values (the part is then dropped). */
export function outputStyleText(style: OutputStyle | undefined): string {
  return style && style !== "default" ? STYLE_TEXT[style] ?? "" : ""
}

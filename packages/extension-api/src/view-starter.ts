import { HOST_OPTIONS_ROW, VIEW_SLOTS, VIEW_BUDGET_MS, type ViewSlot } from "./views"

/** The fields a view of the slot reads first. The full models are in docs/views.md. */
const FIELDS: Record<ViewSlot, string> = {
  "message.user": "text, time, variant (message | shell | notice), style, attachments, expanded",
  "message.assistant": "text, time, style, renderer, details, body (the built-in's Markdown rows, to restyle)",
  "message.reasoning": "text, running, ms, rows, oneLine, hidden",
  "tool.card": "kind, detail, status, level, expanded, page, text, output (lines), summary, counts, elapsedMs, exitCode",
  "tool.row": "variant (minimal | memory | plan | images), title, status, text, run, folded, reason, images, where",
  "compaction.card": "state, reason, summary, followUp, method, tailTurns, tailTokens, style, expanded, summaryRows",
  "turn.status": "variant (end | goal | limit | note | undone | checkpoint), end { outcome, input, output, ms, error }, goal, limit, note, undone, meta, mode",
  page: "page, title, hints, selected, scroll, body (the built-in rows), status",
  overlay: "variant (palette | picker | card), title, query, selected, matches, rows (the built-in card)",
  bar: "variant (working | find | search | attachments | ide | voice | vim | daemon | shortcuts | mention | agents), rows (the built-in rows)",
  approval: "title, tool, permission, subject (the text being approved), detail (rows), options [{ label, key, choice }], choice, hint",
  question: "title, detail, options [{ label, description }], choice, picked, multiple, typing; a batch adds questions and draft",
  "prompt.frame": "preset, border, lead, borders (return { top, bottom, left?, right? })",
  topbar: "path, branch, title, diff, context { tokens, limit }, files, navigation",
  "sessions.sidebar": "sessions [{ sessionId, title, state, queued, updatedAt }], current, selected, focused",
  notice: "kind: toast { variant, title, message } | limit { view, chips } | queue { previews, delivery, held, paused }",
  footer: "agent, model, effort, provider, permissionLabel, counters, goal, notice, connection, extraRows",
  home: "root, sessions, look, tip, footer, spinner, bare",
  "panel.widget": "widget (the widget id), options, body (the built-in rows)",
  "file.viewer": "variant (slot | page), path, name, language, kind, lines, top, rows [{ line, text, spans, mark, selected, hit }], selection, search, focused, panel (actions: close | switch | open | ask | copy | line)",
  "slash.menu": "items, selection, query, group, groups, layout, catalog",
  "page.status": "connected, session, info, models, mcps, extensions, storage, scroll",
}

/** Slots whose starter draws something real: a one-line change that shows the view works. */
const BODIES: Partial<Record<ViewSlot, string>> = {
  "message.assistant": `    // Prefix every assistant message and keep the built-in Markdown below it.
    return [[{ text: "assistant", fg: "primary", bold: true }], ...input.body]`,
  "tool.card": `    // Draw \`read\` calls as one muted line; every other tool keeps the built-in card.
    if (input.kind !== "read") return undefined
    return [[{ text: "read " + input.detail, fg: "muted" }, { text: " " + input.status, fg: input.status === "ok" ? "success" : "error" }]]`,
  footer: `    // One compact line: agent, model and the connection.
    return [[{ text: " " + (input.agent ?? "") + " " + (input.model ?? ""), fg: "muted" }]]`,
  topbar: `    return [[{ text: " " + input.path + (input.branch ? "  " + input.branch : ""), fg: "muted" }]]`,
  approval: `    // Your title and the text being approved, then the terminal's own option rows where the ${HOST_OPTIONS_ROW} row is.
    return [[{ text: " " + input.title + ": ", fg: "warning", bold: true }, { text: input.subject }], [{ text: ${JSON.stringify(HOST_OPTIONS_ROW)} }], [{ text: " " + input.hint, fg: "muted", dim: true }]]`,
  question: `    // Your question text, then the terminal's own answer rows where the ${HOST_OPTIONS_ROW} row is.
    return [[{ text: " " + input.title, fg: "text", bold: true }], [{ text: ${JSON.stringify(HOST_OPTIONS_ROW)} }]]`,
}

export const viewFileName = (slot: ViewSlot) => `view-${slot.replace(/\./g, "-")}.ts`

/** The starter module of one view slot; `name` is the extension name (the default is unique per slot; a package gives its own so two packages never clash). */
export function viewStarter(slot: ViewSlot, name = `view-${slot.replace(/\./g, "-")}`): string {
  const info = VIEW_SLOTS[slot]
  const frame = slot === "prompt.frame"
  const body = BODIES[slot] ?? (frame
    ? `    // Rows above and below the input, and the cells around each input row.
    // return { top: [[{ text: "-".repeat(input.width) }]], bottom: [], left: [{ text: "| " }] }
    return undefined`
    : `    // Return lines (arrays of spans) to draw this part yourself, or undefined to keep the built-in.
    // return [[{ text: "hello", fg: "primary" }]]
    return undefined`)
  return `// ${slot}: ${info.label}
//
// A view is a pure, synchronous function of its input. Return lines (arrays of spans) or undefined to use the built-in.
// It runs inside the terminal with your user's privileges: keep it fast (${VIEW_BUDGET_MS} ms per call). A view that throws, is slow or returns
// invalid output three times is turned off and the built-in draws again (see /customize > Views).
//
// Input: ${FIELDS[slot]}
//        and always width, height, theme { name, colors }, ascii (plain glyphs wanted) and now (ms).
// Span:  { text, fg?, bg?, bold?, dim?, italic?, underline? }  fg and bg are theme roles (primary, muted, success, error...) or "#rrggbb".
// Click: ${info.hostOptions ? `the terminal draws the real options (and owns their clicks and keys) itself. Put a row holding only ${HOST_OPTIONS_ROW} where they go (otherwise they follow your rows); input.optionRows is their height. A span with an action is invalid here.` : info.actions.length ? `add action${info.arg ? ` and arg (${info.arg})` : ""} to a span; actions: ${info.actions.join(", ")}.` : "this slot cannot be clicked."}
// Docs:  docs/views.md lists every slot's full input and the rules.
export default {
  name: ${JSON.stringify(name)},
  tui(api) {
    api.view(${JSON.stringify(slot)}, (input) => {
${body.split("\n").map((line) => `  ${line}`).join("\n")}
    })
  },
}
`
}

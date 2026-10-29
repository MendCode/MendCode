// A terminal extension that works with comments on an answer (docs/editor.md, "Extending").
// Copy it to `<data dir>/extensions/comment-hunk.ts`, or `<project>/.mendcode/extensions/`.
//
//   /hunk src/app.ts the null check is missing   adds a comment on that file's diff hunk
//   Enter                                        sends it with whatever else is pending; the message ends with a line naming the count
// Types only (erased when loaded): a copy of this file outside the repository keeps working, and loses only the checking.
import type { TuiActions, TuiExtensionAPI } from "../../packages/extension-api/src/index"

export default {
  name: "comment-hunk",
  tui(api: TuiExtensionAPI) {
    api.command("hunk", "Comment on a file's diff hunk", (args: string, actions: TuiActions) => {
      const [file, ...words] = args.trim().split(/\s+/)
      if (!file || words.length === 0) return actions.toast("usage: /hunk <file> <comment>", "warning")
      const added = actions.comments.add({ quote: `diff of ${file}`, text: words.join(" ") })
      actions.toast(added ? `comment on ${file} added (${actions.comments.list().length} pending)` : "comments are off, or the most is reached", added ? "success" : "warning")
    })

    // Runs just before a message with comments is sent: return the text to send instead, or nothing to keep it.
    api.comments.beforeSend((message, { comments }) => `${message}\n\nReviewed ${comments.length} ${comments.length === 1 ? "passage" : "passages"}.`)
  },
}

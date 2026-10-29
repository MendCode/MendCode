---
summary: comment on passages of an answer and send them as one message
docs: editor
aliases: comment, annotate, reply-mode, feedback, margin-notes
---
For: "I want to comment on one paragraph", "answer option 2 and 3 differently", "give feedback on part of your answer".

The user's flow (no model tool starts it): select a passage with the mouse (copy-on-select) and press ctrl+g (works in every terminal; alt+q and ctrl+x w do the same) or click the pill on the prompt's top rule; Enter stores the comment as a chip above the prompt and a mark in the margin; up to nine; Enter on the prompt sends the chips and the typed text as one message, and with an empty prompt only the comments. alt+l lists them (e edits, d deletes). With nothing selected, ctrl+g walks the newest answer unit by unit (reply mode: j k move, c comments, d writes a decision for all numbered options at once like "1: yes, 2: no", esc leaves). ctrl+c with an empty prompt keeps the comments as a draft.

Commands and settings: /comments lists them; /comments reply, clear, on, off, auto; settings open the rows in /customize, group Comments. Profile keys: [[setting:comments]] auto|on|off, [[setting:commentKey]] comment|quote (quote makes alt+q quote the selection into the prompt; ctrl+g always comments), [[setting:commentHint]], [[setting:commentHintSeconds]] (1 to 60), [[setting:commentChips]], [[setting:commentMax]] (1 to 9), [[setting:commentMarks]], [[setting:commentTemplate]] (needs {comments}) and [[setting:commentEntry]] (needs {quote} and {text}) reshape the message the model receives. Rebind with keybindings.json: selection.comment, comment.list, comment.reply, comment.clear, selection.quote ({{program}} docs keys).

What the model receives: one user message that lists each quoted passage with the user's comment on it. Answer every comment; if a quote is not in your answer, say so.

Not possible: commenting on tool cards, images or diagrams; comments under the passage (the terminal shows a chip row and a margin number); more than nine at once; a comment tool for the model. Comments on a code diff are the Changes page: {{program}} docs git.

Extensions can add comments and reshape the message before it is sent (actions.comments, api.comments.beforeSend; {{program}} docs extensions).

Check: the chip row above the prompt shows the count; if you cannot see the screen, say the result was not verified.

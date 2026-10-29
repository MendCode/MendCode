---
summary: how the chat is drawn: tool output, density, markdown, reasoning, scroll
docs: customize, profile-keys, layout, accessibility, return
aliases: tool-output, chat, conversation, rendering, markdown, scrollbar, timestamps, thinking, density-tools, messages
---
For: "show the full tool output", "fewer tool cards", "hide / show the thinking", "tables look wrong", "timestamps", "scrollbar", "where did the answer go after sending".

Each is a profile key: apply with customize_ui {"action":"settings","values":{"toolOutput":"expanded"}} (in minimalist find the tool with tool_search; it validates and applies live to every terminal), or the user's /customize group Session chrome. Keys and allowed values: {{program}} control-plane tui schema. Look and colours: {{program}} docs customize.
  Tool cards: [[setting:toolOutput]] auto|collapsed|expanded (what a finished card shows; ctrl+o opens one by hand and wins); [[setting:toolDensity]] calm (default, one row per finished call) | standard | dense (full view only); [[setting:codeMapCard]] auto|open|folded.
  Reasoning: [[setting:reasoning]] auto|hidden|collapsed|expanded, or the user's /thinking toggle.
  The whole view: [[setting:view]] minimal|balanced|full (/view; a tier sets it once).
  Presentation: [[setting:presentation]] auto|raw|minimal|mendcode|balanced|full (/presentation, /view; /raw gives plain copy-friendly output); [[setting:messageRenderer]] plain|markdown|full (/message-rendering); [[setting:messageLayout]] quiet|classic; [[setting:messageMeta]] off|compact|full; [[setting:timestamps]]; [[setting:username]].
  Markdown group: [[setting:tableStyle]], [[setting:headingStyle]], [[setting:markdownCopyHints]], [[setting:markdownRtl]], [[setting:markdownColors]] (JSON such as {"mdHeading1":"#ff8800"}).
  Scrolling: [[setting:submitScroll]] bottom|clear (/submit-scroll); [[setting:scrollbar]] auto|always|off with [[setting:scrollbarGlyphs]]; [[setting:jumpHint]] right|center|left|off for the jump-to-latest pill (/jump); [[setting:stickyPrompt]] pins the latest prompt.
  Activity row (the working status): [[setting:activityPlacement]] transcript|above|inside|off (/activity), [[setting:activityParts]], [[setting:showElapsed]], [[setting:showTokens]], [[setting:doneSymbol]].
The single toggles exist as commands: /timestamps /thinking /scrollbar /username /sticky-prompt /terminal-title /tips; the user types them. /find searches the transcript; /messages picks a message to copy, revert or fork.

/customize groups: Session chrome and Markdown are this card; Prompt & footer and Status segments (prompt box, status line, footer): {{program}} docs footer. /prompt-chrome and /jump-to-latest open one row each. Turn-end signals: [[setting:turnBell]], [[setting:turnNotify]], [[setting:notifyWhen]], [[setting:autoRecap]], [[setting:idleReturn]] (Terminal group; {{program}} docs customize).
Tell the user what changed. The balanced and minimal views ignore toolDensity; the minimal view keeps the code map as one row.

Check: the customize_ui result lists errors (a bad value changes nothing). You cannot see the screen: say the look was not verified visually.

Not a profile key: colors of the theme ({{program}} docs theme), the footer ({{program}} docs footer), the right panel ({{program}} docs layout).

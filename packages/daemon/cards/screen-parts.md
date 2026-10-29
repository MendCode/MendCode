---
summary: every part of the screen and the profile key that changes it
docs: profile-keys, customize, layout
aliases: parts, chrome, topbar, top-bar, header, placeholder, labels, hide
---
Every part of the user's screen is a profile key. Change it yourself, now: customize_ui {"action":"settings","values":{"showTopbar":false}} applies live to every terminal (never send the user to /customize instead). Unsure of a name: customize_ui {"action":"keys","query":"<words for the part>"} returns the keys with their values. Not in your tool list: tool_search finds customize_ui.

A session, top to bottom:
  top bar (project, title, context): showTopbar false removes the row; its parts showProject, showSessionTitle, contextBar off, showDiffLines, showDiffFiles, topbarStats
  your last message pinned while scrolled up: stickyPrompt
  messages: timestamps; your label: username + showUsername; the answer's label: assistantName; userLead (›), assistantLead (•), userIcon, assistantIcon, userTint, messageLayout quiet|classic, messageMeta
  thinking blocks: reasoning hidden|collapsed|expanded; tool cards: toolOutput, toolDensity; answers: messageRenderer, tableStyle, headingStyle
  scrollbar: scrollbar auto|always|off; jump-to-latest pill: jumpHint off|right|center|left, jumpText
  activity line while a turn runs: activityPlacement transcript|above|inside|off, showActivity, showElapsed, showTokens, showInterruptHint, activityParts
  running sub-agents and commands over the prompt: showTasks
  prompt box: promptChrome box|top-bottom|minimal|ascii-box, promptBorder single|rounded|double|ascii, promptLead (the ❭ symbol), promptGlyphs, promptStatus border
  empty prompt's example text: showPlaceholder, placeholderText
  footer under the prompt: showStatus false removes it; its parts showModel, showProvider, showAgent, showPermission, showEffort; rows and icons: footerRows ({{program}} docs footer)
Home (start) screen: homeHeader (its first row), logoKind wordmark|mascot|both|custom|none, logoText, productName, tagline, homePanel (the session list under the logo), homeRightPanel, homeLayout centered|split, homeTips, homeFooter
Left session list: sidebar auto|always|hidden, sidebarSide left|right, sidebarHeader (its title row)
Right panel (/panel): panelHeader (its first row), sidebarWidth, its cards sidebarWidgets ({{program}} docs layout)
The whole screen: density compact|comfortable|spacious, theme ({{program}} docs theme), pet, terminalTitle, titleTemplate; notices: usageNotices, cacheNotices, confirmNotices
A part drawn in a way no key offers: a view or an extension ({{program}} docs extensions).

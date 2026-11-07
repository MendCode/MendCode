/**
 * The rows of the /customize page as plain data: their sections and their names on screen. Kept apart from the page so other pages
 * (/profiles names what a profile overrides with these labels) read them without loading the page itself.
 */

/**
 * The sections of the /customize page, what most people change first and the technical ones last (the docs coverage map names every
 * title). Each section's parts are its subheadings; a part without a title sits right under the section's name.
 */
export const GROUPS = [
  { title: "Look", parts: [
    { title: "", rows: ["theme", "glyphs", "sessionAccent", "diffView", "toolDesign"] },
    { title: "Markdown", rows: ["tableStyle", "headingStyle", "markdownCopyHints", "markdownRtl", "markdownColors"] },
  ] },
  { title: "Home", parts: [
    { title: "Logo", rows: ["logoKind", "logoText", "customAscii", "logoFont", "productName", "tagline", "homeMascot", "mascotMotion", "mascotSize"] },
    { title: "Layout", rows: ["homeLayout", "homeInput", "homePanel", "homeRightPanel", "density", "homeHeader", "homeTips", "homeFooter", "showPlaceholder", "placeholderText"] },
  ] },
  { title: "Prompt & footer", parts: [
    { title: "Prompt", rows: ["promptChrome", "promptBorder", "promptGlyphs", "promptLead", "promptStatus", "attachmentChips"] },
    { title: "Footer", rows: ["showStatus", "footerPack", "footerPreset", "footerRows", "footerText", "footerIcons", "statusSeparator", "showAgent", "showModel", "showProvider", "showEffort", "showPermission", "showCommandHint", "showAgentHint", "footerToday"] },
    { title: "Segments", rows: ["statusLeft", "statusRight", "statusColors"] },
    { title: "Quota", rows: ["footerQuota", "quotaView", "quotaColor", "quotaRefresh"] },
  ] },
  { title: "Chat", parts: [
    { title: "Messages", rows: ["presentation", "messageRenderer", "messageLayout", "userIcon", "userLabel", "userLead", "userTint", "showUsername", "username", "assistantIcon", "assistantLabel", "assistantName", "assistantLead", "messageMeta", "timestamps", "replyLanguage"] },
    { title: "Tools", rows: ["reasoning", "toolLayout", "toolOutput", "toolDensity", "codeMapCard", "transcriptImages"] },
    { title: "Scrolling", rows: ["submitScroll", "scrollbar", "scrollbarGlyphs", "jumpHint", "jumpText", "stickyPrompt"] },
  ] },
  { title: "Activity", parts: [
    { title: "Status", rows: ["activityPlacement", "showActivity", "activityParts", "showElapsed", "showTokens", "showInterruptHint", "showStalled", "showActivityModel", "doneSymbol"] },
    { title: "Notices", rows: ["usageNotices", "cacheNotices", "confirmNotices"] },
    { title: "Mascot", rows: ["activityMascot", "activityStates", "activityMessages", "pet", "petSize"] },
    { title: "Image wait", rows: ["imageWait", "imageWaitPreset", "imageWaitSpeed", "imageWaitColor", "imageWaitMeta"] },
    { title: "Compaction", rows: ["limitCheckpoint", "compactionPanel", "compactionStyle", "compactionProgress", "compactionScratchpad"] },
  ] },
  { title: "Top & side", parts: [
    { title: "Top bar", rows: ["showTopbar", "topbarStats", "showSessionTitle", "showProject", "contextBar", "contextStyle", "showDiffLines", "showDiffFiles"] },
    { title: "Sidebar & panel", rows: ["sidebar", "sidebarSide", "sidebarHeader", "sidebarWidth", "panelNarrow", "panelHeader", "showTasks", "dockJobs"] },
    { title: "Window title", rows: ["terminalTitle", "titleTemplate", "titleActivity"] },
  ] },
  { title: "Input & keys", parts: [
    { title: "Typing", rows: ["vimMode", "multiline", "shortcutOverlay", "pasteSummary", "pasteSummaryMinChars", "pasteBurst", "draftRetentionDays"] },
    { title: "Esc", rows: ["escBacktrack", "escRetract", "queueRestore"] },
    { title: "Mouse & keys", rows: ["copyOnSelect", "rightClickPaste", "wheelLines", "altLabel", "keyProtocol", "optionKeys"] },
    { title: "Files & links", rows: ["hyperlinks", "fileOpener", "pathClick", "viewerNumbers", "viewerWrap", "viewerFocus"] },
  ] },
  { title: "Comments", parts: [
    { title: "", rows: ["comments", "commentKey", "commentHint", "commentHintSeconds", "commentChips", "commentChipStyle", "commentCollapse", "commentMax", "commentMarks", "commentMarkGlyph", "commentReplyKeys", "commentFolded", "commentSentLayout", "commentTemplate", "commentEntry"] },
  ] },
  { title: "Notifications", parts: [
    { title: "", rows: ["turnBell", "turnNotify", "notifyWhen", "activitySound", "autoRecap", "idleReturn", "resumePrompts"] },
  ] },
  { title: "Advanced", parts: [
    { title: "Extensions", rows: ["extensions", "exportLook"] },
    { title: "Views", rows: ["views", "viewScaffold"] },
    { title: "Slash menu", rows: ["slashMenu", "slashCommands"] },
    { title: "Capabilities", rows: ["promptContext", "capabilityCatalogue", "graphIndex"] },
    { title: "Terminal", rows: ["images", "altScreen", "accessible", "processMode", "usageClock", "reset"] },
  ] },
] as const
export const CUSTOMIZE_ROWS = GROUPS.flatMap((group) => group.parts.flatMap((part) => [...part.rows]))
export type CustomizeRow = (typeof CUSTOMIZE_ROWS)[number]

/** Each row's name on the page (docs/customize-keys.md lists them by section). */
export const LABELS: Record<CustomizeRow, string> = {
  comments: "Comments", commentKey: "Comment key", commentHint: "Comment hint", commentHintSeconds: "Hint seconds", commentChips: "Comment chips", commentChipStyle: "Chip style", commentCollapse: "Collapse at", commentMax: "Most comments", commentMarks: "Margin marks", commentMarkGlyph: "Mark glyph", commentReplyKeys: "Reply keys", commentFolded: "Fold sent", commentSentLayout: "Sent layout", commentTemplate: "Message template", commentEntry: "Comment template",
  slashMenu: "Menu layout", slashCommands: "Edit commands", processMode: "Processes",
  imageWait: "Wait canvas", imageWaitPreset: "Wait art", imageWaitSpeed: "Frame time (ms)", imageWaitColor: "Wait colour", imageWaitMeta: "Model and size",
  tableStyle: "Table style", headingStyle: "Heading style", markdownCopyHints: "Copy hints", markdownRtl: "Right-to-left", markdownColors: "Markdown colors",
  limitCheckpoint: "Pre-limit checkpoint",
  activitySound: "Activity sound", promptStatus: "Status line", sidebarWidth: "Right bar width",
  scrollbarGlyphs: "Scrollbar glyphs", jumpHint: "Jump to latest", jumpText: "Jump text", activityPlacement: "Activity status", activityParts: "Activity parts",
  compactionPanel: "Compaction panel", compactionStyle: "Compaction card", compactionProgress: "Stage progress", compactionScratchpad: "Scratchpad",
  extensions: "UI modules", exportLook: "Export look", views: "Views", viewScaffold: "New view file",
  messageLayout: "Message layout", userIcon: "User icon", assistantIcon: "Assistant icon", userLabel: "User label", assistantLabel: "Assistant label", assistantName: "Assistant name", userLead: "User lead", assistantLead: "Assistant lead", userTint: "User tint", messageMeta: "Message meta",
  messageRenderer: "Message renderer", submitScroll: "Submit scroll", timestamps: "Timestamps", username: "Username", showUsername: "Show username", scrollbar: "Scrollbar", pasteSummary: "Paste summaries", pasteSummaryMinChars: "Paste threshold", copyOnSelect: "Copy on select", vimMode: "Vim mode", multiline: "Enter adds a line", shortcutOverlay: "? shortcut overlay", escBacktrack: "Esc Esc backtrack", queueRestore: "Interrupt restores queue", escRetract: "Esc takes back unanswered", pasteBurst: "Paste burst detection", draftRetentionDays: "Draft retention (days)", statusLeft: "Left segments", statusRight: "Right segments", statusColors: "Segment colors JSON", capabilityCatalogue: "Capabilities", promptContext: "Prompt context", graphIndex: "Code graph index", replyLanguage: "Reply language",
  tagline: "Tagline", promptGlyphs: "Border glyphs", activityStates: "Mascot states JSON", activityMessages: "Activity text JSON", showActivityModel: "Activity model", doneSymbol: "Completion symbol",
  presentation: "Chat presentation", reasoning: "Reasoning", toolLayout: "Tool layout", toolOutput: "Tool output", toolDensity: "Tool density", codeMapCard: "Code map card", diffView: "Diff view", toolDesign: "Tool design",
  logoKind: "Logo kind", homeMascot: "Mascot", mascotMotion: "Mascot motion", mascotSize: "Mascot size", logoText: "Logo text", logoFont: "Logo font", customAscii: "Logo art", productName: "Product name", homeLayout: "Welcome layout", homeInput: "Input position", homeRightPanel: "Split panel", density: "Density", homeTips: "Tips", homeFooter: "Home footer", homeHeader: "Home header", homePanel: "Home panel", showPlaceholder: "Prompt example", placeholderText: "Example text",
  promptBorder: "Prompt border", showAgent: "Agent label", showEffort: "Reasoning effort", showPermission: "Permissions", quotaRefresh: "Quota refresh", footerPack: "Footer pack", footerPreset: "Footer preset", footerRows: "Footer rows", footerText: "Footer text JSON", footerIcons: "Footer icons", glyphs: "Glyphs", footerQuota: "Footer quota", quotaView: "Quota shows", quotaColor: "Quota colour", footerToday: "Footer today",
  promptChrome: "Prompt chrome", promptLead: "Prompt lead", statusSeparator: "Separator", showModel: "Model", showProvider: "Provider", showStatus: "Footer", showCommandHint: "Commands hint", showAgentHint: "Agents hint", attachmentChips: "Attachments",
  contextBar: "Context bar", contextStyle: "Context style", topbarStats: "Top bar stats", showTopbar: "Top bar", showSessionTitle: "Session title", stickyPrompt: "Pinned prompt", showTasks: "Running tasks", dockJobs: "Dock jobs", showProject: "Project location", showDiffLines: "Diff lines", showDiffFiles: "Changed files", terminalTitle: "Window title", titleTemplate: "Title template", titleActivity: "Title activity", showStalled: "Stalled hint", usageNotices: "Limit notices", cacheNotices: "Cache notices", confirmNotices: "Confirmations", sessionAccent: "Session accent", showActivity: "Activity text", showElapsed: "Elapsed time", showTokens: "Activity tokens", showInterruptHint: "Interrupt hint", activityMascot: "Activity mascot",
  usageClock: "Usage clock", altScreen: "Alternate screen", accessible: "Screen reader", turnNotify: "Desktop notice", notifyWhen: "Notify when", autoRecap: "Recap on return", idleReturn: "Idle prompt", resumePrompts: "Resume prompts", sidebar: "Sidebar", sidebarSide: "Sidebar side", sidebarHeader: "Sidebar header", panelNarrow: "Panel when narrow", panelHeader: "Panel header", theme: "Theme", turnBell: "Bell", images: "Images", transcriptImages: "Transcript images", hyperlinks: "Hyperlinks", fileOpener: "File opener", pathClick: "Click on a path", viewerNumbers: "Viewer line numbers", viewerWrap: "Viewer wrap", viewerFocus: "Viewer takes focus", wheelLines: "Wheel lines", altLabel: "Alt key label", keyProtocol: "Key reports", optionKeys: "Option characters", rightClickPaste: "Right-click paste", pet: "Pet", petSize: "Pet size", reset: "Reset to defaults",
}

import { USAGE_WIDGET_IDS } from "./usage-widget-data"
import { SLASH_LAYOUTS, slashProfileProblems } from "./slash-menu-data"
import { parseMarkdownColors } from "./theme-data"
import { FOOTER_ICON_MODES, footerRowsProblems, footerTextProblems } from "./footer-rows-data"
import { quotaRefreshProblems } from "./quota-refresh-data"

/**
 * The named parts of the session stats registry (apps/cli/src/view/stat-parts.ts), shared by the footer (`/footer`), the activity
 * status (`activityParts`), the top bar (`topbarStats`) and the sidebar's `stats` card. The registry's formatters live in the
 * client; the names are here so a setting can be checked without loading it.
 */
export const STAT_PART_IDS = ["cache", "hit", "ctx", "tokens", "think", "calls", "spend", "tps", "ttft", "effort", "forecast"] as const
export type StatPartId = (typeof STAT_PART_IDS)[number]
/** The names in `text` (a comma list) that are not stat parts. */
export const unknownStatParts = (text: string): string[] => text.split(",").map((name) => name.trim()).filter((name) => name && !(STAT_PART_IDS as readonly string[]).includes(name))

/**
 * The parts of the activity status (the working row), in the order the default draws them; `activityParts` lists them by name.
 * The ones after `interrupt` are stat parts (session figures); `tokens` and `tps` stay this turn's live figures here.
 */
export const ACTIVITY_PARTS = ["spinner", "verb", "elapsed", "stalled", "model", "tokens", "tps", "queue", "interrupt", "cache", "hit", "ctx", "think", "calls", "spend", "ttft", "effort", "forecast"] as const
export type ActivityPart = (typeof ACTIVITY_PARTS)[number]
/** What the row shows without any setting: `tps` and `queue` are opt-in. */
export const ACTIVITY_PARTS_DEFAULT = "spinner,verb,elapsed,stalled,model,tokens,interrupt"
/** The names in `text` that are not activity parts (empty when the list is valid). */
export const unknownActivityParts = (text: string): string[] => text.split(",").map((name) => name.trim()).filter((name) => name && !(ACTIVITY_PARTS as readonly string[]).includes(name))

/** Data-only terminal profile contract, also safe in the thin client's startup graph. */
export const TUI_DEFAULTS: Readonly<Record<string, unknown>> = {
  "tableStyle": "auto",
  "headingStyle": "auto",
  "markdownCopyHints": "auto",
  "markdownRtl": true,
  "markdownColors": "",
  "slashMenu": "tabs",
  "slashGroups": [],
  "slashCommands": [],
  "disabledUiExtensions": [],
  "disabledViews": [],
  "promptContext": "focus",
  "messageRenderer": "full",
  "submitScroll": "bottom",
  "timestamps": false,
  "username": "",
  "showUsername": false,
  "scrollbar": "off",
  "scrollbarGlyphs": "",
  "jumpHint": "right",
  "jumpText": "",
  "activityPlacement": "transcript",
  "activityParts": ACTIVITY_PARTS_DEFAULT,
  "comments": "auto",
  "commentKey": "comment",
  "commentHint": "prompt",
  "commentHintSeconds": 5,
  "commentChips": "above",
  "commentChipStyle": "chips",
  "commentCollapse": 14,
  "commentMax": 9,
  "commentMarks": true,
  "commentMarkGlyph": "",
  "commentReplyKeys": "jkcd",
  "commentTemplate": "",
  "commentEntry": "",
  "commentFolded": true,
  "commentSentLayout": "rail",
  "attachmentChips": "inline",
  "pasteSummary": true,
  "pasteSummaryMinChars": 1000,
  "copyOnSelect": true,
  "vimMode": false,
  "multiline": false,
  "shortcutOverlay": true,
  "altLabel": "auto",
  "keyProtocol": "auto",
  "optionKeys": "auto",
  "escBacktrack": true,
  "queueRestore": false,
  "escRetract": true,
  "pasteBurst": true,
  "draftRetentionDays": 14,
  "statusLeft": "",
  "statusRight": "",
  "statusColors": "",
  "presentation": "auto",
  "reasoning": "auto",
  "toolOutput": "auto",
  "codeMapCard": "auto",
  "toolDensity": "calm",
  "diffView": "unified",
  "tagline": "",
  "promptGlyphs": "",
  "activityMessages": "",
  "activityStates": "",
  "showActivityModel": false,
  "doneSymbol": "◈",
  "logoKind": "wordmark",
  "homeMascot": "mend",
  "mascotMotion": true,
  "mascotSize": "medium",
  "customAscii": "",
  "homeRightPanel": "agentManager",
  "density": "comfortable",
  "theme": "",
  "themeLock": "",
  "pet": "",
  "petSize": "small",
  "promptLead": "❭",
  "statusPlacement": "auto",
  "statusSeparator": " · ",
  "showAgent": true,
  "showEffort": false,
  "showPermission": true,
  "promptBorder": "auto",
  "showModel": true,
  "showProvider": true,
  "showStatus": true,
  "showContext": true,
  "contextBar": "top",
  "contextStyle": "both",
  "topbarStats": "",
  "showFooterContext": false,
  "footerQuota": false,
  "quotaView": "used",
  "quotaColor": "pressure",
  "footerToday": false,
  "quotaRefresh": [],
  "footerRows": [],
  "footerText": {},
  "footerIcons": "none",
  "messageLayout": "quiet",
  "userIcon": "",
  "assistantIcon": "",
  "userLabel": false,
  "assistantLabel": false,
  "assistantName": "",
  "userLead": "›",
  "assistantLead": "•",
  "userTint": true,
  "messageMeta": "off",
  "showTopbar": true,
  "showSessionTitle": true,
  "stickyPrompt": true,
  "showProject": true,
  "showDiffLines": true,
  "showDiffFiles": false,
  "terminalTitle": true,
  "titleTemplate": "{product} | {session}",
  "titleActivity": true,
  "sessionAccent": false,
  "sidebarSide": "left",
  "panelNarrow": "hide",
  "panelHeader": true,
  "activityMascot": false,
  "showActivity": true,
  "showElapsed": true,
  "showTokens": true,
  "showInterruptHint": true,
  "showStalled": true,
  "usageNotices": false,
  "limitCheckpoint": true,
  "cacheNotices": false,
  "confirmNotices": false,
  "showCommandHint": false,
  "showAgentHint": false,
  "promptChrome": "top-bottom",
  "logoText": "MENDCODE",
  "logoFont": "mendcode",
  "productName": "MendCode",
  "homeLayout": "centered",
  "homeTips": false,
  "homeFooter": false,
  "homeHeader": true,
  "homePanel": true,
  "showPlaceholder": true,
  "placeholderText": "",
  "sidebarHeader": true,
  "showTasks": true,
  "usageClock": true,
  "turnBell": false,
  "turnNotify": "off",
  "notifyWhen": "unfocused",
  "autoRecap": false,
  "idleReturn": "off",
  "resumePrompts": false,
  "sidebarWidgets": [],
  "rightSidebar": false,
  "sidebarWidth": 0,
  "promptStatus": "off",
  "sidebar": "auto",
  "images": "auto",
  "transcriptImages": true,
  "hyperlinks": true,
  "fileOpener": "file",
  "pathClick": "auto",
  "viewerNumbers": true,
  "viewerWrap": "auto",
  "viewerFocus": false,
  "wheelLines": 3,
  "rightClickPaste": false,
  "altScreen": true,
  "accessible": false,
  "glyphs": "auto",
  "processMode": "auto",
  "compactionStyle": "auto",
  "compactionPanel": "panel",
  "compactionProgress": true,
  "compactionScratchpad": true,
  "activitySound": "off",
  "usageWidgets": [],
  "usageWeatherEnabled": false,
  "usageWeatherRegion": "",
  "tutorialDone": "",
  "imageWait": "animated",
  "imageWaitPreset": "drops",
  "imageWaitSpeed": 280,
  "imageWaitColor": "mixed",
  "imageWaitMeta": true,
  "imageWaitCanvas": { "minWidth": 16, "maxWidth": 72, "minHeight": 8, "maxHeight": 24, "heightRatio": 1, "paddingX": 2, "paddingY": 1 },
  "imageWaitArt": []
}
export const TUI_ENUMS: Readonly<Record<string, readonly string[]>> = {
  "imageWait": ["animated", "static"],
  "imageWaitColor": ["mixed", "accent", "muted"],
  "slashMenu": SLASH_LAYOUTS,
  "tableStyle": ["auto", "box", "rules", "grid", "minimal"],
  "headingStyle": ["auto", "banner", "bold", "underline", "uppercase"],
  "markdownCopyHints": ["auto", "code", "all", "off"],
  "contextBar": ["top", "off"],
  "contextStyle": ["bar", "percent", "both"],
  "messageLayout": ["quiet", "classic"],
  "messageMeta": ["off", "compact", "full"],
  "themeLock": ["", "dark", "light"],
  "logoFont": ["mendcode", "compact", "solid", "outline"],
  "promptContext": ["minimal", "focus", "guide", "full", "custom"],
  "presentation": [
    "auto",
    "raw",
    "mendcode",
    "minimal",
    "balanced",
    "full"
  ],
  "messageRenderer": ["plain", "markdown", "full", "rich"],
  "submitScroll": [
    "bottom",
    "clear"
  ],
  "reasoning": [
    "auto",
    "hidden",
    "collapsed",
    "expanded"
  ],
  "toolOutput": [
    "auto",
    "collapsed",
    "expanded"
  ],
  "codeMapCard": [
    "auto",
    "open",
    "folded"
  ],
  "toolDensity": [
    "calm",
    "standard",
    "dense"
  ],
  "diffView": [
    "unified",
    "split",
    "auto"
  ],
  "promptChrome": [
    "box",
    "top-bottom",
    "minimal",
    "ascii-box"
  ],
  "logoKind": [
    "wordmark",
    "mascot",
    "both",
    "custom",
    "none"
  ],
  "mascotSize": ["small", "medium", "large"],
  "petSize": ["small", "medium", "large"],
  "homeLayout": [
    "centered",
    "split"
  ],
  "homeRightPanel": [
    "actions",
    "agentManager"
  ],
  "density": [
    "compact",
    "comfortable",
    "spacious"
  ],
  "statusPlacement": [
    "auto",
    "inside",
    "outside"
  ],
  "promptBorder": [
    "auto",
    "single",
    "rounded",
    "double",
    "ascii"
  ],
  "glyphs": [
    "auto",
    "ascii",
    "unicode",
    "nerd"
  ],
  "sidebarSide": [
    "left",
    "right"
  ],
  "panelNarrow": [
    "hide",
    "sheet"
  ],
  "sidebar": [
    "auto",
    "always",
    "hidden"
  ],
  "promptStatus": ["off", "border"],
  "scrollbar": ["auto", "always", "off"],
  "jumpHint": ["right", "center", "left", "off"],
  "attachmentChips": ["inline", "above", "both"],
  "activityPlacement": ["transcript", "above", "inside", "off"],
  "comments": ["auto", "on", "off"],
  "commentKey": ["comment", "quote"],
  "altLabel": ["auto", "alt", "opt", "symbol"],
  "quotaView": ["used", "left"],
  "quotaColor": ["pressure", "accent"],
  "footerIcons": FOOTER_ICON_MODES,
  "keyProtocol": ["auto", "off"],
  "optionKeys": ["auto", "off"],
  "commentHint": ["prompt", "passage", "off"],
  "commentChips": ["above", "below", "rule"],
  "commentChipStyle": ["chips", "numbers", "count"],
  "commentSentLayout": ["rail", "stack", "inline"],
  "images": [
    "auto",
    "off",
    "kitty",
    "sixel",
    "iterm2"
  ],
  "processMode": ["auto", "solo", "daemon"],
  "fileOpener": ["file", "vscode", "vscode-insiders", "cursor", "windsurf", "zed", "idea", "none"],
  "pathClick": ["auto", "panel", "editor"],
  "viewerWrap": ["auto", "on", "off"],
  "compactionStyle": ["auto", "minimal", "cockpit", "quiet"],
  "compactionPanel": ["panel", "stats", "arcade", "scratchpad", "quiet"],
  "activitySound": ["off", "pulse", "hum"],
  "turnNotify": ["off", "osc9", "osc777"],
  "notifyWhen": ["unfocused", "always"],
  "idleReturn": ["off", "30m", "1h", "3h"]
}

/**
 * The start screen's mascot: `mend` (ASCII) or a pet of the pet system by reference. `mendy` named a built-in sprite that
 * was removed; it is still accepted and read as `mend`.
 */
export const HOME_MASCOT = /^(mend|mendy|(user|codex|package):[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/

/**
 * What users call the part a key changes when the key's own name says something else (`showStatus` is the footer): a guessed name
 * and the `customize_ui keys` search match these words as the key's name.
 */
export const PROFILE_KEY_ALIASES: Readonly<Record<string, string>> = {
  showStatus: "footer", showTopbar: "top bar topbar header", stickyPrompt: "pinned sticky", sidebar: "sessions list", sidebarSide: "sessions list", username: "name",
  timestamps: "time", jumpHint: "jump latest button pill", promptLead: "symbol", logoKind: "logo", density: "compact spacing", theme: "color",
  reasoning: "thinking", showActivity: "activity", promptBorder: "border", contextBar: "context", homeHeader: "header", sidebarHeader: "sessions list header", panelHeader: "header", homePanel: "sessions list",
  assistantName: "label name", showPlaceholder: "placeholder", activityPlacement: "activity",
}

/** Keys kept so old files still read; they draw nothing of their own and are never suggested. */
export const LEGACY_PROFILE_KEYS: ReadonlySet<string> = new Set(["rightSidebar", "showFooterContext", "tutorialDone"])

/** Profile keys that look like a guessed name: `hideTopbar` → `showTopbar`, `panel_header` → `panelHeader`, `showFooter` → `showStatus`. */
export function nearProfileKeys(guess: string): string[] {
  const bare = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "").replace(/^(show|hide|enable|disable|no)/, "")
  const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 4 && !["show", "hide", "enable", "disable"].includes(word))
  const want = bare(guess)
  const wanted = new Set(words(guess))
  const aliased = (key: string) => (PROFILE_KEY_ALIASES[key] ?? "").split(" ").includes(want)
  const score = (key: string) => bare(key) === want || aliased(key) ? 3 : want.length >= 4 && (bare(key).includes(want) || want.includes(bare(key))) ? 2 : words(key).some((word) => wanted.has(word)) ? 1 : 0
  return Object.keys(TUI_DEFAULTS).filter((key) => !LEGACY_PROFILE_KEYS.has(key)).map((key) => ({ key, score: score(key) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((row) => row.key)
}

export function tuiProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["profile must be an object"]
  const problems: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(TUI_DEFAULTS, key)) { const near = nearProfileKeys(key); problems.push(`unknown field: ${key}${near.length ? `; did you mean ${near.join(", ")}?` : ""} (find the key: customize_ui {"action":"keys","query":"<words>"}; every part and its key: mendcode docs screen-parts)`); continue }
    const expected = TUI_DEFAULTS[key]
    // `scrollbar` was a boolean before it had modes: the old value is still read (true is `always`).
    if (key === "scrollbar" && typeof value === "boolean") continue
    if (Array.isArray(expected) ? !Array.isArray(value) : typeof value !== typeof expected) problems.push(`${key}: expected ${Array.isArray(expected) ? "array" : typeof expected}`)
    else if (TUI_ENUMS[key] && !TUI_ENUMS[key]!.includes(value as string)) problems.push(`${key}: expected ${TUI_ENUMS[key]!.join("|")}`)
    else if (key === "homeMascot" && !HOME_MASCOT.test(value as string)) problems.push("homeMascot: expected mend or a pet reference (user:<id>, codex:<id>, package:<id>; /pet lists them)")
    else if (key === "slashGroups" || key === "slashCommands") problems.push(...slashProfileProblems(key, value))
    else if (key === "quotaRefresh") problems.push(...quotaRefreshProblems(value))
    else if (key === "footerRows") problems.push(...footerRowsProblems(value))
    else if (key === "footerText") problems.push(...footerTextProblems(value))
    else if (key === "markdownColors" && ((value as string).length > 2048 || parseMarkdownColors(value as string).error)) problems.push(`markdownColors: ${(value as string).length > 2048 ? "too long" : parseMarkdownColors(value as string).error}`)
    else if (key === "disabledUiExtensions" && ((value as unknown[]).length > 128 || (value as unknown[]).some((name) => typeof name !== "string" || name.length < 1 || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)))) problems.push("disabledUiExtensions: expected up to 128 module names")
    else if (key === "disabledViews" && ((value as unknown[]).length > 32 || (value as unknown[]).some((name) => typeof name !== "string" || !/^[a-z]+(\.[a-z]+)?$/.test(name)))) problems.push("disabledViews: expected up to 32 view slot names")
    else if (key === "usageWidgets" && ((value as unknown[]).length > USAGE_WIDGET_IDS.length || (value as unknown[]).some((id) => !USAGE_WIDGET_IDS.includes(id as typeof USAGE_WIDGET_IDS[number])))) problems.push("usageWidgets: unknown widget")
    else if (key === "usageWeatherRegion" && (String(value).length > 120 || /[\x00-\x1f\x7f-\x9f]/.test(String(value)))) problems.push("usageWeatherRegion: invalid region")
    else if (typeof value === "string" && (value.length > (key === "customAscii" ? 16000 : 4096) || /[\x1b\x00]/.test(value))) problems.push(`${key}: invalid terminal text`)
    else if (key === "draftRetentionDays" && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 3650)) problems.push("draftRetentionDays: expected integer 0..3650")
    else if (key === "sidebarWidth" && (!Number.isInteger(value) || Number(value) !== 0 && (Number(value) < 32 || Number(value) > 80))) problems.push("sidebarWidth: expected 0 (automatic) or an integer 32..80")
    else if (key === "wheelLines" && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20)) problems.push("wheelLines: expected integer 1..20")
    else if (key === "imageWaitSpeed" && (!Number.isInteger(value) || Number(value) < 80 || Number(value) > 5000)) problems.push("imageWaitSpeed: expected integer 80..5000 (milliseconds per frame)")
    else if (key === "imageWaitCanvas" && (!value || Array.isArray(value) || Object.entries(value).some(([field, bound]) => !Object.hasOwn(TUI_DEFAULTS.imageWaitCanvas as object, field) || typeof bound !== "number" || !Number.isFinite(bound)))) problems.push("imageWaitCanvas: expected numbers minWidth, maxWidth, minHeight, maxHeight, heightRatio, paddingX, paddingY")
    else if (key === "imageWaitArt" && ((value as unknown[]).length > 16 || JSON.stringify(value).length > 200_000 || (value as unknown[]).some((art) => !art || typeof art !== "object" || typeof (art as { name?: unknown }).name !== "string" || !Array.isArray((art as { frames?: unknown }).frames) && typeof (art as { static?: unknown }).static !== "string" && !Array.isArray((art as { static?: unknown }).static)))) problems.push("imageWaitArt: expected up to 16 presets { name, frames | static, fit?, align? }")
    else if (key === "pasteSummaryMinChars" &&(!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100000)) problems.push("pasteSummaryMinChars: expected integer 1..100000")
    else if ((key === "statusLeft" || key === "statusRight") && String(value).split(",").some((name) => name.trim() && !["mode", "model", "provider", "reasoning", "variant", "context", "permissionMode", "commandsHint", "agentsHint", "quota"].includes(name.trim()))) problems.push(`${key}: unknown status segment`)
    else if (key === "activityParts" && (unknownActivityParts(value as string).length || String(value).length > 256)) problems.push(`activityParts: expected a comma list of ${ACTIVITY_PARTS.join(", ")}`)
    else if (key === "topbarStats" && (unknownStatParts(value as string).length || String(value).length > 128)) problems.push(`topbarStats: expected a comma list of ${STAT_PART_IDS.join(", ")}`)
    else if (key === "jumpText" && String(value).length > 40) problems.push("jumpText: at most 40 characters")
    else if (key === "commentHintSeconds" && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 60)) problems.push("commentHintSeconds: expected integer 1..60")
    else if (key === "commentCollapse" && (!Number.isInteger(value) || Number(value) < 6 || Number(value) > 40)) problems.push("commentCollapse: expected integer 6..40")
    else if (key === "commentMax" && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 9)) problems.push("commentMax: expected integer 1..9")
    else if (key === "commentMarkGlyph" && value && [...String(value)].length !== 1) problems.push("commentMarkGlyph: one glyph, or empty")
    else if (key === "commentReplyKeys" && (![...String(value)].every((char, at, all) => /^[^\s\x00-\x1f\x7f\d]$/u.test(char) && all.indexOf(char) === at) || [...String(value)].length !== 4)) problems.push("commentReplyKeys: four distinct keys (next, previous, comment, decide), no digits")
    else if ((key === "commentTemplate" || key === "commentEntry") && String(value) && (String(value).length > 1200 || (key === "commentTemplate" ? !String(value).includes("{comments}") : !String(value).includes("{quote}") || !String(value).includes("{text}")))) problems.push(`${key}: at most 1200 characters, with ${key === "commentTemplate" ? "{comments}" : "{quote} and {text}"}`)
    else if (key === "scrollbarGlyphs" && [...String(value)].length > 2) problems.push("scrollbarGlyphs: at most two glyphs (thumb, track)")
    else if (key === "statusColors" && value) {
      try {
        const colors = JSON.parse(value as string)
        if (!colors || typeof colors !== "object" || Array.isArray(colors) || Object.values(colors).some((color) => typeof color !== "string" || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color))) problems.push("statusColors: expected a hex color object")
      } catch { problems.push("statusColors: expected a hex color object") }
    }
  }
  return problems
}
export const TUI_OPERATIONS = ["status", "schema", "profile", "apply", "apply-preset", "rollback", "preview", "propose", "project", "render"] as const
export type TuiOperation = (typeof TUI_OPERATIONS)[number]
export type TuiControlInput = { operation: TuiOperation; argument?: string | undefined; profile?: Record<string, unknown> | undefined; state?: "home" | "session" | undefined; dryRun?: boolean | undefined; check?: boolean | undefined; frames?: Array<{ name: string; lines: string[] }> | undefined }
export type TuiControlReport = { profile: Record<string, unknown>; path: string; valid: boolean; issues: string[]; schema?: Record<string, unknown>; proposalId?: string; backupId?: string; artifacts?: string[]; changed?: string[]; check?: { exitCode: number } }

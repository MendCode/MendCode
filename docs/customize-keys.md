# Customize keys

Use this page to find the setting key behind every row in `/customize`. The sections below follow the page's groups, and each label is what the page calls the row.

## Find a key and its values

1. Find the row in the tables below, or use `mendcode docs screen-parts` to map every part of the screen, top to bottom, to its keys.
2. Check the allowed values, types and defaults for this version:

   ```sh
   mendcode control-plane tui schema
   ```

3. Check the values now:

   ```sh
   mendcode control-plane terminal settings
   ```

Every row is a terminal setting in `<data dir>/tui/profile.json`. Its key is also the name accepted by `customize_ui`, `api.settings.get/set` and a profile's `activate.tuiProfile`.

**Note:** A profile may not set keys that start things or touch the clipboard. See [customize](customize.md).

## Remove a screen part or change a label

These rows remove a part outright:

| Key | Removes |
|---|---|
| `showTopbar` | the row above the session |
| `panelHeader` | the right panel's first row |
| `sidebarHeader` | the session list's title row |
| `showStatus` | the footer under the prompt |
| `showTasks` | running sub-agents and background commands over the prompt |
| `homeHeader` | the home screen's first row: folder, product, version |
| `homePanel` | the session list or actions under the home logo |
| `showPlaceholder` | the empty prompt's example text; `placeholderText` replaces it |

`assistantName` is the text of the assistant's label. When set, the label shows whatever `assistantLabel` says. Your own label is `username` with `showUsername`.

## Open a row with a command

Type one of these commands to open its row or toggle it. Where a command takes an argument, that value is applied.

| Commands |
|---|
| `/view`, `/vim`, `/multiline`, `/accessible` |
| `/prompt-mode`, `/prompt-chrome`, `/presentation`, `/message-rendering` |
| `/submit-scroll`, `/timestamps`, `/thinking`, `/scrollbar` |
| `/jump-to-latest`, `/mascot`, `/comments`, `/activity` |
| `/username`, `/terminal-title`, `/tips`, `/sticky-prompt`, `/raw` |

## Look settings outside the profile

`projectThemes` lives in the daemon, not in the profile. It maps a project's absolute directory to a theme name and wins over the profile's `theme` and the global `theme` there. `/theme` in that project updates it.

`MENDCODE_REDUCED_MOTION=1`, or screen-reader mode, stops the animated spinner and ticking animations in the compaction card. See [accessibility](accessibility.md).

## Keys by page section

### Look

| Key | Row label or detail |
|---|---|
| `theme` | Theme |
| `glyphs` | Glyphs |
| `sessionAccent` | Session accent |
| `diffView` | Diff view |
| `toolDesign` | Tool design |

#### Markdown

| Key | Row label |
|---|---|
| `tableStyle` | Table style |
| `headingStyle` | Heading style |
| `markdownCopyHints` | Copy hints |
| `markdownRtl` | Right-to-left |
| `markdownColors` | Markdown colors |

### Home

| Key | Row label or detail |
|---|---|
| `logoKind` | Logo: Logo kind |
| `logoText` | Logo text |
| `customAscii` | Logo art |
| `logoFont` | Logo font |
| `productName` | Product name |
| `tagline` | Tagline |
| `homeMascot` | Mascot |
| `mascotMotion` | Mascot motion |
| `mascotSize` | Mascot size |

#### Layout

| Key | Row label |
|---|---|
| `homeLayout` | Welcome layout |
| `homeInput` | Input position |
| `homePanel` | Home panel |
| `homeRightPanel` | Split panel |
| `density` | Density |
| `homeHeader` | Home header |
| `homeTips` | Tips |
| `homeFooter` | Home footer |
| `showPlaceholder` | Prompt example |
| `placeholderText` | Example text |

### Prompt & footer

| Key | Row label or detail |
|---|---|
| `promptChrome` | Prompt: Prompt chrome |
| `promptBorder` | Prompt border |
| `promptGlyphs` | Border glyphs |
| `promptLead` | Prompt lead |
| `promptStatus` | Status line |
| `attachmentChips` | Attachments |

#### Footer

| Key | Row label |
|---|---|
| `showStatus` | Footer |
| `footerPreset` | Footer preset |
| `footerRows` | Footer rows |
| `footerText` | Footer text JSON |
| `footerIcons` | Footer icons |
| `statusSeparator` | Separator |
| `showAgent` | Agent label |
| `showModel` | Model |
| `showProvider` | Provider |
| `showEffort` | Reasoning effort |
| `showPermission` | Permissions |
| `showCommandHint` | Commands hint |
| `showAgentHint` | Agents hint |
| `footerToday` | Footer today |

#### Segments

| Key | Row label |
|---|---|
| `statusLeft` | Left segments |
| `statusRight` | Right segments |
| `statusColors` | Segment colors JSON |

#### Quota

| Key | Row label |
|---|---|
| `footerQuota` | Footer quota |
| `quotaView` | Quota shows |
| `quotaColor` | Quota colour |
| `quotaRefresh` | Quota refresh |

### Chat

| Key | Row label or detail |
|---|---|
| `presentation` | Messages: Chat presentation |
| `messageRenderer` | Message renderer |
| `messageLayout` | Message layout |
| `userIcon` | User icon |
| `userLabel` | User label |
| `userLead` | User lead |
| `userTint` | User tint |
| `showUsername` | Show username |
| `username` | Username |
| `assistantIcon` | Assistant icon |
| `assistantLabel` | Assistant label |
| `assistantName` | Assistant name |
| `assistantLead` | Assistant lead |
| `messageMeta` | Message meta |
| `timestamps` | Timestamps |

#### Tools

| Key | Row label |
|---|---|
| `reasoning` | Reasoning |
| `toolLayout` | Tool layout |
| `toolOutput` | Tool output |
| `toolDensity` | Tool density |
| `codeMapCard` | Code map card |
| `transcriptImages` | Transcript images |

#### Scrolling

| Key | Row label |
|---|---|
| `submitScroll` | Submit scroll |
| `scrollbar` | Scrollbar |
| `scrollbarGlyphs` | Scrollbar glyphs |
| `jumpHint` | Jump to latest |
| `jumpText` | Jump text |
| `stickyPrompt` | Pinned prompt |

### Activity

| Key | Row label or detail |
|---|---|
| `activityPlacement` | Status: Activity status |
| `showActivity` | Activity text |
| `activityParts` | Activity parts |
| `showElapsed` | Elapsed time |
| `showTokens` | Activity tokens |
| `showInterruptHint` | Interrupt hint |
| `showStalled` | Stalled hint |
| `showActivityModel` | Activity model |
| `doneSymbol` | Completion symbol |

#### Notices

| Key | Row label |
|---|---|
| `usageNotices` | Limit notices |
| `cacheNotices` | Cache notices |
| `confirmNotices` | Confirmations |

#### Mascot

| Key | Row label |
|---|---|
| `activityMascot` | Activity mascot |
| `activityStates` | Mascot states JSON |
| `activityMessages` | Activity text JSON |
| `pet` | Pet |
| `petSize` | Pet size |

#### Image wait

| Key | Row label |
|---|---|
| `imageWait` | Wait canvas |
| `imageWaitPreset` | Wait art |
| `imageWaitSpeed` | Frame time, ms |
| `imageWaitColor` | Wait colour |
| `imageWaitMeta` | Model and size |

Also `imageWaitArt` and `imageWaitCanvas` are set in the file. See [web and image tools](tools-web.md#while-an-image-is-generated).

#### Compaction

| Key | Row label |
|---|---|
| `limitCheckpoint` | Pre-limit checkpoint |
| `compactionPanel` | Compaction panel |
| `compactionStyle` | Compaction card |
| `compactionProgress` | Stage progress |
| `compactionScratchpad` | Scratchpad |

### Top & side

| Key | Row label or detail |
|---|---|
| `showTopbar` | Top bar: Top bar |
| `topbarStats` | Top bar stats |
| `showSessionTitle` | Session title |
| `showProject` | Project location |
| `contextBar` | Context bar |
| `contextStyle` | Context style |
| `showDiffLines` | Diff lines |
| `showDiffFiles` | Changed files |

#### Sidebar & panel

| Key | Row label |
|---|---|
| `sidebar` | Sidebar |
| `sidebarSide` | Sidebar side |
| `sidebarHeader` | Sidebar header |
| `sidebarWidth` | Right bar width |
| `panelNarrow` | Panel when narrow |
| `panelHeader` | Panel header |
| `showTasks` | Running tasks |
| `dockJobs` | Dock jobs |

#### Window title

| Key | Row label |
|---|---|
| `terminalTitle` | Window title |
| `titleTemplate` | Title template |
| `titleActivity` | Title activity |

### Input & keys

| Key | Row label or detail |
|---|---|
| `vimMode` | Typing: Vim mode |
| `multiline` | Enter adds a line |
| `shortcutOverlay` | ? shortcut overlay |
| `pasteSummary` | Paste summaries |
| `pasteSummaryMinChars` | Paste threshold |
| `pasteBurst` | Paste burst detection |
| `draftRetentionDays` | Draft retention, days |

#### Esc

| Key | Row label |
|---|---|
| `escBacktrack` | Esc Esc backtrack |
| `escRetract` | Esc takes back unanswered |
| `queueRestore` | Interrupt restores queue |

#### Mouse & keys

| Key | Row label |
|---|---|
| `copyOnSelect` | Copy on select |
| `rightClickPaste` | Right-click paste |
| `wheelLines` | Wheel lines |
| `altLabel` | Alt key label |
| `keyProtocol` | Key reports |
| `optionKeys` | Option characters |

#### Files & links

| Key | Row label |
|---|---|
| `hyperlinks` | Hyperlinks |
| `fileOpener` | File opener |
| `pathClick` | Click on a path |
| `viewerNumbers` | Viewer line numbers |
| `viewerWrap` | Viewer wrap |
| `viewerFocus` | Viewer takes focus |

### Comments

| Key | Row label or detail |
|---|---|
| `comments` | Comments |
| `commentKey` | Comment key |
| `commentHint` | Comment hint |
| `commentHintSeconds` | Hint seconds |
| `commentChips` | Comment chips |
| `commentChipStyle` | Chip style |
| `commentCollapse` | Collapse at |
| `commentMax` | Most comments |
| `commentMarks` | Margin marks |
| `commentMarkGlyph` | Mark glyph |
| `commentReplyKeys` | Reply keys |
| `commentFolded` | Fold sent |
| `commentSentLayout` | Sent layout |
| `commentTemplate` | Message template |
| `commentEntry` | Comment template |

### Notifications

| Key | Row label or detail |
|---|---|
| `turnBell` | Bell |
| `turnNotify` | Desktop notice |
| `notifyWhen` | Notify when |
| `activitySound` | Activity sound |
| `autoRecap` | Recap on return |
| `idleReturn` | Idle prompt |
| `resumePrompts` | Resume prompts |

### Advanced

| Key | Row label or detail |
|---|---|
| `extensions` | Extensions: UI modules |
| `exportLook` | Export look |

#### Views

| Key | Row label |
|---|---|
| `views` | Views |
| `viewScaffold` | New view file |

#### Slash menu

| Key | Row label |
|---|---|
| `slashMenu` | Menu layout |
| `slashCommands` | Edit commands |

#### Capabilities

| Key | Row label |
|---|---|
| `promptContext` | Prompt context |
| `capabilityCatalogue` | Capabilities |
| `graphIndex` | Code graph index |

#### Terminal

| Key | Row label |
|---|---|
| `images` | Images |
| `altScreen` | Alternate screen |
| `accessible` | Screen reader |
| `processMode` | Processes |
| `usageClock` | Usage clock |
| `reset` | Reset to defaults |


## How the key reference stays current

A test holds this list to the page: a row added to `/customize` without a line here fails it.

What each key changes on screen, in a user's words, is `PROFILE_KEY_HELP` (packages/protocol/src/tui-key-help.ts; a test holds it to every key).

The model searches it with `customize_ui {"action":"keys","query":"top bar"}`. This returns matching keys with their type, allowed values, default and current value and asks for no approval. Without a query it lists every key name.

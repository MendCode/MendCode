import { describe, expect, test } from "bun:test"
import { TUI_DEFAULTS, TUI_ENUMS, tuiProblems } from "../src/tui-data"
import { PROFILE_KEY_HELP, describeProfileKey, findProfileKeys } from "../src/tui-key-help"

describe("what every profile key changes", () => {
  test("every key has one line of help and no line names a key that does not exist", () => {
    expect(Object.keys(TUI_DEFAULTS).filter((key) => !PROFILE_KEY_HELP[key])).toEqual([])
    expect(Object.keys(PROFILE_KEY_HELP).filter((key) => !Object.hasOwn(TUI_DEFAULTS, key))).toEqual([])
    for (const [key, help] of Object.entries(PROFILE_KEY_HELP)) expect([key, help.length > 8 && help.length <= 160 && !help.includes("\n")]).toEqual([key, true])
  })

  test("the words a user says for a part find its key first", () => {
    const first: Array<[string, string]> = [
      ["top bar", "showTopbar"], ["panel header", "panelHeader"], ["footer", "showStatus"], ["hide footer", "showStatus"], ["prompt border rounded", "promptBorder"],
      ["light theme", "theme"], ["message time", "timestamps"], ["sidebar right", "sidebarSide"], ["my name on messages", "username"], ["model name footer", "showModel"],
      ["compact spacing", "density"], ["session title", "showSessionTitle"], ["logo start screen", "logoKind"], ["thinking", "reasoning"], ["activity line", "activityPlacement"],
      ["assistant label", "assistantLabel"], ["prompt symbol", "promptLead"], ["context bar", "contextBar"], ["pinned prompt", "stickyPrompt"], ["jump to latest button", "jumpHint"],
      ["placeholder", "showPlaceholder"], ["sessions list header", "sidebarHeader"], ["welcome screen sessions", "homePanel"], ["scrollbar", "scrollbar"],
    ]
    for (const [query, key] of first) expect([query, findProfileKeys(query, 3)[0] ?? ""]).toEqual([query, key])
    expect(findProfileKeys("assistant label", 3)).toContain("assistantName")
    expect(findProfileKeys("the and of", 3)).toEqual([])
  })

  test("a key described: what it changes, its type, allowed values, default and the value now", () => {
    expect(describeProfileKey("promptBorder", { promptBorder: "double" })).toEqual({ key: "promptBorder", what: PROFILE_KEY_HELP.promptBorder!, type: "string", values: TUI_ENUMS.promptBorder!, default: "auto", now: "double" })
    expect(describeProfileKey("showTopbar", {})).toMatchObject({ type: "boolean", default: true, now: true })
    expect(describeProfileKey("footerRows", {})).toMatchObject({ type: "array", default: [] })
  })

  test("a guessed name is answered with the key users mean, legacy fields never offered", () => {
    expect(tuiProblems({ showFooter: false })[0]).toContain("did you mean showStatus")
    expect(tuiProblems({ showFooter: false })[0]).not.toContain("showFooterContext")
    expect(tuiProblems({ placeholder: "x" })[0]).toContain("did you mean showPlaceholder, placeholderText")
  })
})

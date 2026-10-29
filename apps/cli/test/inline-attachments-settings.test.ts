import { describe, expect, test } from "bun:test"
import { TuiControlInput } from "@mendcode/protocol"
import { CUSTOMIZE_ROWS, createCustomizePageState, customizePageKey, renderCustomizePage } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile } from "../src/view/tui-profile"

/** `attachmentChips`: where an attached image, PDF, file or folder is shown while the message is written. */

const at = (field: (typeof CUSTOMIZE_ROWS)[number]) => ({ ...createCustomizePageState(), row: CUSTOMIZE_ROWS.indexOf(field) })

describe("the attachmentChips setting", () => {
  test("defaults to inline", () => {
    expect(DEFAULT_TUI_PROFILE.attachmentChips).toBe("inline")
    expect(normalizeTuiProfile({}).attachmentChips).toBe("inline")
  })

  test("takes inline, above and both, and anything else falls back to inline", () => {
    for (const value of ["inline", "above", "both"] as const) expect(normalizeTuiProfile({ attachmentChips: value }).attachmentChips).toBe(value)
    for (const value of ["never", "", 3, null, undefined]) expect(normalizeTuiProfile({ attachmentChips: value }).attachmentChips).toBe("inline")
  })

  test("a profile written before the setting existed reads as inline", () => {
    const { attachmentChips: _gone, ...old } = DEFAULT_TUI_PROFILE
    expect(normalizeTuiProfile(old).attachmentChips).toBe("inline")
  })

  test("the control channel validates the three values", () => {
    for (const value of ["inline", "above", "both"]) expect(TuiControlInput.safeParse({ operation: "apply", profile: { attachmentChips: value } }).success).toBe(true)
    expect(TuiControlInput.safeParse({ operation: "apply", profile: { attachmentChips: "sideways" } }).success).toBe(false)
  })

  test("is a /customize row that cycles through the three values and says what it is", () => {
    expect(CUSTOMIZE_ROWS).toContain("attachmentChips")
    const next = customizePageKey(at("attachmentChips"), "l", DEFAULT_TUI_PROFILE).action
    expect(next).toEqual({ type: "set", patch: { attachmentChips: "above" } })
    const previous = customizePageKey(at("attachmentChips"), "h", DEFAULT_TUI_PROFILE).action
    expect(previous).toEqual({ type: "set", patch: { attachmentChips: "both" } })
    const rows = renderCustomizePage({ state: at("attachmentChips"), profile: DEFAULT_TUI_PROFILE, preview: { root: "/work/app", tip: "", now: 0 }, width: 120, height: 40 })
    const text = rows.map((row) => row.map((span) => span.text).join("")).join("\n")
    expect(text).toContain("Attachments")
    expect(text).toContain("inline")
  })
})

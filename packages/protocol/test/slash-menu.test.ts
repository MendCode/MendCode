import { expect, test } from "bun:test"
import { TuiProfilePatch } from "../src/tui"
import { TUI_DEFAULTS, tuiProblems } from "../src/tui-data"
import { featureOn } from "../src/tier-data"

test("slash menu is additive, tier-declared and lazily validated with the TUI patch", () => {
  const patch = { slashMenu: "columns", slashGroups: [{ id: "code", label: "Build" }], slashCommands: [{ name: "review", group: "context", pinned: true, hidden: false, order: 1 }] }
  expect(TuiProfilePatch.parse(patch)).toEqual(patch)
  expect(tuiProblems(TUI_DEFAULTS)).toEqual([])
  for (const tier of ["minimalist", "balanced", "full"] as const) expect(featureOn({ tier }, "slash_menu")).toBe(true)
})
test("user aliases validate with the patch: lowercase words, bounded, never a command name or shared", () => {
  expect(TuiProfilePatch.safeParse({ slashCommands: [{ name: "changes", aliases: ["d"] }, { name: "model", aliases: ["m", "mm"] }] }).success).toBe(true)
  for (const slashCommands of [
    [{ name: "changes", aliases: "d" }],
    [{ name: "changes", aliases: ["D"] }],
    [{ name: "changes", aliases: ["d", "d"] }],
    [{ name: "changes", aliases: ["d"] }, { name: "model", aliases: ["d"] }],
    [{ name: "changes", aliases: ["model"] }, { name: "model" }],
    [{ name: "a", aliases: ["b"] }, { name: "b", aliases: ["a"] }],
    [{ name: "changes", aliases: Array.from({ length: 9 }, (_, n) => "a" + n) }],
  ]) expect(TuiProfilePatch.safeParse({ slashCommands }).success).toBe(false)
})
test("nested profile values reject injection, unknown keys, duplicate ids and unbounded data", () => {
  for (const patch of [
    { slashMenu: "unknown" },
    { slashGroups: [{ id: "unknown", label: "Name" }] },
    { slashGroups: [{ id: "code", label: "\x1b]hello\x07" }] },
    { slashGroups: [{ id: "code", label: "Build" }, { id: "code", label: "Duplicate" }] },
    { slashGroups: [{ id: "code", label: "x".repeat(25) }] },
    { slashCommands: [{ name: "../secret" }] },
    { slashCommands: [{ name: "new", group: "recent" }] },
    { slashCommands: [{ name: "new", group: "unknown" }] },
    { slashCommands: [{ name: "new", hidden: "yes" }] },
    { slashCommands: [{ name: "new", run: "shell" }] },
    { slashCommands: [{ name: "new", order: -1 }] },
    { slashCommands: Array.from({ length: 513 }, (_, n) => ({ name: "cmd" + n })) },
  ]) expect(TuiProfilePatch.safeParse(patch).success).toBe(false)
})

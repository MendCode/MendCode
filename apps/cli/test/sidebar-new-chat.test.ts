import { describe, expect, test } from "bun:test"
import type { Line } from "../src/ui/theme"
import { folderChoices, looksLikePath, renderNewChatPicker } from "../src/view/new-chat-picker"
import { CLICK_GUARD_MS, noteSidebarFrame, sidebarClickAllowed } from "../src/view/sidebar-window"

const plain = (row: Line) => row.map((span) => span.text).join("")
const HOME = "/Users/me"
const FOLDERS = ["/work/app", `${HOME}/code/api`, "/other/api", "/work/site"]

describe("the folders a new chat can start in", () => {
  test("the open folder first, then the known ones in the order given; folders that share a name are told apart by their parent", () => {
    const choices = folderChoices({ folders: FOLDERS, opened: "/work/app", query: "", home: HOME })
    expect(choices.map((choice) => [choice.label, choice.kind])).toEqual([["app", "open"], ["code/api", "known"], ["other/api", "known"], ["site", "known"]])
    expect(choices[1]!.detail).toBe("~/code/api")
  })

  test("typing filters by every word, anywhere in the path, whatever the case", () => {
    expect(folderChoices({ folders: FOLDERS, opened: "/work/app", query: "API code", home: HOME }).map((choice) => choice.directory)).toEqual([`${HOME}/code/api`])
    expect(folderChoices({ folders: FOLDERS, opened: "/work/app", query: "work", home: HOME }).map((choice) => choice.label)).toEqual(["app", "site"])
    expect(folderChoices({ folders: FOLDERS, opened: "/work/app", query: "nothing", home: HOME })).toEqual([])
  })

  test("text that starts like a path leaves the known folders: the typed directory itself, then the ones that continue it, once each", () => {
    for (const query of ["/", "~", "~/co", "./x", "..", "../y"]) expect(looksLikePath(query), query).toBe(true)
    for (const query of ["", "api", "a/b", ".hidden"]) expect(looksLikePath(query), query).toBe(false)
    const choices = folderChoices({ folders: FOLDERS, opened: "/work/app", query: "~/code/", home: HOME, typedDirectory: `${HOME}/code`, completions: [{ directory: `${HOME}/code/api`, typed: "~/code/api/" }, { directory: `${HOME}/code/new`, typed: "~/code/new/" }, { directory: `${HOME}/code`, typed: "~/code/" }] })
    expect(choices.map((choice) => [choice.label, choice.kind, choice.typed])).toEqual([["~/code", "path", undefined], ["api/", "path", "~/code/api/"], ["new/", "path", "~/code/new/"]])
    expect(folderChoices({ folders: FOLDERS, query: "/no/such", home: HOME })).toEqual([])
  })
})

describe("the picker in the list's cells", () => {
  const choices = folderChoices({ folders: FOLDERS, opened: "/work/app", query: "", home: HOME })
  const draw = (over: Partial<Parameters<typeof renderNewChatPicker>[0]> = {}) => renderNewChatPicker({ title: "New chat in…", query: "", choices, selected: 0, width: 38, height: 16, ...over })

  test("exactly the list's size, the title, the field with the count, the picked row marked and the open folder named", () => {
    const { rows } = draw()
    const text = rows.map(plain)
    expect(text).toHaveLength(16)
    for (const row of text) expect(row).toMatch(/│$/)
    expect(new Set(text.map((row) => row.length)).size).toBe(1)
    expect(text[0]).toContain("New chat in…")
    expect(text.some((row) => /^ +> .* 4 +│$/.test(row))).toBe(true)
    expect(text.find((row) => row.includes("app"))).toMatch(/^ › app +open +│$/)
    expect(text.join("\n")).toContain("/work/app")
  })

  test("each folder row is a line to click, and the picked one stays in view in a list taller than the room", () => {
    const { rows, hits } = draw({ selected: 2 })
    expect(hits.map((hit) => hit.id)).toEqual(["pick:0", "pick:1", "pick:2", "pick:3"])
    expect(plain(rows[hits[2]!.row]!)).toMatch(/^ › other\/api/)
    const many = Array.from({ length: 40 }, (_, n) => `/repos/r${String(n).padStart(2, "0")}`)
    const tall = renderNewChatPicker({ title: "New chat in…", query: "", choices: folderChoices({ folders: many, query: "", home: HOME }), selected: 35, width: 38, height: 12 })
    expect(tall.rows).toHaveLength(12)
    expect(tall.rows.map(plain).some((row) => /^ › r35/.test(row))).toBe(true)
    expect(tall.hits.some((hit) => hit.id === "pick:35")).toBe(true)
    expect(tall.hits.some((hit) => hit.id === "pick:0")).toBe(false)
  })

  test("nothing to offer says what to do, and a bot's picker carries the bot in its title; ASCII draws no other glyph", () => {
    expect(draw({ choices: [], query: "zzz" }).rows.map(plain).join("\n")).toContain("No folder matches · type a path")
    expect(draw({ choices: [], query: "/zzz" }).rows.map(plain).join("\n")).toContain("No such directory")
    expect(plain(draw({ title: "Chat with calm in…" }).rows[0]!)).toContain("Chat with calm in…")
    // The key hint keeps `↵`, as the list's own hints do; the marks are plain.
    for (const row of draw({ ascii: true, title: "New chat in..." }).rows.map(plain)) expect(row.replace(/│$/, "").replace("↵", "")).toMatch(/^[\x20-\x7e]*$/)
  })
})

describe("the click guard", () => {
  const hits = (ids: string[]) => ids.map((sessionId, index) => ({ row: index + 2, sessionId }))

  test("a click on a line whose row just changed is dropped; a line that kept its row takes it, and so does the changed one a moment later", () => {
    let guard = noteSidebarFrame(undefined, hits(["a", "b", "c"]), 1000, false)
    guard = noteSidebarFrame(guard, hits(["a", "x", "b", "c"]), 2000, false)
    expect(sidebarClickAllowed(guard, 2, 2010)).toBe(true)
    expect(sidebarClickAllowed(guard, 3, 2010)).toBe(false)
    expect(sidebarClickAllowed(guard, 5, 2010)).toBe(false)
    // Frames in between do not forget the change, and do not renew it either.
    guard = noteSidebarFrame(guard, hits(["a", "x", "b", "c"]), 2100, false)
    expect(sidebarClickAllowed(guard, 3, 2100)).toBe(false)
    expect(sidebarClickAllowed(guard, 3, 2000 + CLICK_GUARD_MS)).toBe(true)
    guard = noteSidebarFrame(guard, hits(["a", "x", "b", "c"]), 2000 + CLICK_GUARD_MS, false)
    expect(sidebarClickAllowed(guard, 3, 2000 + CLICK_GUARD_MS)).toBe(true)
  })

  test("a line that went blank is guarded too", () => {
    let guard = noteSidebarFrame(undefined, hits(["a", "b", "c"]), 1000, false)
    guard = noteSidebarFrame(guard, hits(["a", "b"]), 2000, false)
    expect(sidebarClickAllowed(guard, 4, 2001)).toBe(false)
  })

  test("a change the user made guards nothing, and neither does a list that fills from empty", () => {
    let guard = noteSidebarFrame(undefined, hits(["a", "b"]), 1000, false)
    guard = noteSidebarFrame(guard, hits(["b", "a"]), 2000, true)
    expect(sidebarClickAllowed(guard, 2, 2001)).toBe(true)
    guard = noteSidebarFrame(noteSidebarFrame(undefined, [], 1000, false), hits(["a", "b"]), 2000, false)
    expect(sidebarClickAllowed(guard, 2, 2001)).toBe(true)
    expect(sidebarClickAllowed(undefined, 2, 0)).toBe(true)
  })
})

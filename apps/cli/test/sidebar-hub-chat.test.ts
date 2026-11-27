import { describe, expect, test } from "bun:test"
import { renderMultiSidebar, type MultiInput, type MultiSession } from "../src/view/sidebar-multi"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { chatFolder } from "../src/view/session-label"

const NOW = 1_800_000_000_000
const chat = (id: string, extra: Partial<MultiSession> = {}): MultiSession => ({ sessionId: id, title: `chat ${id}`, directory: "/work/app", updatedAt: NOW - 60_000, state: "idle", queued: 0, lastSeq: 3, ...extra })
const input = (sessions: MultiSession[]): MultiInput => ({ sessions, current: "a", directory: "/work/app", focused: false, height: 40, now: NOW, sections: ["projects"], scope: "all", icons: false, open: new Map(), projects: { isProject: () => true, count: 10 } })
const lines = (sessions: MultiSession[]) => renderMultiSidebar(input(sessions)).rows.map((row) => row.map((span) => span.text).join("").slice(0, SIDEBAR_WIDTH))

describe("a chat the hub runs is marked in the sidebar and its project says it has one", () => {
  test("the row and the project group carry the hub's name; a local chat and a local project do not", () => {
    const mixed = lines([chat("a"), chat("b", { hub: "work-hub" })])
    expect(mixed.find((line) => line.includes("chat b"))).toContain("@work")
    expect(mixed.find((line) => line.includes("chat a"))).not.toContain("@")
    expect(mixed.find((line) => /[▾▸] app/.test(line))).toContain("@work")
    expect(lines([chat("a")]).join("\n")).not.toContain("@")
  })
})

describe("where a chat's folder reads in the footer", () => {
  test("a hub chat shows the hub's own folder under the hub's name, a local one its folder", () => {
    expect(chatFolder({ hub: "work-hub", hubDirectory: "/home/dev/projects/shop/web" }, "~/Code/shop/web")).toBe("work-hub:~/projects/shop/web")
    expect(chatFolder({ hub: "work-hub", hubDirectory: "/srv/app" }, "~/Code/app")).toBe("work-hub:/srv/app")
    expect(chatFolder({}, "~/Code/app")).toBe("~/Code/app")
    expect(chatFolder(undefined, undefined)).toBeUndefined()
  })
})

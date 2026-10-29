import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry, type MemoryGraphReport } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function memory(text: string): MemoryEntry {
  return { memoryId: ids("memory"), scope: "project", directory: "/work/app", text, category: "", status: "saved", source: "user", createdAt: NOW, updatedAt: NOW }
}

function harness(report: () => MemoryGraphReport, reply: (command: Record<string, unknown>) => unknown = () => undefined) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 120, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: "/work/app",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      const custom = reply(command)
      if (custom) return custom
      if (command.type === "memory.list") return { ok: true, result: { memories: report().nodes } }
      if (command.type === "memory.graph") return { ok: true, result: report() }
      return { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  const key = async (value: string) => {
    await app.onKey(value)
    await Bun.sleep(5)
    app.render()
  }
  return { app, sent, text, key }
}

describe("/memory Graph tab", () => {
  test("tab 5 loads the graph; c needs a mark first; m then c on another memory links the pair", async () => {
    const a = memory("Use pnpm in this repo")
    const b = memory("Tests run with bun test")
    let links: MemoryGraphReport["links"] = []
    const report = (): MemoryGraphReport => ({ nodes: [a, b], links, health: { nodes: 2, links: links.length, connected: links.length ? 2 : 0, isolated: links.length ? 0 : 2, conflicts: 0, state: links.length ? "connected" : "disconnected" } })
    const { app, sent, text, key } = harness(report)
    await app.onInput("/memory")
    await key("\r")
    await key("5")
    expect(sent.some((command) => command.type === "memory.graph" && command.directory === "/work/app")).toBe(true)
    expect(text()).toContain("disconnected · 2 memories")
    expect(text()).toContain("Graph")

    await key("c")
    expect(text()).toContain("mark a memory with m")
    await key("\r")
    await key("m")
    for (const arrow of ["\x1b[C", "\x1b[B", "\x1b[D", "\x1b[A"]) {
      await key(arrow)
      await key("c")
      if (sent.some((command) => command.type === "memory.link")) break
    }
    expect(sent.find((command) => command.type === "memory.link")).toMatchObject({ from: a.memoryId, to: b.memoryId, kind: "related" })
  })

  test("a link made elsewhere shows up after memory.changed while the tab is open", async () => {
    const a = memory("Use pnpm in this repo")
    const b = memory("Tests run with bun test")
    let links: MemoryGraphReport["links"] = []
    const report = (): MemoryGraphReport => ({ nodes: [a, b], links, health: { nodes: 2, links: links.length, connected: links.length ? 2 : 0, isolated: links.length ? 0 : 2, conflicts: 0, state: links.length ? "connected" : "disconnected" } })
    const { app, text, key } = harness(report)
    await app.onInput("/memory")
    await key("\r")
    await key("5")
    expect(text()).toContain("disconnected")
    links = [{ from: a.memoryId, to: b.memoryId, kind: "related", createdAt: NOW }]
    app.onGlobal({ type: "memory.changed", gseq: 1, at: NOW, change: "linked", memoryId: a.memoryId } as never)
    await Bun.sleep(5)
    app.render()
    expect(text()).toContain("connected · 2 memories · 1 link")
  })
})

describe("/memory Dream tab", () => {
  test("tab 4 loads this project's runs, r starts one, dream.changed updates the list, enter goes to Pending", async () => {
    const runs = [{ runId: 1, directory: "/work/app", status: "done", startedAt: NOW - 60_000, endedAt: NOW - 50_000, proposed: 2 }]
    const { app, sent, text, key } = harness(() => ({ nodes: [], links: [], health: { nodes: 0, links: 0, connected: 0, isolated: 0, conflicts: 0, state: "empty" } }), (command) =>
      command.type === "dream.list" ? { ok: true, result: { runs } } : command.type === "dream.run" ? { ok: true, result: { runId: 2 } } : undefined,
    )
    await app.onInput("/memory")
    await key("\r")
    await key("4")
    expect(sent.find((command) => command.type === "dream.list")).toMatchObject({ directory: "/work/app" })
    expect(text()).toContain("2 proposals")
    await key("r")
    expect(sent.find((command) => command.type === "dream.run")).toMatchObject({ directory: "/work/app" })
    app.onGlobal({ type: "dream.changed", gseq: 2, at: NOW, run: { runId: 2, directory: "/work/app", status: "running", startedAt: NOW, proposed: 0 } } as never)
    app.render()
    expect(text()).toContain("running…")
    await key("j")
    await key("\r")
    expect(text()).toContain("Pending")
    expect(text()).toContain("no pending proposals")
  })
})

import { afterAll, describe, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import type { BotListReport, SessionSummary } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { HOME_BOT_PREFIX, renderHome, type HomeBots } from "../src/view/home"
import { homeBotEntries, renderHomeBots } from "../src/view/home-bots"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const text = (line: Line) => line.map((span) => span.text).join("")
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply

type Bot = BotListReport["bots"][number]
const bot = (name: string, state: Bot["state"], sessions: Array<{ sessionId?: string; status?: string; updatedAt?: number }> = []): Bot => ({
  name, description: "", identity: { origin: "mendcode" }, file: `/d/agents/${name}.md`, state,
  projects: sessions.length ? [{ directory: "/work/app", state, sessions: sessions.map((session) => ({ sessionId: (session.sessionId ?? ids("session")) as never, title: "chat", status: session.status ?? "running", updatedAt: session.updatedAt ?? NOW })) }] : [],
})
const report = (bots: Bot[], external: BotListReport["external"] = []): BotListReport => ({ bots, external, problems: [] })

const five = report([
  bot("mendy", "working"), bot("Aurora", "working"), bot("Kai", "working"), bot("Zed", "working"), bot("Nora", "working"), bot("Lia", "working"), bot("Omar", "working"),
  bot("Laura", "waiting"), bot("Hugo", "problem"), bot("Quiet", "idle"),
])
/** A bot's icon: the glyph of its shape, which its name decides. */
const G = "[●■◆▲⬢]"
const rows = (input: Parameters<typeof renderHomeBots>[0]) => renderHomeBots(input).lines.map(text)

describe("the Bots block", () => {
  test("a Bots title like the Agent View's sections, then one row per state in order working, waiting, problem, the state on the right", () => {
    const out = rows({ entries: homeBotEntries(five, false), width: 54 })
    console.log(out.map((row) => `|${row}|`).join("\n"))
    expect(out).toHaveLength(4)
    expect(out[0]).toBe("Bots")
    expect(out[1]).toMatch(new RegExp(`^${G} mendy {2}${G} Aurora {2}${G} Kai.* \\+ \\d more +working$`))
    expect(out[2]).toMatch(new RegExp(`^${G} Laura +waiting$`))
    expect(out[3]).toMatch(new RegExp(`^${G} Hugo +problem$`))
    for (const row of out.slice(1)) expect(textWidth(row)).toBe(54)
  })

  test("idle bots are not listed, and nothing at all is drawn when every bot is idle", () => {
    expect(rows({ entries: homeBotEntries(five, false), width: 80 }).join("\n")).not.toContain("Quiet")
    expect(renderHomeBots({ entries: homeBotEntries(report([bot("a", "idle"), bot("b", "idle")]), false), width: 60 }).lines).toEqual([])
    expect(renderHomeBots({ entries: homeBotEntries(undefined, false), width: 60 }).lines).toEqual([])
  })

  test("a state nobody is in has no row, and bots of other apps are listed with MendCode's", () => {
    const mixed = report([bot("mendy", "working")], [{ origin: "hermes", id: "p1", name: "Hermes", state: "waiting" }, { origin: "hermes", id: "p2", name: "Idle one", state: "idle" }])
    const out = rows({ entries: homeBotEntries(mixed, false), width: 60 })
    expect(out).toHaveLength(3)
    expect(out[1]).toMatch(/working$/)
    expect(out[2]).toMatch(new RegExp(`^${G} Hermes +waiting$`))
  })

  test("narrow widths drop the names first, then fold the rest into `+N`", () => {
    const narrow = rows({ entries: homeBotEntries(five, false), width: 28 })
    console.log(narrow.map((row) => `|${row}|`).join("\n"))
    expect(narrow[1]).not.toContain("mendy")
    // Narrow rows say the state with its mark alone.
    expect(rows({ entries: homeBotEntries(five, false), width: 20 })[1]).toMatch(/ ●$/)
    // Wide enough for two names they stay; one name of many is not worth the icons it hides.
    expect(rows({ entries: homeBotEntries(five, false), width: 50 })[1]).toContain("mendy")
    for (const row of narrow) expect(textWidth(row)).toBeLessThanOrEqual(28)
    const tiny = rows({ entries: homeBotEntries(five, false), width: 14 })
    for (const row of tiny) expect(textWidth(row)).toBeLessThanOrEqual(14)
    expect(tiny.join("\n")).toContain("+")
  })

  test("ASCII terminals get ASCII glyphs and marks", () => {
    const out = rows({ entries: homeBotEntries(five, true), width: 60, ascii: true })
    expect(out[1]).toMatch(/^(\(\)|\[\]|<>|\/\\|\{\}) mendy.* working$/)
    expect(out[2]).toMatch(/waiting$/)
    expect(out[3]).toMatch(/problem$/)
    // A narrow ASCII row says the state with an ASCII mark.
    expect(rows({ entries: homeBotEntries(five, true), width: 20, ascii: true })[3]).toMatch(/ x$/)
    expect(out.join("")).not.toMatch(/[●■◆▲⬢✗]/)
  })

  test("the bot's cells are hits, and the selected one is highlighted with a theme role", () => {
    const entries = homeBotEntries(five, false)
    const plain = renderHomeBots({ entries, width: 54 })
    expect(plain.hits.map((hit) => hit.id)).toContain(`${HOME_BOT_PREFIX}mendcode:mendy`)
    const hit = plain.hits.find((candidate) => candidate.id.endsWith(":mendy"))!
    expect(text(plain.lines[hit.row]!).slice(hit.from, hit.to)).toMatch(new RegExp(`^${G} mendy$`))
    const selected = renderHomeBots({ entries, width: 54, selectedId: hit.id })
    expect(selected.lines[hit.row]!.some((span) => span.bg === "element" && span.text === "mendy")).toBe(true)
  })

  test("a bot's chat is the one at work, else its newest", () => {
    const chats = report([bot("mendy", "working", [{ sessionId: "ses_old", status: "running", updatedAt: 1 }, { sessionId: "ses_new", status: "idle", updatedAt: 9 }]), bot("lone", "problem", [{ sessionId: "ses_a", status: "failed", updatedAt: 2 }, { sessionId: "ses_b", status: "failed", updatedAt: 5 }]), bot("empty", "waiting")])
    const entries = homeBotEntries(chats, false)
    expect(entries.map((entry) => entry.chat)).toEqual(["ses_old", "ses_b", undefined])
  })
})

describe("the Bots block inside the home", () => {
  const sessions = [{ id: "s1", title: "Port palette", state: "working" as const, updatedAt: NOW, startedAt: NOW - 240_000 }, { id: "s2", title: "Release notes", state: "completed" as const, updatedAt: NOW - 48 * 60_000 }]
  const bots = (placed: (hits: unknown[]) => void = () => undefined): HomeBots => ({ render: ({ width, maxRows, selectedId }) => renderHomeBots({ entries: homeBotEntries(five, false), width, maxRows, ...(selectedId !== undefined ? { selectedId } : {}) }), placed })
  const base = { root: "~/Code/app", version: "0.4.2", now: NOW, sessions }

  test("it sits under the Agent View, and `placed` says where its bots are on the finished rows", () => {
    let hits: Array<{ row: number; from: number; to: number; id: string }> = []
    const out = renderHome({ ...base, width: 100, height: 40, bots: bots((found) => { hits = found as typeof hits }) }).map(text)
    console.log(out.filter((row) => row.trim()).map((row) => `|${row}|`).join("\n"))
    const agentAt = out.findIndex((row) => row.includes("Completed"))
    const botsAt = out.findIndex((row) => row.trim() === "Bots")
    expect(botsAt).toBeGreaterThan(agentAt)
    // The title starts in the Agent View's own column.
    expect(out[botsAt]!.indexOf("Bots")).toBe(out[agentAt]!.indexOf("Completed"))
    const mendy = hits.find((hit) => hit.id.endsWith(":mendy"))!
    expect(out[mendy.row]!.slice(mendy.from, mendy.to)).toMatch(new RegExp(`^${G} mendy$`))
  })

  test("the same block is drawn in the split layout", () => {
    let hits: Array<{ row: number; from: number; to: number; id: string }> = []
    const out = renderHome({ ...base, width: 170, height: 40, look: { layout: "split" }, bots: bots((found) => { hits = found as typeof hits }) }).map(text)
    const mendy = hits.find((hit) => hit.id.endsWith(":mendy"))!
    expect(out[mendy.row]!.slice(mendy.from, mendy.to)).toMatch(new RegExp(`^${G} mendy$`))
  })

  test("without a bots block the Agent View is laid out once, not once more to size the block", () => {
    let reads = 0
    const counted = new Proxy([...sessions], { get: (target, key, receiver) => { if (key === "length") reads++; return Reflect.get(target, key, receiver) } })
    for (const layout of ["center", "split"] as const) {
      reads = 0
      renderHome({ ...base, sessions: counted, width: 170, height: 40, look: { layout } })
      const without = reads
      reads = 0
      renderHome({ ...base, sessions: counted, width: 170, height: 40, look: { layout }, bots: bots() })
      expect(without, layout).toBeLessThan(reads)
    }
  })

  test("without bots, or with every bot idle, the home is exactly what it was", () => {
    const without = renderHome({ ...base, width: 100, height: 40 }).map(text)
    const idle: HomeBots = { render: ({ width, maxRows }) => renderHomeBots({ entries: homeBotEntries(report([bot("a", "idle")]), false), width, maxRows }) }
    expect(renderHome({ ...base, width: 100, height: 40, bots: idle }).map(text)).toEqual(without)
  })

  test("a short terminal gives the sessions at work their rows first: bots shrink to fewer rows, then leave", () => {
    const shown: number[] = []
    for (const height of [9, 10, 11, 12, 13, 14, 16, 20]) {
      const placed: unknown[][] = []
      const out = renderHome({ ...base, width: 100, height, screenHeight: 30, bots: bots((hits) => placed.push(hits)) }).map(text)
      const alone = renderHome({ ...base, width: 100, height, screenHeight: 30 }).map(text)
      expect(out.join("\n").includes("Port palette"), `h${height}`).toBe(alone.join("\n").includes("Port palette"))
      expect(out.length).toBeLessThanOrEqual(height)
      shown.push(out.filter((row) => row.trim() === "Bots" || /^\S.*\s(working|waiting|problem)$/.test(row.trim())).length)
    }
    // Never more bot rows as the terminal gets shorter, and none on the shortest.
    expect(shown[0]).toBe(0)
    expect(shown.at(-1)).toBe(4)
  })

  test("with no sessions the empty line starts in the Bots block's column, so they read as one list", () => {
    const out = renderHome({ ...base, sessions: [], width: 100, height: 40, bots: bots() }).map(text)
    const empty = out.find((row) => row.includes("No sessions yet"))!
    const title = out.find((row) => row.trim() === "Bots")!
    expect(empty.indexOf("No sessions yet")).toBe(title.indexOf("Bots"))
  })

  test("the actions panel and a home without its panel draw no bots", () => {
    expect(renderHome({ ...base, width: 100, height: 40, look: { homeRightPanel: "actions" }, bots: bots() }).map(text).some((row) => row.trim() === "Bots")).toBe(false)
    expect(renderHome({ ...base, width: 100, height: 40, look: { homePanel: false }, bots: bots() }).map(text).some((row) => row.trim() === "Bots")).toBe(false)
  })
})

describe("the Bots block on the home screen of the app", () => {
  function homeApp({ flag = true, width = 100, now, listFails = false }: { flag?: boolean; width?: number; now?: () => number; listFails?: boolean } = {}) {
    const down = { listing: listFails }
    const current = ids("session")
    const chat = ids("session")
    const hermesChat = ids("session")
    const list: SessionSummary[] = [{ sessionId: current, title: "Fresh", directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 }]
    const bots = report([
      bot("mendy", "working", [{ sessionId: chat, status: "running", updatedAt: NOW }]),
      bot("Laura", "waiting"),
      bot("Hugo", "idle"),
    ], [{ origin: "hermes", id: "p1", name: "Hermes", state: "problem", projects: [{ directory: "/work/app", state: "problem", sessions: [{ sessionId: hermesChat as never, title: "chat", status: "failed", updatedAt: NOW }] }] }])
    const h = appHarness({ width, height: 40, mode: "balanced", sessionId: current, dataDir: tempDir(), directory: "/work/app", ...(now ? { now } : {}), reply: (command) => {
      if (command.type === "session.list") return reply({ sessions: (command as { directory?: string }).directory ? [] : list })
      if (command.type === "bot.list") return down.listing ? ({ ok: false, error: { code: "unavailable", message: "down" } } as unknown as CommandReply) : reply(bots)
      return undefined
    } })
    h.app.applySettings(flag ? { experimental: { bots: true } } : {})
    return { ...h, chat, hermesChat, down }
  }
  async function until(h: ReturnType<typeof homeApp>, needle: string) {
    for (let turn = 0; turn < 80; turn++) {
      h.app.render()
      if (h.text().join("\n").includes(needle)) return
      await Bun.sleep(5)
    }
    throw new Error(`never drew ${needle}:\n${h.text().join("\n")}`)
  }

  test("flag off: nothing is asked for and nothing is drawn", async () => {
    const h = homeApp({ flag: false })
    await Bun.sleep(20)
    h.app.render()
    expect(h.sentOf("bot.list")).toHaveLength(0)
    expect(h.text().join("\n")).not.toContain("Bots ")
  })

  test("flag on: the bots not idle are listed by state, from one bot.list", async () => {
    const h = homeApp()
    await until(h, "working")
    const screen = h.text()
    console.log(screen.filter((row) => row.trim()).join("\n"))
    const joined = screen.join("\n")
    expect(joined).toMatch(new RegExp(`Bots *\\n[│ ]*${G} mendy +working`))
    expect(joined).toMatch(new RegExp(`${G} Laura +waiting`))
    expect(joined).toMatch(new RegExp(`${G} Hermes +problem`))
    expect(joined).not.toContain("Hugo")
    // Asked once when the home first drew (the icon sidebar of this width asks for its own list too); more frames ask for nothing.
    const asked = h.sentOf("bot.list").length
    expect(asked).toBeLessThanOrEqual(2)
    h.app.render()
    h.app.render()
    expect(h.sentOf("bot.list")).toHaveLength(asked)
  })

  test("a session push moves the bot between rows without asking again", async () => {
    const h = homeApp()
    await until(h, "working")
    const asked = h.sentOf("bot.list").length
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.chat, directory: "/work/app", title: "chat", state: "idle", updatedAt: NOW + 1000 } as never)
    h.app.render()
    const after = h.text().join("\n")
    expect(after).not.toMatch(/mendy +working/)
    expect(after).toMatch(new RegExp(`${G} Laura +waiting`))
    expect(h.sentOf("bot.list")).toHaveLength(asked)
  })

  test("a push moves a bot of another app between rows too", async () => {
    const h = homeApp()
    await until(h, "Hermes")
    const asked = h.sentOf("bot.list").length
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.hermesChat, directory: "/work/app", title: "chat", state: "running", updatedAt: NOW + 1000 } as never)
    h.app.render()
    expect(h.text().join("\n")).toMatch(/Hermes +working/)
    expect(h.text().join("\n")).not.toMatch(/ problem *(│|$)/m)
    h.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: h.hermesChat, directory: "/work/app", title: "chat", state: "idle", updatedAt: NOW + 2000 } as never)
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Hermes")
    expect(h.sentOf("bot.list")).toHaveLength(asked)
  })

  test("a first bot.list that fails is asked again by a later frame, not never", async () => {
    let clock = NOW
    const h = homeApp({ now: () => clock, listFails: true })
    await Bun.sleep(20)
    h.app.render()
    expect(h.text().join("\n")).not.toContain("mendy")
    h.down.listing = false
    clock += 1500
    await until(h, "mendy")
  })

  test("Enter on a bot opens its most recent chat", async () => {
    const h = homeApp()
    await until(h, "mendy")
    // Down enters the list: the first stop is the first bot drawn.
    await h.type("\x1b[B")
    h.app.render()
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.chat)
  })

  test("Enter on a bot of another app opens the chat it has on its chat model", async () => {
    const h = homeApp()
    await until(h, "Hermes")
    // Stops in screen order: mendy (working), Laura (waiting), Hermes (problem).
    for (let step = 0; step < 3; step++) await h.type("\x1b[B")
    await h.type("\r")
    expect(h.app.sessionId).toBe(h.hermesChat)
  })

  test("once the left list holds a bot report the home reuses it: a reconnect or a push asks nothing for the home", async () => {
    const h = homeApp({ width: 180 })
    await until(h, "mendy")
    await Bun.sleep(20)
    h.app.render()
    // The first frame may ask beside the left list (it had no report yet); after that the home takes the list's report.
    const asked = h.sentOf("bot.list").length
    expect(asked).toBeLessThanOrEqual(2)
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: h.chat, directory: "/work/app", title: "chat", state: "idle", updatedAt: NOW + 1000 } as never)
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).not.toMatch(/mendy +working/)
    expect(h.sentOf("bot.list").length).toBe(asked)
  })

  test("a click on a bot opens its chat", async () => {
    const h = homeApp()
    await until(h, "mendy")
    const row = h.text().findIndex((line) => line.includes("mendy"))
    const col = h.text()[row]!.indexOf("mendy")
    await h.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
    expect(h.app.sessionId).toBe(h.chat)
  })
})

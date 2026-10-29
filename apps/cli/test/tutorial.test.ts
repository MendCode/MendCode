import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_BINDINGS, type Bindings } from "../src/ui/keymap"
import { activeTheme, glyphs } from "../src/ui/theme"
import { createSandbox } from "../src/tutorial/sandbox"
import { createTutorialEngine, turnKindOf } from "../src/tutorial/engine"
import { cheatSheet, keysFor, LESSONS, lessonsFor } from "../src/tutorial/lessons"
import { createTour, RAIL, type Tour, type TourOptions, type TourView } from "../src/tutorial/tour"
import { renderTutorialPage } from "../src/view/tutorial-page"
import { DEFAULT_TUI_PROFILE, readTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, NOW, plain, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const tours: Tour[] = []
afterEach(() => { for (const tour of tours.splice(0)) tour.dispose() })

const without = (bindings: Bindings, action: string): Bindings => ({
  ...bindings,
  direct: new Map([...bindings.direct].filter(([, bound]) => !("action" in bound && bound.action === action))),
  inline: new Map([...bindings.inline].filter(([, bound]) => bound !== action)),
  leader: new Map([...bindings.leader].filter(([, bound]) => !("action" in bound && bound.action === action))),
})

/** A tour on the real practice chat with the pauses cut short. */
async function tourOf(options: Partial<TourOptions> = {}) {
  const views: TourView[] = []
  const progress: string[][] = []
  const exits: number[] = []
  const tour: Tour = createTour({
    bindings: DEFAULT_BINDINGS,
    tier: "balanced",
    profile: { ...DEFAULT_TUI_PROFILE },
    glyphs: glyphs({}),
    mode: "balanced",
    reducedMotion: true,
    accessible: false,
    width: 200,
    done: [],
    all: true,
    now: () => NOW,
    onChange: () => { views.push(tour.view()) },
    onExit: () => { exits.push(1) },
    onProgress: (done) => { progress.push(done) },
    makeSandbox: createSandbox,
    sleep: (ms) => Bun.sleep(Math.min(ms, 1)),
    // The long walk keeps a turn running for a moment; everything else answers at once.
    engineSleep: (ms) => Bun.sleep(ms > 100 ? 20 : 0),
    ...options,
  })
  tours.push(tour)
  await tour.start()
  return { tour, views, progress, exits, engine: tour.sandbox.engine }
}
const until = async (check: () => boolean, ms = 4000) => {
  const started = Date.now()
  while (!check() && Date.now() - started < ms) await Bun.sleep(2)
  return check()
}
const type = async (tour: Tour, text: string) => { for (const char of text) await tour.key(char) }
const lessonIds = LESSONS.map((lesson) => lesson.id)

describe("lessons for this user and terminal", () => {
  test("a minimalist user is not taught the panel, a narrow terminal is not shown it, /tutorial all keeps it", () => {
    const wide = { wide: true, panel: true }
    expect(lessonsFor({ tier: "balanced", ...wide }).map((lesson) => lesson.id)).toContain("panel")
    expect(lessonsFor({ tier: "full", ...wide }).map((lesson) => lesson.id)).toContain("panel")
    expect(lessonsFor({ tier: "minimalist", ...wide }).map((lesson) => lesson.id)).not.toContain("panel")
    expect(lessonsFor({ tier: "balanced", wide: false, panel: true }).map((lesson) => lesson.id)).not.toContain("panel")
    expect(lessonsFor({ tier: "minimalist", wide: false, panel: false, all: true }).map((lesson) => lesson.id)).toEqual(lessonIds)
    expect(lessonsFor({ tier: undefined, ...wide }).length).toBe(lessonIds.length)
  })

  test("the tour built for a tier and a width leaves the same lessons out", async () => {
    const minimal = await tourOf({ tier: "minimalist", all: false, width: 200 })
    expect(minimal.tour.lessons.map((lesson) => lesson.id)).not.toContain("panel")
    const narrow = await tourOf({ tier: "full", all: false, width: 100 })
    expect(narrow.tour.lessons.map((lesson) => lesson.id)).not.toContain("panel")
    const roomy = await tourOf({ tier: "full", all: false, width: 200 })
    expect(roomy.tour.lessons.map((lesson) => lesson.id)).toContain("panel")
    expect(lessonIds).toHaveLength(13)
  })

  test("every lesson has a why, an action, steps, a hint and a plain-text version", () => {
    for (const lesson of LESSONS) {
      expect(lesson.why.length).toBeGreaterThan(20)
      expect(lesson.why.split(/[.!?]\s/).length).toBe(1)
      expect(lesson.action.length).toBeGreaterThan(5)
      expect(lesson.steps.length).toBeGreaterThanOrEqual(2)
      expect(lesson.hint(DEFAULT_BINDINGS).length).toBeGreaterThan(5)
      expect(lesson.text(DEFAULT_BINDINGS).length).toBeGreaterThan(0)
      expect(lesson.show(DEFAULT_BINDINGS).length).toBeGreaterThan(0)
      expect(`${lesson.title}${lesson.why}${lesson.action}`).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  test("hints name the user's effective keys and leave out one they unbound", () => {
    const model = LESSONS.find((lesson) => lesson.id === "model")!
    expect(model.hint(DEFAULT_BINDINGS)).toContain("f2")
    expect(model.show(DEFAULT_BINDINGS).some((action) => action.type === "keys" && action.echo === "f2")).toBe(true)
    const unbound = without(DEFAULT_BINDINGS, "model.next")
    expect(model.hint(unbound)).not.toContain("f2")
    expect(model.hint(unbound)).toContain("/model")
    expect(model.show(unbound).some((action) => action.type === "text" && action.text === "/model")).toBe(true)
    const sessions = LESSONS.find((lesson) => lesson.id === "sessions")!
    expect(sessions.hint(DEFAULT_BINDINGS)).toContain("ctrl+x l")
    expect(sessions.hint(without(DEFAULT_BINDINGS, "sessions"))).not.toContain("ctrl+x l")
    expect(keysFor(DEFAULT_BINDINGS, "palette").names).toContain("ctrl+p")
  })
})

describe("a lesson completes on the real event and not otherwise", () => {
  test("nothing completes by itself, by waiting, or by unrelated keys", async () => {
    const { tour, engine } = await tourOf()
    expect(tour.view().complete).toBe(false)
    expect(tour.view().steps.every((step) => !step.done)).toBe(true)
    await Bun.sleep(60)
    await type(tour, "x")
    await tour.key("\x1b[A")
    expect(tour.view().steps.every((step) => !step.done)).toBe(true)
    expect(engine.stats.turnsStarted).toBe(0)
    expect(tour.view().index).toBe(0)
  })

  test("send: the sentence in the prompt is sent with enter, then the answer finishes", async () => {
    const { tour, engine } = await tourOf()
    expect(tour.sandbox.app.editor.text).toBe("Explain src/cart.ts")
    await tour.key("\r")
    expect(tour.view().steps[0]!.done).toBe(true)
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(engine.stats.turnsCompleted).toBe(1)
    const shown = tour.sandbox.rows(100, 30).map(plain).join("\n")
    expect(shown).toContain("Read src/cart.ts")
  })

  test("enter on a finished lesson goes to the next one; on an unfinished one it is the chat's", async () => {
    const { tour } = await tourOf()
    await tour.key("\r")
    await until(() => tour.view().complete)
    await tour.key("\r")
    expect(tour.view().index).toBe(1)
    expect(tour.view().lesson?.id).toBe("slash")
    await tour.key("\x1bb")
    expect(tour.view().index).toBe(0)
  })

  test("slash: the menu opens, is browsed, and a command runs: three separate steps", async () => {
    const { tour } = await tourOf()
    await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("slash")
    expect(tour.sandbox.app.editor.text).toBe("")
    await tour.key("/")
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false, false])
    await tour.key("\x1b[C")
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, true, false])
    await type(tour, "help")
    await tour.key("\r")
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, true, true])
    expect(tour.view().complete).toBe(true)
  })

  test("mention: the @ alone is half; the file picked from the list is the other half", async () => {
    const { tour } = await tourOf()
    await tour.key(RAIL.next)
    await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("mention")
    await tour.key("@")
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false])
    await type(tour, "car")
    await tour.key("\r")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(tour.sandbox.app.editor.text).toContain("@src/cart.ts")
  })

  test("approve: reading the card is not enough, answering it is; deny counts as an answer", async () => {
    const { tour, engine } = await tourOf()
    for (let i = 0; i < 3; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("approve")
    await tour.key("\r")
    expect(await until(() => engine.asking === "approval")).toBe(true)
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false])
    await Bun.sleep(30)
    expect(tour.view().complete).toBe(false)
    expect(tour.sandbox.rows(100, 30).map(plain).join("\n")).toContain("Allow Run command?")
    await tour.key("d")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(engine.stats.resolved).toEqual(["deny"])
  })

  test("question: answering with an option is what completes it", async () => {
    const { tour, engine } = await tourOf()
    for (let i = 0; i < 4; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("question")
    await tour.key("\r")
    expect(await until(() => engine.asking === "question")).toBe(true)
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false])
    await tour.key("\r")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(engine.stats.resolved).toContain("answer")
  })

  test("steer: a queued message and a stop are separate steps of a running turn", async () => {
    const { tour, engine } = await tourOf()
    for (let i = 0; i < 5; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("steer")
    await tour.key("\r")
    expect(await until(() => engine.busy)).toBe(true)
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false, false])
    await type(tour, "then summarize it")
    await tour.key("\r")
    expect(await until(() => tour.view().steps[1]!.done)).toBe(true)
    expect(tour.view().complete).toBe(false)
    await tour.key("\x1b")
    await tour.key("\x1b")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(await until(() => engine.stats.cancelled > 0)).toBe(true)
  })

  test("model: the model is switched, then the effort of that model", async () => {
    const { tour, engine } = await tourOf()
    for (let i = 0; i < 6; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("model")
    await tour.key("\x1bOQ")
    expect(await until(() => tour.view().steps[0]!.done)).toBe(true)
    expect(tour.view().steps[1]!.done).toBe(false)
    expect(engine.stats.model).toBe("tutorial-deep")
    await tour.key("\x1b[13~")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(engine.stats.effort).not.toBe("")
  })

  test("sessions: the list opens, closes, and a new chat starts, in that order", async () => {
    const { tour } = await tourOf()
    for (let i = 0; i < 7; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("sessions")
    await tour.key("\x18")
    await tour.key("l")
    expect(await until(() => tour.sandbox.app.page === "sessions")).toBe(true)
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false, false])
    await tour.key("\x1b")
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, true, false])
    await tour.key("\x18")
    await tour.key("n")
    expect(await until(() => tour.view().complete)).toBe(true)
  })

  test("changes: the edit, the card, /changes and the undo each count once they really happen", async () => {
    const { tour, engine } = await tourOf()
    for (let i = 0; i < 8; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("changes")
    expect(engine.edited).toBe(false)
    await tour.key("\r")
    expect(await until(() => engine.asking === "approval")).toBe(true)
    await tour.key("a")
    expect(await until(() => engine.edited && !engine.busy)).toBe(true)
    expect(tour.view().steps.map((step) => step.done).slice(0, 2)).toEqual([true, false])
    await tour.key("\x0f")
    expect(tour.view().steps[1]!.done).toBe(true)
    await type(tour, "/changes")
    await tour.key("\r")
    expect(await until(() => tour.view().steps[2]!.done)).toBe(true)
    expect(tour.view().complete).toBe(false)
    await tour.key("\x1b")
    await type(tour, "/undo")
    await tour.key("\r")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(engine.edited).toBe(false)
  })

  test("history: recall, discard and restore are three gestures", async () => {
    const { tour } = await tourOf()
    for (let i = 0; i < 9; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("history")
    expect(tour.sandbox.app.editor.text).toBe("")
    await tour.key("\x1b[A")
    expect(await until(() => tour.view().steps[0]!.done)).toBe(true)
    expect(tour.sandbox.app.editor.text).not.toBe("")
    expect(tour.view().steps.map((step) => step.done)).toEqual([true, false, false])
    tour.sandbox.app.editor.replaceAll("")
    await type(tour, "a draft I will throw away")
    await tour.key("\x03")
    expect(tour.view().steps[1]!.done).toBe(true)
    await tour.key("\x1b[A")
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(tour.sandbox.app.editor.text).toBe("a draft I will throw away")
  })

  test("panel and customize: the setting must really change in the practice chat", async () => {
    const { tour } = await tourOf()
    for (let i = 0; i < 10; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("panel")
    await type(tour, "/panel")
    await tour.key("\r")
    expect(await until(() => tour.view().steps[0]!.done)).toBe(true)
    expect(tour.view().steps[1]!.done).toBe(false)
    await type(tour, "/panel next")
    await tour.key("\r")
    expect(await until(() => tour.view().complete)).toBe(true)
    await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("customize")
    await type(tour, "/customize")
    await tour.key("\r")
    expect(await until(() => tour.view().steps[0]!.done)).toBe(true)
    expect(tour.view().steps[1]!.done).toBe(false)
    for (let i = 0; i < 4; i++) await tour.key("\x1b[B")
    await tour.key("\x1b[C")
    expect(await until(() => tour.view().complete)).toBe(true)
  })

  test("help: /help and /doctor", async () => {
    const { tour } = await tourOf()
    for (let i = 0; i < 12; i++) await tour.key(RAIL.next)
    expect(tour.view().lesson?.id).toBe("help")
    await type(tour, "/help")
    await tour.key("\r")
    expect(await until(() => tour.view().steps[0]!.done)).toBe(true)
    expect(tour.view().steps[1]!.done).toBe(false)
    await tour.key("\x1b")
    await type(tour, "/doctor")
    await tour.key("\r")
    expect(await until(() => tour.view().complete)).toBe(true)
  })
})

describe("show me, skip, resume", () => {
  test("show me performs every lesson with key echoes and each one completes on its own events", async () => {
    const { tour, views } = await tourOf()
    const echoes = new Set<string>()
    for (let i = 0; i < lessonIds.length; i++) {
      expect(tour.view().lesson?.id).toBe(lessonIds[i]!)
      expect(tour.view().complete).toBe(false)
      views.length = 0
      await tour.showMe()
      for (const view of views) if (view.echo) echoes.add(view.echo)
      expect({ lesson: lessonIds[i], done: tour.view().steps.map((step) => step.done) }).toEqual({ lesson: lessonIds[i], done: tour.view().steps.map(() => true) })
      expect(tour.view().complete).toBe(true)
      await tour.key("\r")
    }
    expect(tour.view().ended).toBe(true)
    expect([...echoes]).toEqual(expect.arrayContaining(["enter", "a", "esc esc", "f2"]))
  }, 120_000)

  test("show me names the keys it presses and the tour is back to waiting for the user afterwards", async () => {
    const { tour, views } = await tourOf()
    await tour.key("\x1bm")
    expect(await until(() => views.some((view) => view.echo === "enter"))).toBe(true)
    expect(await until(() => tour.view().complete)).toBe(true)
    expect(await until(() => !tour.showing)).toBe(true)
    expect(tour.view().echo).toBe("")
  })

  test("skip moves on without counting the lesson as done, and the choice is saved", async () => {
    const { tour, progress } = await tourOf()
    await tour.key(RAIL.skip)
    expect(tour.view().index).toBe(1)
    expect(tour.view().lessons[0]!.state).toBe("skipped")
    expect(progress.at(-1)).toEqual(["send"])
    await tour.key("\x1bb")
    expect(tour.view().lessons[0]!.state).toBe("skipped")
    expect(tour.view().finished).toBe(1)
  })

  test("progress resumes after the lessons done, and a finished tour starts again", async () => {
    const resumed = await tourOf({ done: ["send", "slash"] })
    expect(resumed.tour.view().lesson?.id).toBe("mention")
    expect(resumed.tour.view().lessons.slice(0, 2).map((lesson) => lesson.state)).toEqual(["done", "done"])
    const finished = await tourOf({ done: lessonIds })
    expect(finished.tour.view().ended).toBe(false)
    expect(finished.tour.view().lesson?.id).toBe("send")
    const unknown = await tourOf({ done: ["gone", "send"] })
    expect(unknown.tour.view().lesson?.id).toBe("slash")
  })

  test("completing a lesson saves it", async () => {
    const { tour, progress } = await tourOf()
    await tour.key("\r")
    await until(() => tour.view().complete)
    expect(progress.at(-1)).toEqual(["send"])
  })

  test("leaving asks the host to close the tour", async () => {
    const { tour, exits } = await tourOf()
    await tour.key(RAIL.leave)
    expect(exits.length).toBe(1)
  })

  test("skipping every lesson ends on the cheat-sheet", async () => {
    const { tour } = await tourOf()
    for (let i = 0; i < lessonIds.length; i++) await tour.key(RAIL.skip)
    expect(tour.view().ended).toBe(true)
    const rows = renderTutorialPage({ view: tour.view(), bindings: DEFAULT_BINDINGS, sandbox: () => [], width: 100, height: 30, glyphs: glyphs({}), accessible: false }).map(plain)
    const text = rows.join("\n")
    expect(text).toContain("Tutorial complete")
    expect(text).toContain("f2")
    expect(text).toContain("ctrl+x l")
    expect(text).toContain("/import setup")
    expect(text).toContain("/customize")
    expect(text).toContain("Open a real project")
    expect(rows.length).toBe(30)
  })

  test("the cheat-sheet is the user's own keys: an unbound action is left out, a rebound one is named", () => {
    expect(cheatSheet(DEFAULT_BINDINGS).some((row) => row.what === "next model" && row.keys === "f2")).toBe(true)
    const unbound = cheatSheet(without(DEFAULT_BINDINGS, "tools.expand"))
    expect(unbound.some((row) => row.what === "open cards")).toBe(false)
    expect(unbound.some((row) => row.what === "next model")).toBe(true)
  })
})

describe("the page", () => {
  const page = async (size: [number, number], extra: Partial<Parameters<typeof renderTutorialPage>[0]> = {}) => {
    const { tour } = await tourOf({ width: size[0] })
    return renderTutorialPage({ view: tour.view(), bindings: DEFAULT_BINDINGS, sandbox: (w, h) => tour.sandbox.rows(w, h), width: size[0], height: size[1], glyphs: glyphs({}), accessible: false, ...extra }).map(plain)
  }

  test("fits every size, always says it is practice, and shows 1/N progress", async () => {
    for (const size of [[60, 20], [70, 22], [80, 24], [100, 30], [109, 30], [110, 30], [130, 32], [200, 60]] as Array<[number, number]>) {
      const rows = await page(size)
      expect(rows.length).toBe(size[1])
      for (const row of rows) expect([...row].length).toBeLessThanOrEqual(size[0])
      const text = rows.join("\n")
      expect(text).toContain("practice · nothing here is real or saved")
      expect(text).toContain("1/13")
      expect(text).toContain("Send a message")
    }
  })

  test("from 110 columns the rail stands left (about 36 columns) beside the practice chat", async () => {
    const rows = await page([130, 32])
    expect(rows[0]!.startsWith("Tutorial")).toBe(true)
    expect(rows[0]!.slice(0, 36)).toContain("1/13")
    expect(rows[0]!.slice(37)).toContain("practice · nothing here is real or saved")
    expect(rows.slice(2, 12).map((row) => row.slice(0, 36)).join("\n")).toContain("why")
    expect(rows.slice(2, 12).map((row) => row.slice(0, 36)).join("\n")).toContain("do")
    expect(rows.join("\n")).toContain("alt+m show me")
    for (const row of rows.slice(1)) expect(row[36]).toBe(" ")
  })

  test("below 110 columns it stacks: a three-row header above the chat, 80x24 included", async () => {
    const rows = await page([80, 24])
    expect(rows[0]).toContain("1/13 Send a message")
    expect(rows[1]).toContain("do press enter")
    expect(rows[2]).toContain("practice · nothing here is real or saved")
    expect(rows[2]).toContain("[ ][ ]")
    expect(rows[3]).not.toContain("practice")
    expect(rows.join("\n")).toContain("Explain src/cart.ts")
  })

  test("screen-reader mode is linear text: sentences, then the chat", async () => {
    const rows = await page([80, 30], { accessible: true })
    const text = rows.join("\n")
    expect(rows[0]).toBe("Lesson 1 of 13: Send a message.".padEnd(80))
    expect(text).toContain("To do: send it.")
    expect(text).toContain("practice chat: nothing here is real or saved")
    for (const row of rows.slice(0, 8)) expect(row).not.toMatch(/[┌┐└┘│▸▶]/)
    const first = rows.findIndex((row) => row.includes("Explain src/cart.ts"))
    expect(first).toBeGreaterThan(5)
  })
})

describe("the practice engine", () => {
  test("which sentence starts which scripted turn", () => {
    expect(turnKindOf("Explain src/cart.ts")).toBe("chat")
    expect(turnKindOf("Run the tests")).toBe("command")
    expect(turnKindOf("Ask me a question first")).toBe("question")
    expect(turnKindOf("Fix the total in src/cart.ts")).toBe("edit")
    expect(turnKindOf("Walk the whole repo and list every file")).toBe("long")
  })

  test("it answers without a model: no network, no process, and its only sessions are its own", async () => {
    const real = { fetch: globalThis.fetch, spawn: Bun.spawn }
    let touched = 0
    globalThis.fetch = (() => { touched += 1; throw new Error("network") }) as never
    ;(Bun as { spawn: unknown }).spawn = () => { touched += 1; throw new Error("spawn") }
    try {
      const engine = createTutorialEngine({ now: () => NOW, directory: "/practice", sleep: async () => undefined })
      const list = await engine.send({ type: "session.list" } as never)
      expect(list.ok).toBe(true)
      const sessions = (list as unknown as { result: { sessions: Array<{ directory: string }> } }).result.sessions
      expect(sessions.length).toBeGreaterThan(1)
      expect(sessions.every((session) => session.directory === "/practice")).toBe(true)
      await engine.send({ type: "user.submit", sessionId: engine.sessionId, text: "Explain src/cart.ts" } as never)
      await engine.settled()
      expect(engine.stats.turnsCompleted).toBe(1)
      expect(touched).toBe(0)
      engine.stop()
    } finally {
      globalThis.fetch = real.fetch
      ;(Bun as { spawn: unknown }).spawn = real.spawn
    }
  })
})

describe("/tutorial in the terminal app", () => {
  const files = (root: string): Record<string, string> => {
    const out: Record<string, string> = {}
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const full = path.join(directory, name)
        if (statSync(full).isDirectory()) walk(full)
        else out[path.relative(root, full)] = readFileSync(full, "utf8")
      }
    }
    if (existsSync(root)) walk(root)
    return out
  }
  const open = async (options: Parameters<typeof appHarness>[0] = {}) => {
    const h = appHarness({ env: { TERM: "xterm-256color" }, directory: "/work/app", ...options })
    await h.type("/tutorial\r")
    await until(() => h.text().join("\n").includes("practice · nothing here is real or saved"))
    return h
  }

  test("opens the rail beside the practice chat, keeps ctrl+c and esc for the practice chat, and alt+q leaves", async () => {
    const h = await open({ width: 130, height: 32 })
    expect(h.app.page).toBe("tutorial")
    expect(h.text()[0]).toStartWith("Tutorial")
    await h.type("\x03")
    await h.type("\x1b")
    expect(h.app.page).toBe("tutorial")
    await h.type("\x1bq")
    expect(h.app.page).toBe("chat")
    expect(h.text().join("\n")).not.toContain("practice · nothing here is real or saved")
  })

  test("nothing the practice chat does reaches the daemon, the user's files or the sessions", async () => {
    const dataDir = tempDir()
    mkdirSync(path.join(dataDir, "tui"), { recursive: true })
    const h = await open({ dataDir, width: 130, height: 32 })
    // The terminal itself remembered the /tutorial command; what is measured is everything the practice chat does after that.
    const before = files(dataDir)
    const daemonBefore = h.sent.length
    // Send, answer an approval, cancel, make an edit and undo it, switch model, open customize and change a setting.
    await h.type("\r")
    await until(() => h.text().join("\n").includes("done · enter"))
    await h.type("\x1bm")
    await Bun.sleep(30)
    await h.type("\x1bn")
    await h.type("\x1bn")
    await h.type("\x1bn")
    await h.type("Run the tests")
    await h.type("\r")
    await until(() => h.text().join("\n").includes("Allow Run command?"))
    await h.type("a")
    await h.type("\x1bOQ")
    await Bun.sleep(60)
    const daemonTypes = new Set(h.sent.slice(daemonBefore).map((command) => command.type))
    for (const forbidden of ["user.submit", "session.create", "request.resolve", "session.model.set", "session.undo", "turn.cancel", "queue.add", "prompt.record", "draft.set", "memory.save", "settings.set"]) expect(daemonTypes.has(forbidden as never)).toBe(false)
    const after = files(dataDir)
    expect(Object.keys(after).sort()).toEqual([...new Set([...Object.keys(before), path.join("tui", "profile.json")])].sort())
    expect(Object.keys(after).filter((name) => !(name in before))).toEqual([path.join("tui", "profile.json")])
    for (const [name, text] of Object.entries(after)) if (name !== path.join("tui", "profile.json")) expect(text).toBe(before[name]!)
    const profile = readTuiProfile(dataDir)
    expect({ ...profile, tutorialDone: "" }).toEqual({ ...DEFAULT_TUI_PROFILE, tutorialDone: "" })
  }, 30_000)

  test("progress is saved in the terminal profile and /tutorial resumes after it", async () => {
    const dataDir = tempDir()
    const h = await open({ dataDir, width: 130, height: 32 })
    await h.type("\r")
    await until(() => h.text().join("\n").includes("done · enter"))
    expect(readTuiProfile(dataDir).tutorialDone).toBe("send")
    await h.type("\x1bq")
    expect(h.app.page).toBe("chat")
    await h.type("/tutorial\r")
    await until(() => h.app.page === "tutorial")
    expect(h.text()[0]).toContain("2/")
    expect(h.text().join("\n")).toContain("Slash commands")
    await h.type("\x1bq")
    await h.type("/tutorial restart\r")
    await until(() => h.app.page === "tutorial")
    expect(h.text()[0]).toContain("1/")
  }, 30_000)

  test("the practice chat follows the user's tier: a minimalist run has no panel lesson", async () => {
    // Minimalist does not list /tutorial; the user adds it back (docs/tiers.md, "Slash commands").
    const h = appHarness({ env: { TERM: "xterm-256color" }, directory: "/work/app", width: 200, height: 40, hostProfile: { ...DEFAULT_TUI_PROFILE, slashCommands: [{ name: "tutorial", hidden: false }] } })
    h.app.applySettings({ tier: "minimalist", view: "minimal" } as never)
    await h.type("/tutorial\r")
    await until(() => h.app.page === "tutorial")
    expect(h.text().join("\n")).toContain("1/12")
    const full = appHarness({ env: { TERM: "xterm-256color" }, directory: "/work/app", width: 200, height: 40 })
    full.app.applySettings({ tier: "full", view: "full" } as never)
    await full.type("/tutorial\r")
    await until(() => full.app.page === "tutorial")
    expect(full.text().join("\n")).toContain("1/13")
  })

  test("screen-reader mode shows the linear lesson text", async () => {
    const h = appHarness({ env: { TERM: "xterm-256color" }, directory: "/work/app", width: 100, height: 30 })
    await h.type("/accessible on\r")
    await h.type("/tutorial\r")
    await until(() => h.app.page === "tutorial")
    expect(h.text()[0]).toStartWith("Lesson 1 of")
    expect(h.text().join("\n")).toContain("practice chat: nothing here is real or saved")
  })

  test("leaving the tour puts the global theme back", async () => {
    const before = activeTheme().name
    const h = await open({ width: 100, height: 30 })
    await h.type("\x1bq")
    expect(activeTheme().name).toBe(before)
  })
})

describe("the tutorial is not part of the startup and keeps to the app's rules", () => {
  test("its code never fetches, spawns or writes files", () => {
    const root = path.join(import.meta.dir, "..", "src")
    for (const file of ["tutorial/engine.ts", "tutorial/sandbox.ts", "tutorial/tour.ts", "tutorial/lessons.ts", "view/tutorial-page.ts"]) {
      const source = readFileSync(path.join(root, file), "utf8")
      expect(source).not.toMatch(/\bfetch\(|Bun\.spawn|child_process|node:fs|writeFile|appendFile|Bun\.write|node:net|node:http/)
      expect(source).not.toMatch(/from "zod"|^import \{[^}]*\} from "@mendcode\/protocol"/m)
    }
  })

  test("the lessons are the ones in the brief, in its order", () => {
    expect(lessonIds).toEqual(["send", "slash", "mention", "approve", "question", "steer", "model", "sessions", "changes", "history", "panel", "customize", "help"])
    const home = mkdtempSync(path.join(os.tmpdir(), "mendcode-tutorial-"))
    rmSync(home, { recursive: true, force: true })
  })
})

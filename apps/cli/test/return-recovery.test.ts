import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createScreen } from "../src/ui/screen"
import { createTerminalFocus } from "../src/ui/terminal-focus"
import { createCrashGuard, crashDetails, describeError, renderCrashScreen } from "../src/ui/crash"
import { probeLines, probeTerminal, type ProbeInput } from "../src/ui/doctor-probe"
import { awayLabel, returnPromptCard } from "../src/view/return-card"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import type { Line } from "../src/ui/theme"
import { appHarness, cleanTemps, conversation, NOW, plain, tempDir, type HarnessOptions } from "./session-ui-harness"

afterEach(cleanTemps)

const text = (rows: Line[]) => rows.map(plain).join("\n")

describe("terminal focus reports", () => {
  test("a report moves the state, is removed from the input and tells listeners once", () => {
    const focus = createTerminalFocus()
    const seen: string[] = []
    focus.subscribe((state) => seen.push(state))
    expect(focus.state).toBe("unknown")
    expect(focus.consume("a\x1b[Ob")).toBe("ab")
    expect(focus.state).toBe("unfocused")
    expect(focus.consume("\x1b[O")).toBe("")
    expect(focus.consume("\x1b[Ix")).toBe("x")
    expect(seen).toEqual(["unfocused", "focused"])
    expect(focus.consume("\x1b[A\x1b[B")).toBe("\x1b[A\x1b[B")
  })

  test("the screen asks for focus reports on a terminal, and gives them up on leaving", () => {
    const out: string[] = []
    const screen = createScreen({ write: (data: string) => out.push(data), isTTY: true, columns: 80, rows: 24 }, {})
    screen.enter()
    expect(out.join("")).toContain("\x1b[?1004h")
    expect(screen.consumeTerminalInput("\x1b[Ihi")).toBe("hi")
    expect(screen.focus.state).toBe("focused")
    screen.leave()
    expect(out.join("")).toContain("\x1b[?1004l")
  })

  test("it asks for nothing on a pipe or with MENDCODE_FOCUS_EVENTS=0", () => {
    const piped: string[] = []
    createScreen({ write: (data: string) => piped.push(data), columns: 80, rows: 24 }, {}).enter()
    expect(piped.join("")).not.toContain("1004")
    const off: string[] = []
    createScreen({ write: (data: string) => off.push(data), isTTY: true, columns: 80, rows: 24 }, { MENDCODE_FOCUS_EVENTS: "0" }).enter()
    expect(off.join("")).not.toContain("1004")
  })
})

describe("a held screen", () => {
  test("replaces the app's frames until released, and an inline chat borrows the alternate screen", () => {
    const out: string[] = []
    const screen = createScreen({ write: (data: string) => out.push(data), isTTY: true, columns: 40, rows: 6 }, {}, { inline: true })
    screen.enter()
    const before = out.length
    screen.hold([[{ text: "held message" }]])
    expect(out.slice(before).join("")).toContain("\x1b[?1049h")
    expect(out.join("")).toContain("held message")
    expect(screen.held).toBe(true)
    out.length = 0
    screen.draw([[{ text: "app frame" }]])
    screen.fullscreen(false)
    expect(out.join("")).not.toContain("app frame")
    expect(out.join("")).not.toContain("\x1b[?1049l")
    screen.release()
    out.length = 0
    screen.draw([[{ text: "app frame" }]])
    expect(out.join("")).toContain("app frame")
  })
})

describe("crash screen", () => {
  test("the details hide secrets and the home directory, and carry the facts a bug report needs", () => {
    const error = new Error("request failed with Authorization: Bearer abcDEF123456 and key sk-live-1234567890abcdef at /Users/dev/app")
    const details = crashDetails({ error, version: "9.9.9", at: Date.UTC(2026, 9, 3), env: { TERM_PROGRAM: "ghostty", TERM: "xterm-256color", OPENAI_API_KEY: "sk-secret-zzzzzzzzzzzz" }, home: "/Users/dev" })
    expect(details).toContain("version: 9.9.9")
    expect(details).toContain("2026-10-03T00:00:00.000Z")
    expect(details).toContain("terminal: ghostty · xterm-256color")
    expect(details).not.toContain("abcDEF123456")
    expect(details).not.toContain("sk-live-1234567890abcdef")
    expect(details).not.toContain("sk-secret")
    expect(details).not.toContain("/Users/dev")
    expect(details).toContain("~/app")
    expect(describeError("plain text failure")).toBe("plain text failure")
  })

  test("the screen says what happened and offers copy, back and leave; back goes away after repeated crashes", () => {
    const details = crashDetails({ error: new Error("boom"), at: 0, env: {} })
    const one = text(renderCrashScreen({ details, width: 80, height: 20, canReturn: true, copied: false, draftSaved: true }))
    expect(one).toContain("MendCode hit an unexpected error")
    expect(one).toContain("Error: boom")
    expect(one).toContain("copy details")
    expect(one).toContain("back to the app")
    expect(one).toContain("What you were typing is saved")
    const loop = text(renderCrashScreen({ details, width: 80, height: 20, canReturn: false, copied: true, draftSaved: true }))
    expect(loop).not.toContain("back to the app")
    expect(loop).toContain("going back is off")
    expect(loop).toContain("copied")
  })

  function guard() {
    const calls = { held: [] as Line[][], released: 0, written: [] as string[], exits: [] as number[], resumed: 0, saved: 0 }
    let clock = 1_000
    const instance = createCrashGuard({
      screen: { size: { width: 80, height: 20 }, hold: (rows) => void calls.held.push(rows), release: () => void calls.released++, invalidate() {}, write: (data) => void calls.written.push(data) },
      now: () => clock,
      version: "1.0.0",
      env: {},
      saveDrafts: async () => void calls.saved++,
      exit: (code) => void calls.exits.push(code),
      resume: () => void calls.resumed++,
    })
    return { instance, calls, advance: (ms: number) => void (clock += ms) }
  }

  test("an uncaught error saves the draft, takes the keys, copies on c and leaves on q", async () => {
    const { instance, calls } = guard()
    expect(instance.onInput("x")).toBe(false)
    await instance.handle(new Error("kaput"))
    expect(calls.saved).toBe(1)
    expect(instance.active).toBe(true)
    expect(text(calls.held.at(-1)!)).toContain("What you were typing is saved")
    expect(instance.onInput("x")).toBe(true)
    expect(instance.onInput("c")).toBe(true)
    expect(calls.written.join("")).toContain("\x1b]52;c;")
    expect(Buffer.from(calls.written.join("").split(";")[2]!.replace("\x07", ""), "base64").toString()).toContain("kaput")
    expect(text(calls.held.at(-1)!)).toContain("copied")
    instance.onInput("q")
    expect(calls.exits).toEqual([1])
  })

  test("r returns to the app, but the third crash in ten seconds is final", async () => {
    const { instance, calls, advance } = guard()
    await instance.handle(new Error("one"))
    instance.onInput("r")
    expect(instance.active).toBe(false)
    expect(calls.released).toBe(1)
    expect(calls.resumed).toBe(1)
    advance(1_000)
    await instance.handle(new Error("two"))
    instance.onInput("r")
    expect(calls.resumed).toBe(2)
    advance(1_000)
    await instance.handle(new Error("three"))
    expect(text(calls.held.at(-1)!)).not.toContain("back to the app")
    instance.onInput("r")
    expect(instance.active).toBe(true)
    expect(calls.resumed).toBe(2)
    instance.onInput("\x03")
    expect(calls.exits).toEqual([1])
    advance(60_000)
    instance.onInput("q")
  })

  test("an error that arrives while the screen is up changes nothing", async () => {
    const { instance, calls } = guard()
    await instance.handle(new Error("first"))
    const frames = calls.held.length
    await instance.handle(new Error("second"))
    expect(calls.held.length).toBe(frames)
    expect(calls.saved).toBe(1)
  })
})

describe("/doctor terminal probe", () => {
  const base: ProbeInput = { env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "ghostty", LANG: "en_US.UTF-8" }, size: { width: 120, height: 40 }, focus: "focused", imageProtocol: "kitty", imageMode: "auto", turnNotify: "osc9", notifyWhen: "unfocused", tty: true }
  const find = (items: ReturnType<typeof probeTerminal>, name: string) => items.find((item) => item.name === name)!

  test("a capable terminal passes the checks it can pass", () => {
    const items = probeTerminal(base)
    expect(find(items, "Terminal").status).toBe("ok")
    expect(find(items, "Colors").detail).toContain("truecolor")
    expect(find(items, "Window size").status).toBe("ok")
    expect(find(items, "Locale").status).toBe("ok")
    expect(find(items, "Images").detail).toContain("kitty")
    expect(find(items, "Focus reports").status).toBe("ok")
    expect(find(items, "Desktop notice").detail).toContain("only while the window is not focused")
    expect(items.filter((item) => item.status === "warn")).toEqual([])
  })

  test("each gap names the setting that closes it", () => {
    const items = probeTerminal({ ...base, env: { TERM: "xterm", TMUX: "/tmp/tmux-1/default,1,0", LANG: "C" }, size: { width: 60, height: 20 }, focus: "unknown", imageProtocol: "off", turnNotify: "off" })
    const warned = items.filter((item) => item.status === "warn").map((item) => item.name)
    expect(warned).toEqual(expect.arrayContaining(["Colors", "Window size", "Locale", "Clipboard (OSC 52)", "tmux"]))
    expect(find(items, "Colors").fix).toContain("COLORTERM=truecolor")
    expect(find(items, "tmux").fix).toContain("allow-passthrough")
    expect(find(items, "Focus reports").detail).toBe("none received yet")
    expect(find(items, "Desktop notice").fix).toContain("/customize")
    expect(probeLines(items).every((line) => line.startsWith("- "))).toBe(true)
  })

  test("Terminal.app is told it has no clipboard route, and a pipe is not a terminal", () => {
    const apple = probeTerminal({ ...base, env: { ...base.env, TERM_PROGRAM: "Apple_Terminal" } })
    expect(find(apple, "Clipboard (OSC 52)").status).toBe("warn")
    expect(find(apple, "Shift+Enter").detail).toContain("Terminal.app")
    expect(find(probeTerminal({ ...base, tty: false }), "Terminal").status).toBe("warn")
  })
})

describe("return card text", () => {
  test("the dialogs name their keys and the recap closes with esc", () => {
    const cwd = returnPromptCard({ kind: "cwd", sessionDirectory: "/work/a", launchDirectory: "/work/b" })
    expect(cwd.hint).toContain("m move the session here")
    expect(cwd.body.map((row) => row.text).join(" ")).toContain("/work/a")
    expect(returnPromptCard({ kind: "huge", tokens: 90_000, limit: 100_000 }).body[0]!.text).toContain("90%")
    expect(returnPromptCard({ kind: "idle", idleMs: 3 * 3_600_000, tokens: 52_000 }).title).toBe("Idle for 3h")
    const recap = returnPromptCard({ kind: "recap", text: "Goal: fix it\n- changed a.ts\n", awayMs: 20 * 60_000 })
    expect(recap.title).toBe("While you were away · 20m")
    expect(recap.body.map((row) => row.text)).toEqual(["Goal: fix it", "• changed a.ts"])
    expect(recap.hint).toContain("esc close")
    expect([awayLabel(30_000), awayLabel(90 * 60_000), awayLabel(72 * 3_600_000)]).toEqual(["1m", "2h", "3d"])
  })
})

describe("in the app", () => {
  /** An app whose clock moves, on a screen that reports focus. */
  function harness(options: HarnessOptions & { profile?: Partial<typeof DEFAULT_TUI_PROFILE>; focus?: "focused" | "unfocused" } = {}) {
    let clock = NOW
    const dataDir = tempDir()
    mkdirSync(dataDir, { recursive: true })
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...options.profile })
    const focus = createTerminalFocus()
    if (options.focus) focus.set(options.focus)
    const frames: Line[][] = []
    const written: string[] = []
    const screen = { size: { width: 110, height: 36 }, draw: (rows: Line[]) => void frames.push(rows), write: (data: string) => void written.push(data), focus, consumeTerminalInput: (data: string) => focus.consume(data) } as unknown as NonNullable<HarnessOptions["screen"]>
    const h = appHarness({ ...options, dataDir, screen, now: () => clock })
    return { ...h, focus, dataDir, advance: (ms: number) => void (clock += ms), clock: () => clock, written: written as string[] }
  }

  const turnEnd = (h: ReturnType<typeof harness>) => h.app.onEvent({ sessionId: h.sessionId, seq: 1, at: h.clock(), type: "turn.completed", turnId: "turn_a" } as never)

  describe("notifications wait for the window to lose focus", () => {
    const profile = { turnNotify: "osc9" as const, turnBell: true }

    test("focused: silent; unfocused or unknown: the bell and the notice go out", () => {
      const focused = harness({ profile, focus: "focused" })
      focused.app.applySettings({})
      turnEnd(focused)
      expect(focused.written).toEqual([])
      const away = harness({ profile, focus: "unfocused" })
      away.app.applySettings({})
      turnEnd(away)
      expect(away.written).toEqual(["\x07", "\x1b]9;MendCode: turn finished\x07"])
      const unknown = harness({ profile })
      unknown.app.applySettings({})
      turnEnd(unknown)
      expect(unknown.written).toHaveLength(2)
    })

    test("notifyWhen always rings even while focused", () => {
      const h = harness({ profile: { ...profile, notifyWhen: "always" }, focus: "focused" })
      h.app.applySettings({})
      turnEnd(h)
      expect(h.written).toHaveLength(2)
    })
  })

  describe("automatic recap on return", () => {
    const recapReply = (command: { type: string }) => command.type === "session.recap" ? { ok: true as const, result: { text: "Goal: fix the build\n- changed build.ts\nNext: run tests", cached: false } } : undefined

    test("a turn that ended while the window was away shows the recap on focus-in", async () => {
      const h = harness({ profile: { autoRecap: true }, focus: "focused", reply: recapReply })
      h.app.applySettings({})
      h.focus.set("unfocused")
      h.advance(60_000)
      turnEnd(h)
      h.advance(10 * 60_000)
      h.focus.set("focused")
      await Bun.sleep(5)
      h.app.render()
      expect(h.sentOf("session.recap")).toHaveLength(1)
      const screen = h.text().join("\n")
      expect(screen).toContain("While you were away · 11m")
      expect(screen).toContain("Goal: fix the build")
      expect(screen).toContain("• changed build.ts")
      await h.type("\x1b")
      expect(h.text().join("\n")).not.toContain("While you were away")
    })

    test("it is off by default, and a short absence or a quiet one asks for nothing", async () => {
      const off = harness({ focus: "focused", reply: recapReply })
      off.app.applySettings({})
      off.focus.set("unfocused")
      turnEnd(off)
      off.advance(20 * 60_000)
      off.focus.set("focused")
      await Bun.sleep(5)
      expect(off.sentOf("session.recap")).toHaveLength(0)
      const short = harness({ profile: { autoRecap: true }, focus: "focused", reply: recapReply })
      short.app.applySettings({})
      short.focus.set("unfocused")
      turnEnd(short)
      short.advance(60_000)
      short.focus.set("focused")
      const quiet = harness({ profile: { autoRecap: true }, focus: "focused", reply: recapReply })
      quiet.app.applySettings({})
      quiet.focus.set("unfocused")
      quiet.advance(20 * 60_000)
      quiet.focus.set("focused")
      await Bun.sleep(5)
      expect(short.sentOf("session.recap")).toHaveLength(0)
      expect(quiet.sentOf("session.recap")).toHaveLength(0)
    })

    test("a terminal that never reports focus counts a long pause in typing as the absence", async () => {
      const h = harness({ profile: { autoRecap: true }, reply: recapReply })
      h.app.applySettings({})
      await h.type("a")
      h.advance(30_000)
      turnEnd(h)
      h.advance(10 * 60_000)
      await h.type("b")
      await Bun.sleep(5)
      h.app.render()
      expect(h.sentOf("session.recap")).toHaveLength(1)
      expect(h.text().join("\n")).toContain("While you were away")
    })
  })

  describe("a message after a long idle with a large context", () => {
    const sessionAge = 3 * 3_600_000
    const reply = (tokens: number) => (command: { type: string }) => {
      if (command.type === "session.get") return { ok: true as const, result: { session: { directory: "/work/app", updatedAt: NOW - sessionAge } } }
      if (command.type === "context.query") return { ok: true as const, result: { estimatedTokens: tokens, compactAtTokens: 100_000, contextWindow: 200_000 } }
      return undefined
    }
    // The question is off unless turned on: these tests turn it on, and the last one checks the default.
    async function open(tokens: number, profile: Partial<typeof DEFAULT_TUI_PROFILE> = { idleReturn: "1h" }) {
      const h = harness({ profile, reply: reply(tokens) })
      h.app.applySettings({})
      await h.app.start()
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Fix the build.", "Done.")
      h.advance(sessionAge)
      h.app.render()
      return h
    }

    test("asks first; enter sends as it is", async () => {
      const h = await open(52_000)
      await h.type("next task")
      await h.type("\r")
      expect(h.sentOf("user.submit")).toHaveLength(0)
      expect(h.text().join("\n")).toContain("Idle for 3h")
      expect(h.text().join("\n")).toContain("52k tokens")
      await h.type("\r")
      expect(h.sentOf("user.submit")).toHaveLength(1)
      expect(h.sentOf("session.compact")).toHaveLength(0)
    })

    test("c compacts and then sends; esc keeps the text in the prompt", async () => {
      const h = await open(52_000)
      await h.type("next task")
      await h.type("\r")
      await h.type("c")
      expect(h.sent.map((command) => command.type).filter((type) => type === "session.compact" || type === "user.submit")).toEqual(["session.compact", "user.submit"])
      const kept = await open(52_000)
      await kept.type("next task")
      await kept.type("\r")
      await kept.type("\x1b")
      expect(kept.sentOf("user.submit")).toHaveLength(0)
      expect(kept.text().join("\n")).toContain("next task")
      expect(kept.text().join("\n")).not.toContain("Idle for")
    })

    test("a small context, a setting of off or a fresh session sends at once", async () => {
      // 45k of a 100k threshold: under half of it, so re-reading is cheaper than asking.
      const small = await open(45_000)
      await small.type("next task")
      await small.type("\r")
      expect(small.sentOf("user.submit")).toHaveLength(1)
      expect(DEFAULT_TUI_PROFILE).toMatchObject({ idleReturn: "off", resumePrompts: false })
      const off = await open(52_000, {})
      await off.type("next task")
      await off.type("\r")
      expect(off.sentOf("user.submit")).toHaveLength(1)
    })

    test("a dialog owns the keys: typing does not reach the prompt", async () => {
      const h = await open(52_000)
      await h.type("next task")
      await h.type("\r")
      await h.type("zzz")
      expect(h.text().join("\n")).not.toContain("next taskzzz")
    })
  })

  describe("resuming a session", () => {
    const reply = (extra: { directory?: string; tokens?: number } = {}) => (command: { type: string }) => {
      if (command.type === "session.get") return { ok: true as const, result: { session: { directory: extra.directory ?? "/work/app", updatedAt: NOW - 1_000 } } }
      if (command.type === "context.query") return { ok: true as const, result: { estimatedTokens: extra.tokens ?? 1_000, compactAtTokens: 100_000 } }
      if (command.type === "session.cd") return { ok: true as const, result: { directory: "/work/here", previous: "/work/app" } }
      return undefined
    }
    async function resume(options: HarnessOptions & { directory?: string; tokens?: number; launchDirectory?: string; profile?: Partial<typeof DEFAULT_TUI_PROFILE> } = {}) {
      const h = harness({ ...options, profile: { resumePrompts: true, ...options.profile }, reply: reply(options) })
      h.app.applySettings({})
      conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Earlier work.", "Done.")
      await h.app.start()
      await Bun.sleep(5)
      h.app.render()
      return h
    }

    test("a session that lives in another directory asks where to continue; m moves it here", async () => {
      const h = await resume({ launchDirectory: "/work/here" })
      expect(h.text().join("\n")).toContain("This session ran in another directory")
      expect(h.text().join("\n")).toContain("/work/here")
      await h.type("m")
      expect(h.sentOf("session.cd")).toEqual([expect.objectContaining({ sessionId: h.sessionId, path: "/work/here" })])
      expect(h.text().join("\n")).not.toContain("This session ran in another directory")
    })

    test("y or esc continue where it ran and move nothing", async () => {
      const h = await resume({ launchDirectory: "/work/here" })
      await h.type("y")
      expect(h.sentOf("session.cd")).toHaveLength(0)
      expect(h.text().join("\n")).not.toContain("This session ran in another directory")
    })

    test("no question without a different launch directory, or with resumePrompts off", async () => {
      const same = await resume()
      expect(same.text().join("\n")).not.toContain("another directory")
      const off = await resume({ launchDirectory: "/work/here", profile: { resumePrompts: false } })
      expect(off.text().join("\n")).not.toContain("another directory")
    })

    test("a session near its compaction threshold offers to compact; y does", async () => {
      const h = await resume({ tokens: 90_000 })
      expect(h.text().join("\n")).toContain("This session is large")
      expect(h.text().join("\n")).toContain("90%")
      await h.type("y")
      expect(h.sentOf("session.compact")).toHaveLength(1)
      expect(h.text().join("\n")).not.toContain("This session is large")
    })

    test("a small session, and a session resumed with a prompt to send, are not asked", async () => {
      const small = await resume({ tokens: 20_000 })
      expect(small.text().join("\n")).not.toContain("This session is large")
      const prompted = await resume({ tokens: 90_000, startup: { prompt: "go" } })
      expect(prompted.text().join("\n")).not.toContain("This session is large")
    })

    test("after the directory is settled the size question follows", async () => {
      const h = await resume({ launchDirectory: "/work/here", tokens: 95_000 })
      await h.type("y")
      expect(h.text().join("\n")).toContain("This session is large")
    })
  })

  describe("/doctor", () => {
    test("shows the terminal checks, then the daemon's", async () => {
      const h = harness({
        focus: "focused",
        env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "kitty" },
        reply: (command) => command.type === "system.query" ? { ok: true, result: { operation: "doctor", ok: true, checks: [{ ok: true, name: "bun", detail: "1.3" }, { ok: false, name: "rg", detail: "missing" }], facts: {} } } as never : undefined,
      })
      h.app.applySettings({})
      await h.type("/doctor")
      await h.type("\r")
      await Bun.sleep(10)
      h.app.render()
      const screen = h.text().join("\n")
      expect(screen).toContain("Doctor")
      expect(screen).toContain("Terminal")
      expect(screen).toContain("Colors: truecolor")
      expect(screen).toContain("Daemon and tools")
      expect(screen).toContain("fail · rg: missing")
      expect(h.sentOf("system.query")[0]).toMatchObject({ operation: "doctor" })
    })

    test("an attached remote terminal shows its own terminal only", async () => {
      const h = harness({ remote: { host: "box", readOnly: false } })
      h.app.applySettings({})
      await h.type("/doctor")
      await h.type("\r")
      await Bun.sleep(10)
      h.app.render()
      expect(h.text().join("\n")).toContain("Terminal")
      expect(h.sentOf("system.query")).toHaveLength(0)
    })
  })

  test("the new /customize rows save in the terminal profile", async () => {
    const h = harness({})
    h.app.applySettings({})
    await h.type("/customize")
    await h.type("\r")
    const { CUSTOMIZE_ROWS } = await import("../src/view/customize-page")
    for (const row of ["notifyWhen", "autoRecap", "idleReturn", "resumePrompts"] as const) expect(CUSTOMIZE_ROWS).toContain(row)
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("autoRecap"); i++) await h.type("\x1b[B")
    await h.type("\r")
    expect(JSON.parse(readFileSync(path.join(h.dataDir, "tui", "profile.json"), "utf8")).autoRecap).toBe(true)
  })
})

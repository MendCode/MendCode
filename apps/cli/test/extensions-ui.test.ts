import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { LEADER_KEY } from "../src/ui/keymap"
import { textWidth } from "../src/view/wrap"
import { appHarness, extension, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
const store = globalThis as unknown as { __ext?: Record<string, unknown> }
function layout() {
  const next = scratch()
  made.push(next)
  store.__ext = {}
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
  delete store.__ext
})

/** Commands the daemon would have to answer; a terminal command must cause none of them. */
const DAEMON_WORK = new Set(["user.submit", "commands.expand", "user.shell", "session.create"])

describe("terminal commands", () => {
  test("appear in the slash suggestions, marked as extension commands, beside the built-in ones", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/hello.ts", extension("hello", `api.command("hello", "Say hello from the terminal", (args, actions) => actions.toast("hi " + args))`))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/hel")
    expect(h.text()).toContain("/hello")
    expect(h.text()).toContain("Say hello from the terminal")
    expect(h.text()).toContain(":ext")
    expect(h.text()).toContain("/help")
  })

  test("run in the terminal with their arguments, without a daemon round trip", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/hello.ts", extension("hello", `api.command("hello", "Say hello", (args, actions) => actions.toast("hi " + args, "success"))`))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/hello brave world")
    await h.key("\r")
    expect(h.text()).toContain("hi brave world")
    expect(h.sent.filter((command) => DAEMON_WORK.has(String(command.type)))).toEqual([])
    // The prompt is cleared, as after any command.
    expect(h.app.editor.text).toBe("")
  })

  test("picking one from the popup inserts `/name ` so its arguments can follow", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/hello.ts", extension("hello", `api.command("hello", "Say hello", (args, actions) => actions.toast("hi " + args))`))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/hell")
    await h.key("\t")
    expect(h.app.editor.text).toBe("/hello ")
  })

  test("a command that throws is reported and the terminal carries on", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/boom.ts", extension("boom", `api.command("boom", "Always fails", () => { throw new Error("command blew up") })`))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/boom")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("boom: /boom failed: command blew up")
    expect(h.sent.filter((command) => DAEMON_WORK.has(String(command.type)))).toEqual([])
  })

  test("a command named like a built-in is refused and the built-in still runs", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/shadow.ts", extension("shadow", `api.command("help", "Not the real help", (args, actions) => actions.toast("shadowed"))`))
    const h = await appHarness({ dataDir })
    await h.start()
    // The startup toast wraps, so look for the start of the sentence.
    expect(h.text()).toContain("shadow: command /help is built in and cannot be")
    await h.type("/help")
    await h.key("\r")
    expect(h.app.page).toBe("help")
    expect(h.text()).not.toContain("shadowed")
  })

  test("actions: toast tones, insert into the prompt, submit as the user, run another command", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/actions.ts",
      extension(
        "actions",
        `
      api.command("put", "Insert text", (args, actions) => actions.insert(args))
      api.command("ask", "Ask the agent", (args, actions) => actions.submit(args))
      api.command("warn", "Warn", (args, actions) => actions.toast("careful", "warning"))
      api.command("chain", "Run hello", (args, actions) => actions.submit("/hello from chain"))
      api.command("hello", "Hello", (args, actions) => actions.toast("hello ran: " + args))
    `,
      ),
    )
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/put draft text")
    await h.key("\r")
    expect(h.app.editor.text).toBe("draft text")
    h.app.editor.clear()
    await h.type("/ask explain the build")
    await h.key("\r")
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "user.submit", text: "explain the build" }))
    await h.type("/warn")
    await h.key("\r")
    expect(h.text()).toContain("careful")
    const before = h.sent.filter((command) => command.type === "user.submit").length
    await h.type("/chain")
    await h.key("\r")
    // A submitted `/command` of a terminal extension runs locally instead of becoming a turn.
    expect(h.text()).toContain("hello ran: from chain")
    expect(h.sent.filter((command) => command.type === "user.submit").length).toBe(before)
  })

  test("submit from an extension runs a built-in command too", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/keep.ts", extension("keep", `api.command("ping", "Ping", (args, actions) => actions.submit("/usage"))`))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/ping")
    await h.key("\r")
    await Bun.sleep(5)
    expect(h.app.page).toBe("usage")
  })
})

describe("pages", () => {
  const PAGE = extension(
    "dash",
    `
    globalThis.__ext.keys = []
    globalThis.__ext.renders = 0
    api.page("dash", {
      title: "Dashboard",
      render: (ctx) => { globalThis.__ext.renders++; return [[{ text: "BODY " + ctx.width + "x" + ctx.height, fg: "primary" }], [{ text: ${JSON.stringify("W".repeat(300))} }]] },
      onKey: (key, actions) => {
        globalThis.__ext.keys.push(key)
        if (key === "q") { actions.close(); return true }
        if (key === "r") { actions.redraw(); return true }
        return key === "x"
      },
    })
    api.command("dash", "Open the dashboard", (args, actions) => actions.openPage("dash"))
`,
  )

  test("a command opens a full-screen page drawn with the page standard; esc closes it", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/dash.ts", PAGE)
    for (const width of [60, 100]) {
      const h = await appHarness({ dataDir, width, height: 24 })
      await h.start()
      await h.type("/dash")
      await h.key("\r")
      expect(h.app.page).toBe("extension")
      const rows = h.rows()
      expect(h.frames.at(-1)!.length).toBe(24)
      expect(rows.some((row) => row.includes("Dashboard"))).toBe(true)
      expect(rows.some((row) => row.includes(`BODY ${width - 2}x`))).toBe(true)
      expect(rows.some((row) => row.trim() === "esc back")).toBe(true)
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      await h.key("\x1b")
      expect(h.app.page).toBe("chat")
      expect(h.text()).not.toContain("Dashboard")
    }
  })

  test("keys are forwarded by name; a key the page handles does not close it, an unhandled esc does", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/dash.ts", PAGE)
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/dash")
    await h.key("\r")
    for (const key of ["x", "\x1b[A", "\x0f", "\x1bx", "\x1b[5~", "z"]) await h.key(key)
    expect(store.__ext!.keys).toEqual(["x", "up", "ctrl+o", "alt+x", "pgup", "z"])
    expect(h.app.page).toBe("extension")
    // Typed-ahead text reaches the page one character at a time.
    await h.app.onInput("xyz")
    expect(store.__ext!.keys).toEqual(["x", "up", "ctrl+o", "alt+x", "pgup", "z", "x", "y", "z"])
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("the page closes itself through actions.close() and redraws through actions.redraw()", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/dash.ts", PAGE)
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/dash")
    await h.key("\r")
    const renders = store.__ext!.renders as number
    await h.key("r")
    expect(store.__ext!.renders as number).toBeGreaterThan(renders)
    await h.key("q")
    expect(h.app.page).toBe("chat")
  })

  test("an unknown page id is a toast, and a page that throws while drawing closes and is disabled", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/broken.ts",
      extension(
        "broken",
        `
      api.page("bad", { title: "Bad", render: () => { throw new Error("page blew up") } })
      api.command("bad", "Open bad", (args, actions) => actions.openPage("bad"))
      api.command("ghost", "Open nothing", (args, actions) => actions.openPage("ghost"))
    `,
      ),
    )
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/ghost")
    await h.key("\r")
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("unknown page: ghost")
    await h.type("/bad")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("broken: page bad disabled: page blew up")
  })
})

describe("modals", () => {
  const MODAL = extension(
    "picker",
    `
    globalThis.__ext.keys = []
    globalThis.__ext.contexts = []
    api.modal("pick", {
      title: "Pick a branch",
      render: (ctx) => {
        globalThis.__ext.contexts.push({ width: ctx.width, height: ctx.height, breakpoint: ctx.breakpoint, screen: ctx.screen })
        const wide = ctx.breakpoint === "wide" || ctx.breakpoint === "xl"
        return [[{ text: (wide ? "WIDE " : "NARROW ") + ctx.width + "x" + ctx.height, fg: "primary" }], [{ text: ${JSON.stringify("M".repeat(300))} }]]
      },
      onKey: (key, actions) => {
        globalThis.__ext.keys.push(key)
        if (key === "enter") { actions.close(); return true }
        return key === "x"
      },
    })
    api.command("pick", "Pick a branch", (args, actions) => actions.openModal("pick"))
    api.command("unpick", "Close the modal", (args, actions) => actions.closeModal())
`,
  )

  test("a command opens a card over the chat with the palette's chrome; the chat stays drawn around it and esc closes it", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/picker.ts", MODAL)
    for (const [width, label] of [[60, "NARROW"], [100, "NARROW"], [130, "WIDE"]] as const) {
      const h = await appHarness({ dataDir, width, height: 30 })
      await h.start()
      h.message("hello there", "the answer")
      await h.type("/pick")
      await h.key("\r")
      expect(h.app.page).toBe("chat")
      const frame = h.frames.at(-1)!
      const rows = h.rows()
      expect(frame.length).toBe(30)
      const titleRow = rows.findIndex((row) => row.includes("Pick a branch"))
      expect(titleRow).toBeGreaterThanOrEqual(0)
      // The palette's title row: the title, then `esc` at the card's right edge, on the panel fill.
      expect(rows[titleRow]).toMatch(/Pick a branch +esc/)
      expect(frame[titleRow]!.some((span) => span.text.includes("Pick a branch") && span.bg === "panel")).toBe(true)
      const body = rows.find((row) => row.includes(label))!
      expect(body).toBeDefined()
      const context = (store.__ext!.contexts as Array<{ width: number; height: number; breakpoint: string; screen: { width: number; height: number } }>).at(-1)!
      expect(context.screen).toEqual({ width, height: 30 })
      expect(context.breakpoint).toBe(width >= 110 ? "wide" : width >= 70 ? "normal" : "compact")
      // The body is the card's inner width: the palette's card less its padding, never the whole screen.
      expect(context.width).toBeLessThan(width)
      expect(body).toContain(`${context.width}x${context.height}`)
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      // The long row is cut at the card's inner edge.
      const long = rows.find((row) => row.includes("MMMM"))!
      expect(long.match(/M+/)![0].length).toBe(context.width)
      // The transcript is still drawn around the card.
      expect(h.text()).toContain("hello there")
      await h.key("\x1b")
      expect(h.text()).not.toContain("Pick a branch")
      expect(h.app.page).toBe("chat")
    }
  })

  test("a width share sizes the card, and every frame calls render with a fresh context", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/narrow.ts", extension("narrow", `
      globalThis.__ext.widths = []
      api.modal("half", { title: "Half", width: 0.5, render: (ctx) => { globalThis.__ext.widths.push([ctx.screen.width, ctx.width, ctx.breakpoint]); return [[{ text: "half " + ctx.breakpoint }]] } })
      api.command("half", "Half", (args, actions) => actions.openModal("half"))
    `))
    const h = await appHarness({ dataDir, width: 160, height: 40 })
    await h.start()
    await h.type("/half")
    await h.key("\r")
    expect(h.text()).toContain("half xl")
    const widths = store.__ext!.widths as Array<[number, number, string]>
    // Half of 160 columns, less the card's padding of three columns a side.
    expect(widths.at(-1)).toEqual([160, 80 - 6, "xl"])
    const calls = widths.length
    h.app.render()
    expect(widths.length).toBe(calls + 1)
  })

  test("keys go to the modal by name, typed-ahead text one character at a time; nothing reaches the prompt; ctrl+c closes it", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/picker.ts", MODAL)
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/pick")
    await h.key("\r")
    for (const key of ["x", "\x1b[A", "\x0f", "z"]) await h.key(key)
    await h.app.onInput("ab")
    expect(store.__ext!.keys).toEqual(["x", "up", "ctrl+o", "z", "a", "b"])
    expect(h.app.editor.text).toBe("")
    expect(h.text()).toContain("Pick a branch")
    // enter is handled by the modal, which closes itself.
    await h.key("\r")
    expect(h.text()).not.toContain("Pick a branch")
    await h.type("/pick")
    await h.key("\r")
    await h.key("\x03")
    expect(h.text()).not.toContain("Pick a branch")
    // ctrl+c closed the modal; it did not leave the terminal or clear anything else.
    expect(h.app.page).toBe("chat")
  })

  test("a modal opens over an extension page and closes back to it; closeModal closes it from a command", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/both.ts", extension("both", `
      api.page("dash", { title: "Dashboard", render: () => [[{ text: "PAGE BODY" }]], onKey: (key, actions) => { if (key === "m") { globalThis.__ext.open("pick"); return true } return false } })
      api.modal("pick", { title: "Over the page", render: () => [[{ text: "MODAL ON PAGE" }]] })
      api.key("f8", (actions) => { globalThis.__ext.open = actions.openModal; actions.openPage("dash") })
    `))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.key("\x1b[19~")
    expect(h.app.page).toBe("extension")
    await h.key("m")
    expect(h.text()).toContain("MODAL ON PAGE")
    expect(h.text()).toContain("Dashboard")
    await h.key("\x1b")
    expect(h.app.page).toBe("extension")
    expect(h.text()).not.toContain("MODAL ON PAGE")
    expect(h.text()).toContain("PAGE BODY")
  })

  test("a modal that throws while drawing or on a key closes and is disabled; an unknown id is a toast", async () => {
    const { dataDir, write } = layout()
    // Two modules: the terminal toasts the first problem of each extension once.
    write("data/extensions/bad.ts", extension("bad", `
      api.modal("draw", { title: "Draw", render: () => { throw new Error("modal blew up") } })
      api.command("draw", "Draw", (args, actions) => actions.openModal("draw"))
      api.command("ghost", "Ghost", (args, actions) => actions.openModal("ghost"))
    `))
    write("data/extensions/worse.ts", extension("worse", `
      api.modal("keys", { title: "Keys", render: () => [[{ text: "KEYS MODAL" }]], onKey: () => { throw new Error("key blew up") } })
      api.command("keys", "Keys", (args, actions) => actions.openModal("keys"))
    `))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/ghost")
    await h.key("\r")
    expect(h.text()).toContain("unknown modal: ghost")
    await h.type("/draw")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("bad: modal draw disabled: modal blew up")
    expect(h.text()).not.toContain("Draw ")
    // The prompt has the keyboard again.
    await h.type("q")
    expect(h.app.editor.text).toBe("q")
    h.app.editor.clear()
    await h.type("/keys")
    await h.key("\r")
    expect(h.text()).toContain("KEYS MODAL")
    await h.key("x")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).not.toContain("KEYS MODAL")
    expect(h.text()).toContain("worse: modal keys onKey disabled: key blew up")
    await h.type("/keys")
    await h.key("\r")
    expect(h.text()).toContain("unknown modal: keys")
  })
})

describe("the responsive modal example", () => {
  const EXAMPLE = readFileSync(path.join(import.meta.dir, "../../../examples/extensions/branches.ts"), "utf8")

  test("opens from the palette and ctrl+x B, lays out by breakpoint, and enter inserts the branch", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/branches.ts", EXAMPLE)
    for (const width of [60, 100, 160]) {
      const h = await appHarness({ dataDir, width, height: 30 })
      await h.start()
      await h.key("\x10")
      await h.type("pick a branch")
      await h.key("\r")
      const rows = h.rows()
      expect(rows.some((row) => /Branches +esc/.test(row))).toBe(true)
      expect(rows.some((row) => row.includes("› main"))).toBe(true)
      // A second column from the wide breakpoint up.
      expect(rows.some((row) => /› main +default/.test(row))).toBe(width >= 110)
      for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      // The card is the whole terminal less two columns when it is compact, half of it from 70 columns up.
      const title = h.frames.at(-1)!.find((row) => row.some((span) => span.text.includes("Branches")))!
      expect(textWidth(title.filter((span) => span.bg === "panel").map((span) => span.text).join(""))).toBe(width < 70 ? width - 2 : width / 2)
      await h.key("\x1b[B")
      await h.key("\r")
      expect(h.app.editor.text).toBe("integration/all")
      expect(h.text()).not.toContain("Branches")
      h.app.editor.clear()
      await h.key(LEADER_KEY)
      await h.key("B")
      expect(h.rows().some((row) => /Branches +esc/.test(row))).toBe(true)
      await h.key("\x1b")
    }
  })
})

describe("named actions", () => {
  test("api.action shows in the palette under its title and runs from it; a throw is reported and the action stays", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/acts.ts", extension("acts", `
      globalThis.__ext.runs = 0
      api.action("deploy", (actions) => { globalThis.__ext.runs++; actions.toast("deploying") }, { title: "Deploy preview", description: "push the branch to preview" })
      api.action("boom", () => { throw new Error("action blew up") }, { title: "Explode" })
    `))
    const h = await appHarness({ dataDir, width: 120, height: 30 })
    await h.start()
    await h.key("\x10")
    await h.type("deploy prev")
    expect(h.text()).toContain("Deploy preview")
    await h.key("\r")
    expect(store.__ext!.runs).toBe(1)
    expect(h.text()).toContain("deploying")
    await h.key("\x10")
    await h.type("explode")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("acts: action boom failed: action blew up")
    await h.key("\x10")
    await h.type("explode")
    expect(h.text()).toContain("Explode")
  })
})

describe("every tier", () => {
  test("a user extension loads under the minimalist tier: commands, modals, actions, and header and footer slots in the minimal view", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/mine.ts", extension("mine", `
      api.slot("header.replace", ({ breakpoint }) => [[{ text: "MY HEADER " + breakpoint }]])
      api.slot("footer.right", () => [[{ text: "MY FOOTER" }]])
      api.modal("m", { title: "Mine", render: () => [[{ text: "MY MODAL" }]] })
      api.action("hi", (actions) => actions.toast("hi from action"), { title: "Say hi" })
      api.command("mine", "Mine", (args, actions) => actions.openModal("m"))
    `))
    for (const tier of ["minimalist", "balanced", "full"] as const) {
      const h = await appHarness({ dataDir, mode: tier === "minimalist" ? "minimal" : tier })
      await h.start({ tier, onboarded: true })
      h.message("hello", "ready")
      expect(h.text()).toContain("MY HEADER normal")
      expect(h.text()).toContain("MY FOOTER")
      await h.type("/min")
      expect(h.text()).toContain("/mine")
      h.app.editor.clear()
      await h.type("/mine")
      await h.key("\r")
      expect(h.text()).toContain("MY MODAL")
      await h.key("\x1b")
      await h.key("\x10")
      await h.type("say hi")
      await h.key("\r")
      expect(h.text()).toContain("hi from action")
    }
  })
})

describe("redraw", () => {
  test("api.redraw schedules one frame however often it is called, and a terminal without extensions schedules none", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/ticker.ts", extension("ticker", `globalThis.__ext.api = api; api.slot("footer.left", () => [[{ text: "tick" }]])`))
    const queue: Array<() => void> = []
    const drain = () => {
      while (queue.length) queue.shift()!()
    }
    const h = await appHarness({ dataDir, schedule: (fn) => void queue.push(fn) })
    await h.start()
    drain()
    const drawn = h.frames.length
    const api = store.__ext!.api as { redraw(): void }
    api.redraw()
    api.redraw()
    api.redraw()
    expect(queue.length).toBe(1)
    drain()
    expect(h.frames.length).toBe(drawn + 1)
    expect(h.text()).toContain("tick")

    const quiet = await appHarness({ dataDir: layout().dataDir, schedule: (fn) => void queue.push(fn) })
    await quiet.start()
    queue.length = 0
    await quiet.app.extensionsReady
    expect(queue.length).toBe(0)
  })
})

test("per-role message styles override the local profile in each terminal", async () => {
  const { dataDir, write } = layout()
  write("data/extensions/roles.ts", extension("roles", `api.messageStyle("user", { icon: "◆", lead: "", label: true, tint: false }); api.messageStyle("assistant", { lead: "→", label: false })`))
  const h = await appHarness({ dataDir })
  await h.start({ onboarded: true })
  h.message("hello", "ready")
  expect(h.text()).toContain("◆ You hello")
  expect(h.text()).toContain("→ ready")
  const user = h.frames.at(-1)!.find((row) => row.map((span) => span.text).join("").includes("hello"))!
  expect(user.every((span) => span.bg !== "promptBg")).toBe(true)
  const second = await appHarness({ dataDir })
  await second.start({ onboarded: true })
  second.message("hello", "ready")
  expect(second.text()).toContain("◆ You hello")
  expect(second.text()).toContain("→ ready")
})

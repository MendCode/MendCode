import { afterEach, expect, test } from "bun:test"
import { TUI_DEFAULTS } from "@mendcode/protocol/wire"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { discoverExtensions } from "../src/extensions/discover"
import { textWidth } from "../src/view/wrap"
import { appHarness, extension, scratch } from "./extensions-harness"
import { SLASH_COMMANDS } from "../src/view/commands"
import { slashMenuModel, createSlashMenuState } from "../src/view/slash-menu"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"

const temporary: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })
function sandbox() { const temp = scratch(); temporary.push(temp); return temp }
async function runtime(body: string, extra: Parameters<typeof createExtensionRuntime>[0] = { redraw() {} }) {
  const temp = sandbox()
  temp.write("data/extensions/look.ts", extension("look", body))
  const instance = createExtensionRuntime(extra)
  await instance.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
  return instance
}
const slot = { width: 20, height: 30, now: 0, directory: "/project", state: "idle" as const }
const env = (width: number, height: number) => ({ width, height, theme: { name: "t", colors: {} }, ascii: true, now: 0 })
const noArgs = { validArg: () => false }
test("slashMenu view freezes nested input, clips output and opens its circuit after three faults", async () => {
  const ctx = slashMenuModel({ text: "/", custom: [], profile: { ...DEFAULT_TUI_PROFILE }, settings: {}, recents: [], state: createSlashMenuState(), selected: 0, width: 60, height: 3, ascii: true })!
  const good = await runtime('api.view("slashMenu", ctx => { if (!Object.isFrozen(ctx.catalog) || !Object.isFrozen(ctx.catalog[0].aliases) || !Object.isFrozen(ctx.items[0].command)) throw Error("mutable"); return Array.from({length:100}, () => [{text:"x".repeat(200) + "\\x1b[31m"}]) })')
  const drawn = good.views.call("slash.menu", ctx, env(60, 3), noArgs) as { lines: Array<Array<{ text: string }>> }
  const lines = drawn.lines
  expect(lines).toHaveLength(3)
  for (const row of lines) { expect(textWidth(row.map((span) => span.text).join(""))).toBe(60); expect(row.map((span) => span.text).join("")).not.toContain("\x1b") }
  expect(good.registrations()[0]?.renderers).toContain("view:slash.menu")
  for (const body of ['() => { throw Error("broken") }', 'async () => []', 'async () => { throw Error("rejected") }', '() => ({lines: []})']) {
    const bad = await runtime(`api.view("slashMenu", ${body})`)
    for (let call = 0; call < 5; call++) expect(bad.views.call("slash.menu", ctx, env(60, 3), noArgs)).toBeUndefined()
    // Three strikes, then the view is not asked again; one notice.
    expect(bad.views.status()[0]).toMatchObject({ tripped: true, strikes: 3 })
    expect(bad.views.has("slash.menu")).toBe(false)
    expect(bad.problems).toHaveLength(1)
    expect(bad.registrations()[0]?.renderers).toContain("view:slash.menu (disabled)")
    bad.dispose()
    expect(bad.active).toBe(false)
  }
  good.dispose()
  expect(SLASH_COMMANDS[0]?.name).toBe("new")
})
const text = (rows: ReturnType<Awaited<ReturnType<typeof runtime>>["message"]>) => rows?.map((row) => row.map((span) => span.text).join("")).join("\n")

test("per-role renderers get immutable data, width and theme; defaults and exceptions are guarded once", async () => {
  const reports: unknown[] = []
  const instance = await runtime(`
    for (const role of ["user", "assistant", "tool", "meta"]) api.renderMessage(role, ctx => {
      if (!Object.isFrozen(ctx.message) || !Object.isFrozen(ctx.theme)) throw Error("mutable context")
      if (ctx.message.text === "default") return undefined
      if (ctx.message.text === "throw") throw Error("broken renderer")
      return [[{text: role + ":" + ctx.width + ":" + ctx.theme.name + ":" + ctx.message.text + "x".repeat(100)}]]
    })`, { redraw() {}, onProblem: (problem) => reports.push(problem) })
  for (const role of ["user", "assistant", "tool", "meta"] as const) {
    expect(instance.message({ role, text: "default" }, 20)).toBeUndefined()
    const rendered = text(instance.message({ role, text: "hello" }, 20))!
    expect(rendered).toStartWith(`${role}:20:`)
    expect(textWidth(rendered)).toBeLessThanOrEqual(20)
    instance.message({ role, text: "throw" }, 20)
    instance.message({ role, text: "throw" }, 20)
  }
  expect(reports).toHaveLength(4)
  instance.dispose()
})

test("per-role markdown chains without changing other roles; legacy transform remains assistant-only", async () => {
  const instance = await runtime(`api.markdown(text => text + " legacy"); api.markdown("user", (text, ctx) => text + ":" + ctx.message.role); api.markdown("tool", () => { throw Error("bad markdown") })`)
  expect(instance.markdown("raw", { role: "user", text: "raw" }, 20)).toBe("raw:user")
  expect(instance.markdown("raw", { role: "assistant", text: "raw" }, 20)).toBe("raw legacy")
  expect(instance.markdown("raw", { role: "meta", text: "raw" }, 20)).toBe("raw")
  instance.markdown("raw", { role: "tool", text: "raw" }, 20)
  instance.markdown("raw", { role: "tool", text: "raw" }, 20)
  expect(instance.problems).toHaveLength(1)
  instance.dispose()
})

test("footer rows, prompt replacement cursor and widget surfaces are bounded and guarded", async () => {
  const instance = await runtime(`
    api.slot("footer.replace", () => Array.from({length: 20}, (_, index) => [{text: "row" + index}]))
    api.prompt.replace(() => ({lines: Array.from({length:20}, () => [{text: "p".repeat(100)}]),cursor:{row:0,col:1}}))
    api.prompt.chrome({lead:"λ",border:"rounded",preset:"box"})
    api.widget("tray", "one", {title:"Tray",render:()=>[[{text:"T"}]]})
    api.widget("sidebar", "one", {title:"Side",render:()=>[[{text:"S"}]]})
  `)
  // The ceiling is the one `footerRows` shares (12); the footer then cuts to a quarter of the terminal's height.
  expect(instance.footerRows("footer.replace", slot)).toHaveLength(12)
  const prompt = instance.prompt({ ...slot, text: "p", lines: ["p"], cursor: { row: 0, col: 1 } })!
  expect(prompt.lines).toHaveLength(8)
  expect(prompt.cursor).toEqual({ row: 0, col: 1 })
  expect(instance.promptChrome()).toMatchObject({ lead: "λ", preset: "box" })
  expect(instance.widgets("tray", slot)[0]?.title).toBe("Tray")
  expect(instance.widgets("sidebar", slot)[0]?.title).toBe("Side")
  instance.dispose()
  const broken = await runtime(`api.prompt.replace(() => ({lines:[[{text:"x"}]],cursor:{row:999,col:0}})); api.widget("sidebar","bad",{title:"Bad",render:()=>{throw Error("bad widget")}})`)
  for (let index = 0; index < 2; index++) {
    expect(broken.prompt({ ...slot, text: "x", lines: ["x"], cursor: { row: 0, col: 0 } })).toBeUndefined()
    expect(broken.widgets("sidebar", slot)).toHaveLength(0)
  }
  expect(broken.problems).toHaveLength(2)
  broken.dispose()
})

test("settings cover every customize key, stage until success, and cleanup runs for failed setup", async () => {
  let settings: Record<string, unknown> = { ...TUI_DEFAULTS }
  const options = { redraw() {}, settings: { get: (key?: string) => key === undefined ? structuredClone(settings) : settings[key], set: (values: Record<string, unknown>) => { settings = { ...settings, ...values } } } }
  const complete = await runtime(`api.settings.set(${JSON.stringify(TUI_DEFAULTS)}); api.settings.set("username","Look"); if(api.settings.get("username") !== "Look") throw Error("read your writes")`, options)
  expect(complete.problems).toHaveLength(0)
  expect(settings.username).toBe("Look")
  complete.dispose()
  const invalid = await runtime(`api.settings.set(JSON.parse('{"__proto__":{"username":"Wrong"}}'))`, options)
  expect(invalid.problems).toHaveLength(1)
  expect(settings.username).toBe("Look")
  invalid.dispose()
  const marker = globalThis as { __ui10Disposed?: number }
  marker.__ui10Disposed = 0
  const broken = await runtime(`api.settings.set("username","Wrong"); api.onDispose(()=>globalThis.__ui10Disposed++); throw Error("setup failed")`, options)
  expect(settings.username).toBe("Look")
  expect(marker.__ui10Disposed).toBe(1)
  expect(broken.problems).toHaveLength(1)
  delete marker.__ui10Disposed
  broken.dispose()
})

test("app replaces prompt, renders both widget surfaces and persists settings from code", async () => {
  const temp = sandbox()
  temp.write("data/extensions/look.ts", extension("look", `
    api.settings.set({username:"Look",pet:"off",sidebar:"hidden"})
    api.prompt.replace(()=>({lines:[[{text:"PROMPT INPUT"}]],cursor:{row:0,col:2}}))
    api.widget("tray","extra",{title:"Custom tray",render:()=>[[{text:"TRAY BODY"}]]})
    api.widget("sidebar","extra",{title:"Custom sidebar",render:()=>[[{text:"SIDEBAR BODY"}]]})
  `))
  const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, width: 180, height: 50 })
  try {
    await harness.start({ onboarded: true })
    harness.message("question", "answer")
    await harness.key("\x14")
    expect(harness.text()).toContain("PROMPT INPUT")
    expect(harness.text()).toContain("TRAY BODY")
    expect(harness.text()).not.toContain("SIDEBAR BODY")
    await harness.type("/sidebar widget extra\r")
    expect(harness.text()).toContain("SIDEBAR BODY")
    expect(harness.rows()).toHaveLength(50)
    for (const row of harness.rows()) expect(textWidth(row)).toBeLessThanOrEqual(180)
  } finally { await harness.key("\x1b"); await harness.key("\x03"); await harness.key("\x03") }
})

test("hidden sidebar panels are never rendered; explicit selection only renders that panel", async () => {
  const instance = await runtime(`
    api.widget("sidebar", "hidden", {title:"Hidden",render:()=>{throw Error("hidden must not render")}})
    api.widget("sidebar", "shown", {title:"Shown",render:()=>Array.from({length:100},()=>[{text:"row"}])})
  `)
  expect(instance.widgets("sidebar", slot, [])).toEqual([])
  const selected = instance.widgets("sidebar", slot, ["shown"])
  expect(selected).toHaveLength(1)
  expect(selected[0]!.body).toHaveLength(8)
  expect(instance.problems).toHaveLength(0)
  instance.dispose()
})

test("daemon event reloads edited and added modules, disable persists, slash reload and export are routed", async () => {
  const temp = sandbox()
  temp.write("data/extensions/look.ts", extension("look", `api.slot("footer.replace",()=>[[{text:"FIRST"}]])`))
  const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project })
  try {
    await harness.start({ onboarded: true })
    harness.message("question", "answer")
    expect(harness.text()).toContain("FIRST")
    temp.write("data/extensions/look.ts", extension("look", `api.slot("footer.replace",()=>[[{text:"SECOND"}]])`))
    temp.write("data/extensions/new.ts", extension("new", `api.slot("header.replace",()=>[[{text:"NEW HEADER"}]])`))
    harness.app.onGlobal({ type: "extensions.changed", revision: 1, seq: 1, at: 0 } as never)
    await harness.app.extensionsReady
    harness.app.render()
    expect(harness.text()).toContain("SECOND")
    expect(harness.text()).toContain("NEW HEADER")
    await harness.type("/customize\r")
    await harness.key("\r")
    await harness.app.extensionsReady
    await harness.key("\x1b")
    expect(harness.text()).not.toContain("SECOND")
    await harness.type("/extensions reload\r")
    expect(harness.sent.some((command) => command.type === "extensions.reload")).toBe(true)
    await harness.type("/customize\r")
    await harness.key("\x1b[B")
    await harness.key("\r")
    expect(harness.sent.some((command) => command.type === "extensions.export")).toBe(true)
  } finally { await harness.key("\x1b"); await harness.key("\x03"); await harness.key("\x03") }
})

test("bounded extension chrome preserves the input and footer across terminal sizes", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [220, 60]] as const) {
    const temp = sandbox()
    temp.write("data/extensions/look.ts", extension("look", `
      api.settings.set({pet:"off",sidebar:"hidden"})
      api.slot("header.replace",()=>Array.from({length:3},()=>[{text:"HEADER"}]))
      api.slot("footer.replace",()=>Array.from({length:4},(_,index)=>[{text:"FOOTER"+index}]))
      api.slot("prompt.above",()=>Array.from({length:3},()=>[{text:"ABOVE"}]))
      api.slot("prompt.below",()=>Array.from({length:3},()=>[{text:"BELOW"}]))
      api.prompt.replace(()=>({lines:Array.from({length:8},()=>[{text:"INPUT"}]),cursor:{row:0,col:1}}))
      api.widget("tray","extra",{title:"Extra",render:()=>[[{text:"WIDGET"}],[{text:"WIDGET"}]]})
    `))
    const harness = await appHarness({ dataDir: temp.dataDir, directory: temp.project, width, height })
    try {
      await harness.start({ onboarded: true })
      harness.message("question", "answer")
      await harness.key("\x14")
      expect(harness.text()).toContain("INPUT")
      expect(harness.text()).toContain("FOOTER0")
      expect(harness.rows()).toHaveLength(height)
      for (const row of harness.rows()) expect(textWidth(row)).toBeLessThanOrEqual(width)
    } finally { await harness.key("\x1b"); await harness.key("\x03"); await harness.key("\x03") }
  }
})

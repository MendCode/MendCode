import { afterEach, describe, expect, test } from "bun:test"
import { detectReady, type DetectInput } from "../src/view/onboarding-detect"
import { actionText, createOnboardingState, onboardingKey, onboardingRows, PREVIEW_KEY_WIDTH, renderOnboardingPage, STACKED_PREVIEW_HEIGHT, onboardingText, type OnboardingState } from "../src/view/onboarding-page"
import { importValue } from "../src/view/onboarding-import"
import { sampleChat } from "../src/view/onboarding-sample"
import { glyphs, type Line } from "../src/ui/theme"
import { cleanTemps, plain, tempDir } from "./session-ui-harness"
import { readTuiProfile } from "../src/view/tui-profile"
import { modelsFor, onboardingHarness, type Machine } from "./onboarding-harness"

afterEach(cleanTemps)

const detect = (machine: Machine, extra: Partial<DetectInput> = {}) => detectReady({
  selectable: true,
  models: modelsFor(machine) as never,
  providers: (machine.keys ?? []).map((id) => ({ id, enabled: true, hasKey: true, authReady: true })),
  ...(machine.chatgpt ? { login: { ok: true } } : {}),
  ...extra,
})

describe("detection to recommended model", () => {
  test("nothing found: no model, not usable, every missing item says what fixes it", () => {
    const found = detect({}, { login: { ok: false, message: "no login" } })
    expect(found.options).toEqual([])
    expect(found.recommended).toBeUndefined()
    expect(found.usable).toBe(false)
    expect(found.items.filter((item) => item.ok)).toEqual([])
    // Not installed: where to get Claude Code, not a sign-in command for a program that is not there.
    expect(found.items.find((item) => item.id === "claude")?.fix).toBe("claude.com/claude-code")
    expect(found.items.find((item) => item.id === "keys")?.fix).toContain("ANTHROPIC_API_KEY")
  })
  test("Claude Code as its own status reports it: installed is not signed in, and a plan is shown only when it says one", () => {
    const harness = (claude: NonNullable<DetectInput["harnesses"]>[number]) => detect({ claude: true }, { harnesses: [claude] })
    // Before, `claude --version` answering was shown as "installed, signed in" and its models offered.
    const out = harness({ id: "claude", installed: true, signedIn: false, login: "claude auth login" })
    expect(out.items.find((item) => item.id === "claude")).toMatchObject({ ok: false, detail: "installed · not signed in", fix: "claude auth login" })
    expect(out.options.filter((option) => option.source === "claude")).toEqual([])
    expect(out.usable).toBe(false)
    const max = harness({ id: "claude", installed: true, signedIn: true, plan: "max" })
    expect(max.items.find((item) => item.id === "claude")).toMatchObject({ ok: true, detail: "signed in · max plan" })
    expect(max.options[0]).toMatchObject({ source: "claude", line: expect.stringContaining("runs in Claude Code, hosted by MendCode") })
    expect(harness({ id: "claude", installed: true, signedIn: true }).items.find((item) => item.id === "claude")?.detail).toBe("signed in · plan not reported")
    expect(harness({ id: "claude", installed: true }).items.find((item) => item.id === "claude")?.detail).toBe("installed · sign-in not confirmed")
    // Without the daemon's report (an older daemon) a listed Claude Code is never called signed in.
    expect(detect({ claude: true }).items.find((item) => item.id === "claude")?.detail).toBe("installed · sign-in not checked")
  })
  test("ownLogins: a signed-in Codex CLI is only reported, its models are not offered, and ChatGPT asks for MendCode's own login", () => {
    const found = detect({ codex: true }, { ownLogins: true, login: { ok: false, message: "sign in" }, harnesses: [{ id: "codex", installed: true, signedIn: true }] })
    expect(found.items.find((item) => item.id === "codex")).toEqual({ id: "codex", label: "Codex CLI", ok: false, detail: "signed in · its login is not used" })
    expect(found.items.find((item) => item.id === "chatgpt")).toMatchObject({ ok: false, detail: "not signed in for MendCode", fix: "/connect chatgpt" })
    expect(found.options).toEqual([])
    const before = detect({ codex: true }, { harnesses: [{ id: "codex", installed: true, signedIn: true }] })
    expect(before.options.map((option) => option.source)).toEqual(["codex"])
  })
  test("only an API key: that provider's model is recommended and billed per token", () => {
    const found = detect({ keys: ["anthropic"] })
    expect(found.recommended).toBe("anthropic:default")
    expect(found.options[0]?.line).toContain("per token")
    expect(found.items.find((item) => item.id === "keys")).toMatchObject({ ok: true, detail: "ANTHROPIC_API_KEY" })
    expect(found.usable).toBe(true)
  })
  test("Claude Code present: its model is recommended with no per-token charge", () => {
    const found = detect({ claude: true })
    expect(found.recommended).toBe("claude-sonnet")
    expect(found.options[0]).toMatchObject({ source: "claude", recommended: true })
    expect(found.options[0]?.line).toContain("no per-token")
    expect(found.items.find((item) => item.id === "claude")?.ok).toBe(true)
  })
  test("several: the ChatGPT subscription comes first, then Claude Code, Codex, keys, pi", () => {
    const found = detect({ chatgpt: true, claude: true, codex: true, pi: true, keys: ["openai", "anthropic"] })
    expect(found.options.map((option) => option.source)).toEqual(["chatgpt", "chatgpt", "claude", "claude", "codex", "api", "api", "pi"])
    expect(found.recommended).toBe("gpt-5.5")
    expect(found.options.filter((option) => option.source === "api").map((option) => option.id)).toEqual(["anthropic:default", "openai:default"])
  })
  test("a signed-out ChatGPT login is not offered and Claude Code takes over", () => {
    const found = detect({ chatgpt: true, claude: true }, { login: { ok: false } })
    expect(found.options.every((option) => option.source === "claude")).toBe(true)
    expect(found.items.find((item) => item.id === "chatgpt")).toMatchObject({ ok: false, fix: "/connect chatgpt" })
  })
  test("a model already chosen stays the recommendation", () => {
    const found = detect({ chatgpt: true, claude: true }, { selected: "claude-opus" })
    expect(found.recommended).toBe("claude-opus")
    expect(found.options.find((option) => option.id === "claude-opus")?.current).toBe(true)
  })
  test("an engine that picks its own model has nothing to choose and is still usable", () => {
    const found = detect({}, { selectable: false })
    expect(found.options).toEqual([])
    expect(found.usable).toBe(true)
  })
  test("the import row counts what would be taken over and only what is new", () => {
    const found = detect({ claude: true }, { imports: { found: [{ tool: "claude-code" }], items: [{ kind: "mcp", status: "new", tool: "claude-code" }, { kind: "mcp", status: "exists", tool: "claude-code" }, { kind: "command", status: "new", tool: "claude-code" }] } })
    expect(found.importRow).toMatchObject({ tool: "claude-code", mcp: 1, commands: 1, counts: "1 MCP server, 1 command" })
    expect(detect({ claude: true }, { imports: { found: [{ tool: "codex" }], items: [] } }).importRow).toBeUndefined()
  })
})

const state = (extra: Partial<OnboardingState> = {}): OnboardingState => ({ ...createOnboardingState({ current: {}, firstRun: true }), ...extra })
const ctx = (machine: Machine) => ({ detected: detect(machine), firstRun: true })

describe("page keys", () => {
  test("first run starts on the recommendation, balanced and ask; enter returns exactly those choices", () => {
    const { action } = onboardingKey(state(), "\r", ctx({ claude: true }))
    expect(action).toEqual({ type: "finish", choices: { model: "claude-sonnet", tier: "balanced", permission: "ask", imports: [] } })
  })
  test("arrows change the focused row only and enter returns the shown values", () => {
    const c = ctx({ claude: true, keys: ["anthropic"] })
    let s = state()
    s = onboardingKey(s, "\x1b[C", c).state
    expect(s.model).toBe("claude-opus")
    s = onboardingKey(s, "\x1b[B", c).state
    s = onboardingKey(s, "\x1b[C", c).state
    expect(s.tier).toBe("full")
    s = onboardingKey(s, "j", c).state
    s = onboardingKey(s, "\x1b[C", c).state
    s = onboardingKey(s, "\x1b[C", c).state
    s = onboardingKey(s, "\x1b[C", c).state
    expect(s.permission).toBe("plan")
    expect(onboardingKey(s, "\r", c).action).toEqual({ type: "finish", choices: { model: "claude-opus", tier: "full", permission: "plan", imports: [] } })
  })
  test("esc keeps defaults and returns no choices; r asks for a new check", () => {
    expect(onboardingKey(state(), "\x1b", ctx({ claude: true })).action).toEqual({ type: "defaults" })
    expect(onboardingKey(state(), "r", ctx({})).action).toEqual({ type: "recheck" })
  })
  test("a reopened page offers no tier as well and starts on what is saved", () => {
    const reopened = createOnboardingState({ current: { model: "claude-opus", permission: "edits" }, firstRun: false })
    expect(reopened).toMatchObject({ model: "claude-opus", tier: "none", permission: "edits" })
    const c = { detected: detect({ claude: true }), firstRun: false }
    let s = onboardingKey(reopened, "\x1b[B", c).state
    s = onboardingKey(s, "\x1b[C", c).state
    expect(s.tier).toBe("minimalist")
  })
  test("nothing found: enter still continues, with no model", () => {
    expect(onboardingKey(state(), "\r", ctx({})).action).toEqual({ type: "finish", choices: { tier: "balanced", permission: "ask", imports: [] } })
  })
})

const servers = (names: string[], extra: Array<Record<string, unknown>> = []) => ({
  found: [{ tool: "claude-code" }],
  items: [...names.map((name, i) => ({ kind: "mcp", status: "new", tool: i % 2 ? "codex" : "claude-code", scope: "user", name })), ...extra],
  inPlace: ["~/.claude: 2 skills (read where they are)"],
  notImported: ["permission rules and approvals (review them in /permissions)"],
})
const importCtx = (names = ["a", "b", "c", "d"], extra: Array<Record<string, unknown>> = []) => ({ detected: detect({ claude: true }, { imports: servers(names, extra) as never }), firstRun: true })
const keyOf = (name: string, tool = "claude-code") => `mcp:${tool}:user:${name}`
/** The rows are model, tier, permission, import, start: the import row is the fourth. */
const onImport = (): OnboardingState => ({ ...state(), row: 3 })
const press = (s: OnboardingState, c: ReturnType<typeof importCtx>, ...keys: string[]) => keys.reduce((acc, k) => onboardingKey(acc, k, c).state, s)

describe("import choice", () => {
  test("the default is nothing: Enter on another row finishes with no imports", () => {
    const c = importCtx()
    expect(state().imports).toEqual([])
    const { action } = onboardingKey(state(), "\r", c)
    expect(action).toMatchObject({ type: "finish", choices: { imports: [] } })
  })
  test("enter or space on the import row opens the picker instead of finishing, and changes nothing yet", () => {
    const c = importCtx()
    for (const open of ["\r", " "]) {
      const result = onboardingKey(onImport(), open, c)
      expect(result.action).toEqual({ type: "none" })
      expect(result.state.picker).toEqual({ cursor: 0, draft: [] })
      expect(result.state.imports).toEqual([])
    }
  })
  test("left and right on the row switch between nothing and everything", () => {
    const c = importCtx()
    const all = press(onImport(), c, "\x1b[C")
    expect(all.imports).toEqual([keyOf("a"), keyOf("b", "codex"), keyOf("c"), keyOf("d", "codex")])
    expect(press(all, c, "\x1b[D").imports).toEqual([])
  })
  test("space toggles, a selects all, n none, enter keeps the draft and the finish carries exactly it", () => {
    const c = importCtx()
    let s = press(onImport(), c, "\r", " ", "j", "j", " ")
    expect(s.picker?.draft).toEqual([keyOf("a"), keyOf("c")])
    s = press(s, c, "n")
    expect(s.picker?.draft).toEqual([])
    s = press(s, c, "a")
    expect(s.picker?.draft).toHaveLength(4)
    s = press(s, c, "n", "g", "j", " ", "j", "j", " ")
    const kept = onboardingKey(s, "\r", c).state
    expect(kept.picker).toBeUndefined()
    expect(kept.imports).toEqual([keyOf("b", "codex"), keyOf("d", "codex")])
    const finish = onboardingKey({ ...kept, row: 4 }, "\r", c).action
    expect(finish).toMatchObject({ type: "finish", choices: { imports: [keyOf("b", "codex"), keyOf("d", "codex")] } })
  })
  test("esc inside the picker goes back and keeps the previous selection; esc outside is still keep-defaults", () => {
    const c = importCtx()
    const chosen = press(onImport(), c, "\x1b[C")
    const edited = press(chosen, c, "\r", "n", "j", " ")
    expect(edited.picker?.draft).toHaveLength(1)
    const result = onboardingKey(edited, "\x1b", c)
    expect(result.action).toEqual({ type: "none" })
    expect(result.state.picker).toBeUndefined()
    expect(result.state.imports).toEqual(chosen.imports)
    expect(onboardingKey(result.state, "\x1b", c).action).toEqual({ type: "defaults" })
  })
  test("keys in the picker never leak to the page: r does not recheck, j moves inside the list", () => {
    const c = importCtx()
    const open = press(onImport(), c, "\r")
    expect(onboardingKey(open, "r", c).action).toEqual({ type: "none" })
    expect(press(open, c, "j", "j", "j", "j", "j").picker?.cursor).toBe(3)
    expect(press(open, c, "k").picker?.cursor).toBe(0)
  })
  test("the row reads nothing, all of them, or a count; commands and a per-item reason come through", () => {
    const c = importCtx(["a", "b"], [{ kind: "mcp", status: "new", tool: "claude-code", scope: "user", name: "stitch", enabled: false, needs: ["STITCH_KEY"] }, { kind: "command", status: "new", tool: "codex", scope: "user", name: "review" }, { kind: "mcp", status: "exists", tool: "claude-code", scope: "user", name: "kept" }])
    const row = c.detected.importRow!
    expect(row.counts).toBe("3 MCP servers, 1 command")
    expect(row.choices.map((choice) => choice.name)).toEqual(["a", "b", "stitch", "review"])
    expect(row.choices.find((choice) => choice.name === "stitch")?.reason).toBe("needs $STITCH_KEY")
    expect(importValue(row, [])).toBe("nothing")
    expect(importValue(row, [row.choices[0]!.key])).toBe("1 of 4")
    expect(importValue(row, row.choices.map((choice) => choice.key))).toBe("all 3 MCP servers, 1 command")
    expect(importValue(row, ["mcp:claude-code:user:gone"])).toBe("nothing")
  })
  test("the page says what enter does, follows the focused row in the preview title, and lists every server in the picker", () => {
    const c = importCtx(["context7", "stitch"], [{ kind: "mcp", status: "new", tool: "claude-code", scope: "user", name: "lumnos", enabled: false, needs: ["LUMNOS_API_KEY"] }])
    const render = (s: OnboardingState, width = 120, height = 40) => words(renderOnboardingPage({ state: s, detected: c.detected, firstRun: true, loading: false, width, height, glyphs: g, now: 1_800_000_000_000 }).map(plain))
    const first = render(state())
    expect(actionText({ state: state(), detected: c.detected, firstRun: true, loading: false, width: 120, height: 40, now: 0 }, false).text).toBe("enter  start chatting · Sonnet · balanced · ask · imports nothing")
    expect(first).toContain("start chatting · Sonnet")
    expect(first).toContain("imports nothing")
    expect(first).toContain("Import      ‹ nothing ›")
    expect(first).toContain("Preview · model: Sonnet")
    expect(render({ ...state(), permission: "full", row: 2 })).toContain("Preview · permission: full")
    expect(render({ ...state(), tier: "full", row: 1 })).toContain("Preview · tier: full")
    expect(render(onImport())).toContain("Preview · sample session")
    const picking = render(press(onImport(), c, "\r", " ", "j", "j", " "))
    expect(picking).toContain("Import · 2 of 3 selected")
    expect(picking).toContain("[x] context7")
    expect(picking).toContain("[ ] stitch")
    expect(picking).toContain("[x] lumnos")
    expect(picking).toContain("needs $LUMNOS_API_KEY")
    expect(picking).toContain("Read where it is")
    expect(picking).toContain("Never imported")
    expect(picking).toContain("space toggle")
    expect(picking).not.toContain("Preview")
    const after = render({ ...press(onImport(), c, "\r", " ", "\r"), row: 3 })
    expect(after).toContain("Import      ‹ 1 of 3 ›")
    expect(after).toContain("imports 1 of 3")
  })
  test("the preview sits directly under its content: no blank run between the sample and its status row", () => {
    const rows = renderOnboardingPage({ state: state(), detected: detect({ claude: true }), firstRun: true, loading: false, width: 200, height: 60, glyphs: g, now: 1_800_000_000_000 }).map(plain)
    const status = rows.findIndex((row) => row.includes("claude-sonnet"))
    expect(status).toBeGreaterThan(0)
    let blank = 0
    for (let i = status - 1; i > 0 && rows[i]!.slice(60).trim() === ""; i--) blank++
    expect(blank).toBeLessThanOrEqual(1)
    expect(rows.slice(status + 2).every((row) => row.slice(60).trim() === "")).toBe(true)
  })
  test("the Look row exists only when the page knows the theme, moves live and is part of the finish", () => {
    const withLook = { ...state(), look: "mend" }
    const themed = { detected: detect({ claude: true }), firstRun: true, themes: ["system", "mend", "paper"] }
    const rows = onboardingRows(themed.detected, withLook)
    expect(rows).toEqual(["model", "tier", "permission", "look", "start"])
    expect(onboardingRows(themed.detected, state())).toEqual(["model", "tier", "permission", "start"])
    const moved = onboardingKey({ ...withLook, row: 3 }, "\x1b[C", themed)
    expect(moved.action).toEqual({ type: "look", theme: "paper" })
    expect(moved.state.look).toBe("paper")
    expect(onboardingKey(moved.state, "\r", themed).action).toMatchObject({ type: "finish", choices: { theme: "paper" } })
  })
})

const g = glyphs({})
const frame = (s: OnboardingState, machine: Machine, width = 100, height = 30): string[] => renderOnboardingPage({ state: s, detected: detect(machine), firstRun: true, loading: false, width, height, glyphs: g, now: 1_800_000_000_000 }).map(plain)
const words = (rows: string[]) => rows.join("\n")

describe("live previews", () => {
  const machine: Machine = { claude: true, importable: undefined }
  test("the chat preview changes with the tier and uses the real transcript", () => {
    const chats = (["minimalist", "balanced", "full"] as const).map((tier) => sampleChat({ tier, width: 60, glyphs: g, now: 0 }).map(plain).join("\n"))
    // The full view's default density is calm: with two tool calls, the finished read is one row and the latest edit a short
    // preview, which is what balanced draws too. The chat of the minimalist tier is the one that differs; the whole frames below differ per tier.
    expect(new Set(chats).size).toBe(2)
    expect(chats[2]).toBe(chats[1])
    for (const text of chats) expect(text).toContain("Fix the total in src/cart.ts")
    expect(chats[1]).toContain("Edit src/cart.ts")
    expect(chats[0]).not.toContain("@@")
    expect(chats[2]).toContain("return items.length")
    const shown = (["minimalist", "balanced", "full"] as const).map((tier) => words(frame(state({ tier }), machine)))
    expect(new Set(shown).size).toBe(3)
  })
  test("the approval card changes with the permission mode", () => {
    expect(words(frame(state({ permission: "ask" }), machine))).toContain("Allow once")
    expect(words(frame(state({ permission: "edits" }), machine))).toContain("Allow once")
    const full = words(frame(state({ permission: "full" }), machine))
    expect(full).not.toContain("Allow once")
    expect(full).toContain("bun test")
    expect(words(frame(state({ permission: "plan" }), machine))).toContain("Review plan")
  })
  test("the footer shows the chosen model", () => {
    const rows = words(frame(state({ model: "claude-opus" }), machine))
    expect(rows).toContain("claude-opus")
    expect(rows).not.toContain("claude-sonnet")
  })
  test("the tier row says what it costs in context", () => {
    const rows = words(frame({ ...state({ tier: "full" }), row: 1 }, machine))
    expect(rows).toContain("6.4k tokens")
  })
  test("a small screen previews only the focused part, still a full frame", () => {
    const small = frame({ ...state(), row: 2 }, machine, 80, 24)
    expect(small).toHaveLength(24)
    expect(words(small)).toContain("Allow once")
    expect(words(frame({ ...state(), row: 1 }, machine, 80, 24))).toContain("Edit src/cart.ts")
  })
})

describe("layouts", () => {
  test("every size draws exactly its rectangle and keeps Ready, Choose and Preview (a key away under 60 columns)", () => {
    for (const [width, height] of [[60, 20], [80, 24], [100, 30], [200, 60], [40, 16]] as const) {
      const rows = frame(state(), { claude: true, keys: ["anthropic"] }, width, height)
      expect(rows).toHaveLength(height)
      for (const row of rows) expect([...row].length).toBeLessThanOrEqual(width)
      const text = words(rows)
      expect(text).toContain("Ready")
      expect(text).toContain("Choose")
      expect(text).toContain("start chatting")
      if (width < PREVIEW_KEY_WIDTH || width < 72 && height < STACKED_PREVIEW_HEIGHT) {
        expect(text).toContain("p preview")
        expect(words(frame({ ...state(), preview: true }, { claude: true, keys: ["anthropic"] }, width, height))).toContain("Preview")
      } else expect(text).toContain("Preview")
    }
  })
  test("no width cuts the subtitle or the hints mid-word: each says less instead", () => {
    for (const width of [40, 60, 80, 100, 160]) {
      const rows = frame(state(), { claude: true }, width, 30)
      expect(rows[0]).not.toContain("esc back")
      expect(["welcome · all optional · nothing is saved until you start chatting", "all optional · nothing is saved until you start chatting", "all optional · saved when you start"]).toContain(rows[1]!.trim())
    }
  })
  const styled = (extra: Partial<OnboardingState> = {}) => state({ look: "mend", glyphs: "auto", style: { tools: "default", diffView: "unified", promptChrome: "top-bottom", pet: "off" }, ...extra })
  test("a scrolled list keeps the focused row's whole note", () => {
    // The left column alone (the preview sits beside it at 80 columns), read as one line.
    const left = frame(styled({ row: 7, style: { tools: "default", diffView: "unified", promptChrome: "box", pet: "off" } }), { claude: true }, 80, 24).map((row) => row.slice(0, 36)).join(" ").replace(/\s+/g, " ")
    expect(left).toContain("❯ Prompt")
    expect(left).toContain("a rounded frame around the prompt")
  })
  test("the Enter line stays on screen when the choices scroll", () => {
    const rows = frame(styled({ row: 8 }), { claude: true }, 80, 22)
    expect(words(rows)).toContain("enter  start chatting")
    expect(words(rows)).toContain("❯ Pet")
  })
  test("under 60 columns p swaps the choices for the preview of the focused row, and esc comes back without leaving", () => {
    const c = ctx({ claude: true })
    const shown = onboardingKey(styled({ row: 6 }), "p", c)
    expect(shown.state.preview).toBe(true)
    const rows = words(frame(shown.state, { claude: true }, 50, 30))
    expect(rows).toContain("Preview · diff: unified")
    expect(rows).toContain("Unified")
    expect(rows).not.toContain("Choose")
    const back = onboardingKey(shown.state, "\x1b", c)
    expect(back.action).toEqual({ type: "none" })
    expect(back.state.preview).toBe(false)
  })
  test("the Diff row's note and sample split by the chat's width, not the preview's", () => {
    // The note wraps under its row: read the page as one line.
    const rows = (chatWidth: number) => renderOnboardingPage({ state: styled({ row: 6, style: { tools: "default", diffView: "split", promptChrome: "top-bottom", pet: "off" } }), detected: detect({ claude: true }), firstRun: true, loading: false, width: 160, height: 40, glyphs: g, now: 0, chatWidth }).map(plain)
    const at = (chatWidth: number) => rows(chatWidth).join(" ").replace(/ +/g, " ")
    const facing = (chatWidth: number) => rows(chatWidth).some((row) => row.includes("return items.length") && row.includes("items.reduce"))
    expect(at(150)).toContain("Side by side: the chat is 150 columns")
    expect(facing(150)).toBe(true)
    expect(at(90)).toContain("Unified here: split needs 100 chat columns")
    expect(facing(90)).toBe(false)
  })
  test("Mend stands on the sample prompt when the Pet row says so", () => {
    const pet = (value: string) => frame(styled({ row: 8, style: { tools: "default", diffView: "unified", promptChrome: "top-bottom", pet: value } }), { claude: true }, 160, 40)
    expect(words(pet("mend"))).not.toBe(words(pet("off")))
    expect(words(pet("mend"))).toContain("Mend stands on the prompt")
  })
  test("narrow widths stack the panels", () => {
    expect(frame(state(), { claude: true }, 60, 24).join("\n")).toContain("p preview")
    const rows = frame(state(), { claude: true }, 60, 34)
    const ready = rows.findIndex((row) => row.includes("Ready"))
    const choose = rows.findIndex((row) => row.includes("Choose"))
    const preview = rows.findIndex((row) => row.includes("Preview"))
    expect(ready).toBeLessThan(choose)
    expect(choose).toBeLessThan(preview)
  })
  test("screen-reader mode is linear text: one sentence per fact, no panel rules", () => {
    const detected = detect({ claude: true })
    const rows = renderOnboardingPage({ state: state(), detected, firstRun: true, loading: false, accessible: true, width: 80, height: 24, glyphs: g, now: 0 }).map(plain)
    expect(words(rows)).toContain("Found: Claude Code")
    expect(words(rows)).toContain("Permission: ask")
    expect(words(rows)).not.toMatch(/[─┃│]/)
    expect(onboardingText({ state: state(), detected, firstRun: true, loading: false, width: 80, height: 24, now: 0 }).some((line) => line.startsWith("Tier: balanced"))).toBe(true)
  })
})

const writes = (h: ReturnType<typeof onboardingHarness>) => h.sentOf("settings.set").map((c) => (c as unknown as { patch: Record<string, unknown> }).patch)
const mutating = (h: ReturnType<typeof onboardingHarness>) => h.sent.filter((c) => /\.(set|apply|add|remove|write)$/.test(c.type) || c.type === "prompt.set").map((c) => c.type)

describe("the wizard in the app", () => {
  test("first run detects with read-only queries and writes nothing until a choice is finished", async () => {
    const h = onboardingHarness({ claude: true, keys: ["anthropic"], importable: { mcp: 3, commands: 2 } }, { width: 100, height: 30 })
    await h.app.openSetupIfFirstRun({})
    const types = h.sent.map((c) => c.type)
    for (const type of ["models.list", "providers.list", "daemon.info", "setup.import"]) expect(types).toContain(type)
    expect(mutating(h)).toEqual([])
    const text = h.text().join("\n")
    expect(text).toContain("Claude Code")
    expect(text).toContain("Import      ‹ nothing ›")
    expect(h.sentOf("setup.import")[0]).not.toHaveProperty("apply")
  })
  test("enter writes exactly the three choices shown and offers the tour once", async () => {
    const h = onboardingHarness({ claude: true })
    await h.app.openSetupIfFirstRun({})
    await h.app.onKey("\x1b[C")
    await h.app.onKey("j")
    await h.app.onKey("\x1b[C")
    await h.app.onKey("j")
    await h.app.onKey("\x1b[C")
    await h.app.onKey("\r")
    await Bun.sleep(5)
    const patches = writes(h)
    expect(patches[0]).toEqual({ onboarded: true, defaultPermission: "edits", models: { main: { model: "claude-opus" } } })
    expect(patches.some((patch) => patch.tier === "full" && patch.view === "full")).toBe(true)
    expect(h.app.page).toBe("chat")
    h.app.render()
    expect(h.text().join("\n")).toContain("/tutorial")
  })
  test("enter on the first screen starts chatting with the recommendation", async () => {
    const h = onboardingHarness({ claude: true })
    await h.app.openSetupIfFirstRun({})
    await h.app.onKey("\r")
    await Bun.sleep(5)
    expect(writes(h)[0]).toEqual({ onboarded: true, defaultPermission: "ask", models: { main: { model: "claude-sonnet" } } })
    expect(h.sentOf("settings.set").some((c) => (c as unknown as { patch: Record<string, unknown> }).patch.tier === "balanced")).toBe(true)
  })
  test("esc at any point leaves working defaults: only the done flag is written", async () => {
    const h = onboardingHarness({ claude: true })
    await h.app.openSetupIfFirstRun({})
    await h.app.onKey("j")
    await h.app.onKey("\x1b[C")
    await h.app.onKey("\x1b")
    await Bun.sleep(5)
    expect(writes(h)).toEqual([{ onboarded: true }])
    expect(h.app.page).toBe("chat")
    expect(h.sentOf("prompt.set")).toEqual([])
  })
  test("esc while the page still says checking… does not mark the first run done (seen live on a clean nightly .6 install)", async () => {
    let answer: (value: never) => void = () => {}
    const pending = new Promise<never>((resolve) => { answer = resolve })
    const h = onboardingHarness({ claude: true }, { reply: (command) => command.type === "daemon.info" ? pending : undefined })
    const opened = h.app.openSetupIfFirstRun({})
    await Bun.sleep(10)
    expect(h.app.page).toBe("setup")
    await h.app.onKey("\x1b")
    await Bun.sleep(5)
    expect(writes(h).filter((patch) => "onboarded" in patch)).toEqual([])
    answer({ ok: true, result: { engine: "native", dataDir: "/d", pid: 1 } } as never)
    await opened
  })
  test("/setup reopens it with the saved values and enter changes nothing by itself", async () => {
    const h = onboardingHarness({ claude: true })
    h.app.applySettings({ onboarded: true, tier: "full", defaultPermission: "edits", models: { main: { model: "claude-opus" } } })
    await h.type("/setup\r")
    await Bun.sleep(5)
    h.app.render()
    const text = h.text().join("\n")
    expect(text).not.toContain("welcome")
    expect(text).toContain("Opus")
    expect(text).toContain("full")
    expect(text).toContain("edits")
    const before = h.sent.length
    await h.app.onKey("\r")
    await Bun.sleep(5)
    expect(h.sent.slice(before).filter((c) => c.type === "settings.set" || c.type === "prompt.set")).toEqual([])
  })
  test("/setup advanced keeps the long page", async () => {
    const h = onboardingHarness({ claude: true })
    h.app.applySettings({ onboarded: true })
    await h.type("/setup advanced\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("recipe")
  })
  test("nothing found: Ready names the fix and r checks again", async () => {
    let claude = false
    const h = onboardingHarness({}, { reply: (command) => (command.type === "models.list" && claude ? { ok: true, result: { engine: "native", selectable: true, models: modelsFor({ claude: true }), defaults: { model: "claude-sonnet" }, roles: {} } } as never : undefined) })
    await h.app.openSetupIfFirstRun({})
    expect(h.text().join("\n")).toContain("claude.com/claude-code")
    claude = true
    await h.app.onKey("r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("Sonnet")
  })
  test("nothing usable: esc or enter does not end the first run, so the next launch opens setup again instead of a chat no model answers", async () => {
    for (const key of ["\x1b", "\r"]) {
      const h = onboardingHarness({})
      await h.app.openSetupIfFirstRun({})
      await h.app.onKey(key)
      await Bun.sleep(5)
      expect(writes(h).filter((patch) => "onboarded" in patch)).toEqual([])
      h.app.render()
      expect(h.text().join("\n")).toContain("no model is set up yet · this setup opens again next")
    }
  })
  test("the minimalist preset with nothing found opens the page instead of configuring a prompt with no model", async () => {
    const h = onboardingHarness({})
    await h.app.openSetupIfFirstRun({}, "minimalist")
    await Bun.sleep(5)
    expect(h.app.page).toBe("setup")
    expect(writes(h).filter((patch) => "onboarded" in patch)).toEqual([])
  })
  test("a new install signs in for itself (ownLogins); an install with a used session or a chosen model keeps its logins", async () => {
    const sessions = (count: number) => (command: { type: string }) => command.type === "session.list" ? { ok: true, result: { sessions: Array.from({ length: count }, (_, i) => ({ id: `ses_${i}` })) } } as never : undefined
    const fresh = onboardingHarness({ claude: true }, { reply: sessions(0) })
    await fresh.app.openSetupIfFirstRun({})
    expect(writes(fresh)[0]).toEqual({ ownLogins: true })
    expect(fresh.sentOf("session.list")[0]).toMatchObject({ hideEmpty: true })
    const used = onboardingHarness({ claude: true }, { reply: sessions(1) })
    await used.app.openSetupIfFirstRun({})
    expect(writes(used).some((patch) => "ownLogins" in patch)).toBe(false)
    const chosen = onboardingHarness({ claude: true }, { reply: sessions(0) })
    await chosen.app.openSetupIfFirstRun({ models: { main: { model: "claude-opus" } } })
    expect(writes(chosen).some((patch) => "ownLogins" in patch)).toBe(false)
    // An upgrade: setup already done, nothing runs at all.
    const done = onboardingHarness({ claude: true }, { reply: sessions(0) })
    await done.app.openSetupIfFirstRun({ onboarded: true })
    expect(done.sentOf("session.list")).toEqual([])
    expect(writes(done)).toEqual([])
  })
  const applied = (h: ReturnType<typeof onboardingHarness>) => h.sentOf("setup.import").filter((c) => (c as unknown as { apply?: boolean }).apply)
  const keys = async (h: ReturnType<typeof onboardingHarness>, ...list: string[]) => { for (const k of list) await h.app.onKey(k); await Bun.sleep(5); h.app.render() }
  /** Down past the last row (the Enter line) and one up: the Import row, however many Look rows sit above it. */
  const IMPORT_ROW = [...Array.from({ length: 20 }, () => "j"), "k"]
  test("import is a row of the page, never a detour: enter on it opens the picker in the same screen", async () => {
    const h = onboardingHarness({ claude: true, importable: { mcp: 3, commands: 0 } }, { width: 120, height: 40 })
    await h.app.openSetupIfFirstRun({})
    await keys(h, ...IMPORT_ROW)
    expect(h.text().join("\n")).toContain("Import      ‹ nothing ›")
    await keys(h, "\r")
    expect(h.app.page).toBe("setup")
    const text = h.text().join("\n")
    expect(text).toContain("Import · 0 of 3 selected")
    expect(text).toContain("[ ] server-1")
    expect(text).toContain("Setup")
    expect(h.sentOf("setup.import")).toHaveLength(1)
    expect(applied(h)).toEqual([])
  })
  test("starting chatting with the default imports nothing: no apply is ever sent", async () => {
    const h = onboardingHarness({ claude: true, importable: { mcp: 13, commands: 0 } })
    await h.app.openSetupIfFirstRun({})
    await keys(h, "\r")
    expect(h.app.page).toBe("chat")
    expect(h.sentOf("setup.import").every((c) => !(c as unknown as { apply?: boolean }).apply)).toBe(true)
    expect(applied(h)).toEqual([])
  })
  test("picking 2 of 13 and starting chatting asks for exactly those 2", async () => {
    const h = onboardingHarness({ claude: true, importable: { mcp: 13, commands: 0 } })
    await h.app.openSetupIfFirstRun({})
    await keys(h, ...IMPORT_ROW, "\r", " ", "j", "j", " ", "\r")
    expect(h.app.page).toBe("setup")
    expect(h.text().join("\n")).toContain("Import      ‹ 2 of 13 ›")
    expect(h.text().join("\n")).toContain("imports 2 of 13")
    expect(applied(h)).toEqual([])
    await keys(h, "j", "\r")
    expect(h.app.page).toBe("chat")
    expect(applied(h)).toHaveLength(1)
    expect(applied(h)[0]).toMatchObject({ type: "setup.import", apply: true, only: ["mcp:claude-code:user:server-1", "mcp:claude-code:user:server-3"] })
  })
  test("esc inside the picker keeps the previous selection and stays on the page; esc outside keeps defaults and imports nothing", async () => {
    const h = onboardingHarness({ claude: true, importable: { mcp: 3, commands: 0 } })
    await h.app.openSetupIfFirstRun({})
    await keys(h, ...IMPORT_ROW, "\x1b[C")
    expect(h.text().join("\n")).toContain("Import      ‹ all 3 MCP servers ›")
    await keys(h, "\r", "n", "\x1b")
    expect(h.app.page).toBe("setup")
    expect(h.text().join("\n")).toContain("Import      ‹ all 3 MCP servers ›")
    await keys(h, "\x1b")
    await Bun.sleep(5)
    expect(h.app.page).toBe("chat")
    expect(writes(h)).toEqual([{ onboarded: true }])
    expect(applied(h)).toEqual([])
  })
  test("the setup pages never draw the agent/model bar of the session", async () => {
    const h = onboardingHarness({ claude: true, importable: { mcp: 3, commands: 0 } }, { width: 120, height: 40 })
    await h.app.openSetupIfFirstRun({})
    await keys(h, ...IMPORT_ROW, "\r")
    expect(h.text().join("\n")).not.toMatch(/Build\s+·/)
  })
  test("the Look row repaints in the theme at once, esc puts the first one back and enter saves the new one", async () => {
    const { activeTheme, setTheme } = await import("../src/ui/theme")
    try {
      setTheme("mend")
      const first = activeTheme().name
      const escaped = onboardingHarness({ claude: true })
      await escaped.app.openSetupIfFirstRun({})
      await keys(escaped, "j", "j", "j", "\x1b[C")
      expect(activeTheme().name).not.toBe(first)
      await keys(escaped, "\x1b")
      expect(activeTheme().name).toBe(first)
      expect(writes(escaped)).toEqual([{ onboarded: true }])
      const kept = onboardingHarness({ claude: true })
      await kept.app.openSetupIfFirstRun({})
      await keys(kept, "j", "j", "j", "\x1b[C", "\r")
      const chosen = activeTheme().name
      expect(chosen).not.toBe(first)
      expect(writes(kept)[0]).toMatchObject({ onboarded: true, theme: chosen })
    } finally { setTheme("mend") }
  })
  test("the Glyphs row redraws the whole screen in the set at once, esc puts the first one back and enter saves it to the profile", async () => {
    const { setGlyphMode } = await import("../src/ui/theme")
    try {
      const [escapedDir, keptDir] = [tempDir(), tempDir()]
      const escaped = onboardingHarness({ claude: true }, { dataDir: escapedDir })
      await escaped.app.openSetupIfFirstRun({})
      await keys(escaped, "j", "j", "j", "j", "\x1b[C")
      const shown = escaped.text().join("\n")
      expect(shown).toContain("Glyphs      < ascii >")
      expect(shown).not.toMatch(/[^\x00-\x7e]/)
      await keys(escaped, "\x1b")
      expect(escaped.text().join("\n")).toMatch(/[^\x00-\x7e]/)
      expect(readTuiProfile(escapedDir).glyphs).toBe("auto")
      expect(writes(escaped)).toEqual([{ onboarded: true }])
      const kept = onboardingHarness({ claude: true }, { dataDir: keptDir })
      await kept.app.openSetupIfFirstRun({})
      await keys(kept, "j", "j", "j", "j", "\x1b[C", "\x1b[C", "\r")
      expect(readTuiProfile(keptDir).glyphs).toBe("unicode")
    } finally { setGlyphMode("unicode") }
  })
  test("the Tools, Diff, Prompt and Pet rows redraw the preview at once, esc puts every key back and enter saves what moved", async () => {
    const [escapedDir, keptDir] = [tempDir(), tempDir()]
    const escaped = onboardingHarness({ claude: true }, { dataDir: escapedDir, width: 120, height: 40 })
    await escaped.app.openSetupIfFirstRun({})
    await keys(escaped, "j", "j", "j", "j", "j", "\x1b[C")
    expect(escaped.text().join("\n")).toContain("Tools       ‹ detailed ›")
    expect(escaped.text().join("\n")).toContain("Preview · tools: detailed")
    await keys(escaped, "j", "j", "\x1b[C")
    expect(escaped.text().join("\n")).toContain("Prompt      ‹ minimal ›")
    await keys(escaped, "\x1b")
    expect(escaped.app.page).toBe("chat")
    expect(readTuiProfile(escapedDir)).toMatchObject({ toolDensity: "calm", codeMapCard: "auto", promptChrome: "top-bottom" })
    expect(writes(escaped)).toEqual([{ onboarded: true }])
    const kept = onboardingHarness({ claude: true }, { dataDir: keptDir, width: 120, height: 40 })
    await kept.app.openSetupIfFirstRun({})
    await keys(kept, "j", "j", "j", "j", "j", "\x1b[C", "j", "\x1b[C", "j", "j", "\x1b[C", "\r")
    expect(kept.app.page).toBe("chat")
    expect(readTuiProfile(keptDir)).toMatchObject({ toolDensity: "standard", codeMapCard: "open", diffView: "split", promptChrome: "top-bottom", pet: "mend" })
  })
})

void (null as unknown as Line)

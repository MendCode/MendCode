import { afterEach, describe, expect, test } from "bun:test"
import { detectReady, type DetectInput } from "../src/view/onboarding-detect"
import { createOnboardingState, onboardingKey, onboardingText, renderOnboardingPage, type OnboardingState } from "../src/view/onboarding-page"
import { glyphs } from "../src/ui/theme"
import { cleanTemps, plain } from "./session-ui-harness"
import { onboardingHarness } from "./onboarding-harness"

afterEach(cleanTemps)

/** Claude Code's catalog as a native daemon lists it once `claude` answers (`CLAUDE_MODELS`, sorted by id as `models.list` returns them). */
const CLAUDE = ["fable", "haiku", "opus", "sonnet"].map((family) => ({ id: `claude-${family}`, name: `Claude ${family[0]!.toUpperCase()}${family.slice(1)} · Claude Code`, engine: "claude", efforts: [] }))
/** The ChatGPT subscription's own list, as the subscription backend answers it once MendCode is signed in. */
const CHATGPT = [["gpt-6.1-terra", "GPT-6.1-Terra"], ["gpt-6.1-astra", "GPT-6.1-Astra"], ["gpt-6-luna", "GPT-6-Luna"], ["gpt-6.1-sol", "GPT-6.1-Sol"]].map(([id, name]) => ({ id: id!, name: name!, efforts: [] }))
/** Before that sign-in the native catalog holds only the engine default. */
const FALLBACK = [{ id: "gpt-6-luna", name: "gpt-6-luna", efforts: [] }]
/** The Codex harness's entries, which a native daemon lists once its thread bridge is on (`/tier thread_mcp on codex`). */
const CODEX = CHATGPT.map((model) => ({ ...model, id: `codex:${model.id}`, name: `${model.name} · Codex`, engine: "codex" }))
/** A new install as the user had it: Claude Code and Codex installed and signed in, MendCode not yet signed in to ChatGPT, no key. */
const harnesses: NonNullable<DetectInput["harnesses"]> = [{ id: "claude", installed: true, signedIn: true, plan: "max" }, { id: "codex", installed: true, signedIn: true }]
const fresh: DetectInput = { selectable: true, models: [...FALLBACK, ...CLAUDE], providers: [], login: { ok: false, message: "sign in" }, harnesses, ownLogins: true }

const ids = (input: DetectInput, source: string) => detectReady(input).options.filter((option) => option.source === source).map((option) => option.id)
const state = (extra: Partial<OnboardingState> = {}): OnboardingState => ({ ...createOnboardingState({ current: {}, firstRun: true }), ...extra })
const g = glyphs({})
const page = (s: OnboardingState, input: DetectInput, width = 120, height = 40) => renderOnboardingPage({ state: s, detected: detectReady(input), firstRun: true, loading: false, width, height, glyphs: g, now: 0 }).map(plain)

describe("the model step lists every model found", () => {
  test("Claude Code signed in: Fable, Haiku, Opus and Sonnet are all offered, not the first two", () => {
    expect(ids(fresh, "claude")).toEqual(["claude-fable", "claude-haiku", "claude-opus", "claude-sonnet"])
    expect(detectReady(fresh).options.map((option) => option.name)).toEqual(["Fable", "Haiku", "Opus", "Sonnet"])
  })
  test("ChatGPT connected: every model of the subscription is offered, first, under MendCode's own engine", () => {
    const found = detectReady({ ...fresh, models: [...CHATGPT, ...CLAUDE], login: { ok: true } })
    expect(found.options.map((option) => option.id)).toEqual([...CHATGPT.map((model) => model.id), ...CLAUDE.map((model) => model.id)])
    expect(found.recommended).toBe("gpt-6.1-terra")
    expect(found.groups.map((group) => [group.title, group.native])).toEqual([["ChatGPT subscription", true], ["Claude Code harness", false]])
  })
  test("the Codex harness's models are offered when the catalog lists them, ownLogins or not: it runs on the Codex CLI's own login", () => {
    const withCodex = { ...fresh, models: [...FALLBACK, ...CLAUDE, ...CODEX] }
    expect(ids(withCodex, "codex")).toEqual(CODEX.map((model) => model.id))
    const found = detectReady(withCodex)
    expect(found.options.find((option) => option.id === "codex:gpt-6.1-sol")).toMatchObject({ name: "GPT-6.1-Sol", group: "codex" })
    expect(found.items.find((item) => item.id === "codex")).toMatchObject({ ok: true, detail: "installed · signed in" })
    // Signed out of Codex, its models are not offered and the list says how to sign in.
    const signedOut = detectReady({ ...withCodex, harnesses: [harnesses[0]!, { id: "codex", installed: true, signedIn: false, login: "codex login" }] })
    expect(signedOut.options.filter((option) => option.source === "codex")).toEqual([])
    expect(signedOut.unavailable.find((entry) => entry.source === "codex")?.reason).toBe("not signed in · codex login")
  })
  test("Codex installed but its models not listed: the list says what lists them instead of leaving it out silently", () => {
    expect(detectReady(fresh).unavailable).toEqual([
      { source: "chatgpt", title: "ChatGPT subscription", native: true, reason: "not signed in for MendCode · /connect chatgpt" },
      { source: "api", title: "API-key providers", native: true, reason: "no key yet · /connect saves one" },
      { source: "codex", title: "Codex harness", native: false, reason: "full tier · /tier thread_mcp on codex lists its models" },
    ])
  })
  test("every model of each keyed provider, one group per provider, before the harnesses; a provider without a key lists nothing", () => {
    const models = [...CLAUDE, ...["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5"].map((id) => ({ id: `anthropic:${id}`, name: id, provider: "anthropic", efforts: [] })), ...["gpt-6.1", "gpt-6-mini"].map((id) => ({ id: `openai:${id}`, name: id, provider: "openai", efforts: [] })), { id: "google:gemini-3-pro", name: "gemini-3-pro", provider: "google", efforts: [] }]
    const found = detectReady({ ...fresh, models, providers: [{ id: "openai", enabled: true, hasKey: true }, { id: "anthropic", enabled: true, hasKey: true }, { id: "google", enabled: true, hasKey: false }] })
    expect(found.groups.map((group) => group.title)).toEqual(["Anthropic · API key", "OpenAI · API key", "Claude Code harness"])
    expect(found.options.filter((option) => option.source === "api").map((option) => option.id)).toEqual(["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5", "anthropic:claude-haiku-5", "openai:gpt-6.1", "openai:gpt-6-mini"])
    // The recommendation still prefers a subscription harness over a per-token key.
    expect(found.recommended).toBe("claude-fable")
  })
  test("pi and ACP agents are harnesses of their own, never read as the ChatGPT subscription", () => {
    const models = [...FALLBACK, { id: "pi:default", name: "pi", engine: "pi", efforts: [] }, { id: "acp:opencode", name: "OpenCode harness", efforts: [] }, { id: "acp:opencode/opencode/big-pickle", name: "Big Pickle · OpenCode harness", efforts: [] }]
    const found = detectReady({ ...fresh, models })
    expect(found.groups.map((group) => [group.key, group.title])).toEqual([["pi", "pi harness"], ["acp:opencode", "OpenCode harness · ACP"]])
    expect(found.options.map((option) => [option.id, option.source])).toEqual([["pi:default", "pi"], ["acp:opencode", "acp"], ["acp:opencode/opencode/big-pickle", "acp"]])
  })
})

describe("the model list on the page", () => {
  const all = { ...fresh, models: [...FALLBACK, ...CLAUDE, ...CODEX] }
  test("the Model row names who runs it and offers the whole list; left and right step through every model", () => {
    const rows = page(state(), all).join("\n")
    expect(rows).toContain("Model       ‹ Fable · Claude Code ›")
    expect(rows).toContain("space lists all 8 from 2 sources")
    const c = { detected: detectReady(all), firstRun: true }
    let s = state()
    const seen: string[] = []
    for (let i = 0; i < 8; i++) { s = onboardingKey(s, "\x1b[C", c).state; seen.push(s.model!) }
    expect(new Set(seen).size).toBe(8)
  })
  test("space opens the list grouped by engine, enter picks a model and comes back, esc changes nothing", () => {
    const c = { detected: detectReady(all), firstRun: true }
    const open = onboardingKey(state(), " ", c).state
    expect(open.models).toBeDefined()
    const text = page(open, all).join("\n")
    for (const part of ["Model · 8 models found", "MendCode's own engine", "+ Sign in to ChatGPT · /connect chatgpt  not signed in for MendCode", "+ Add an API-key provider · /connect  no key yet","External harnesses · their own login", "Claude Code harness  4", "Codex harness  4", "Haiku", "Sonnet", "GPT-6.1-Terra", "GPT-6.1-Sol"]) expect(text).toContain(part)
    expect(text.indexOf("MendCode's own engine")).toBeLessThan(text.indexOf("Claude Code harness"))
    expect(text.indexOf("Claude Code harness")).toBeLessThan(text.indexOf("Codex harness"))
    // The focus starts on the chosen model; down twice is Opus.
    const moved = ["j", "j"].reduce((acc, key) => onboardingKey(acc, key, c).state, open)
    const picked = onboardingKey(moved, "\r", c)
    expect(picked.action).toEqual({ type: "none" })
    expect(picked.state.models).toBeUndefined()
    expect(picked.state.model).toBe("claude-opus")
    expect(onboardingKey(picked.state, "\r", c).action).toMatchObject({ type: "finish", choices: { model: "claude-opus" } })
    const back = onboardingKey(moved, "\x1b", c).state
    expect(back.models).toBeUndefined()
    expect(back.model).toBeUndefined()
  })
  test("enter on a sign-in row of the list runs that /connect and keeps the list open for the return", () => {
    const c = { detected: detectReady(fresh), firstRun: true }
    const open = onboardingKey(state(), " ", c).state
    // The sign-ins stand above the harnesses: up from the chosen Fable is API keys, then ChatGPT.
    const up = onboardingKey(open, "k", c).state
    expect(up.models?.focus).toBe("connect:")
    const keys = onboardingKey(up, "\r", c)
    expect(keys.action).toEqual({ type: "connect", target: "" })
    expect(keys.state.models).toBeDefined()
    const chatgpt = onboardingKey(up, "k", c)
    expect(chatgpt.state.models?.focus).toBe("connect:chatgpt")
    expect(onboardingKey(chatgpt.state, "\r", c).action).toEqual({ type: "connect", target: "chatgpt" })
    expect(onboardingKey(open, "r", c).action).toEqual({ type: "recheck" })
  })
  test("every size draws the list in its rectangle, and screen-reader mode reads it as sentences", () => {
    const c = { detected: detectReady(all), firstRun: true }
    const open = onboardingKey(state(), " ", c).state
    for (const [width, height] of [[80, 24], [60, 20], [190, 55]] as const) {
      const rows = page(open, all, width, height)
      expect(rows).toHaveLength(height)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width)
      expect(rows.join("\n")).toContain("Model · 8 models found")
    }
    const text = onboardingText({ state: open, detected: c.detected, firstRun: true, loading: false, width: 80, height: 24, now: 0 }).join("\n")
    expect(text).toContain("Model list, 8 models found.")
    expect(text).toContain("Focused. Fable, chosen, recommended.")
    expect(text).toContain("Sign in to ChatGPT · /connect chatgpt, not signed in for MendCode.")
    const unlisted = detectReady(fresh)
    expect(onboardingText({ state: onboardingKey(state(), " ", { detected: unlisted, firstRun: true }).state, detected: unlisted, firstRun: true, loading: false, width: 80, height: 24, now: 0 }).join("\n")).toContain("Not available: Codex harness, full tier · /tier thread_mcp on codex lists its models.")
  })
})

describe("the setup in the app", () => {
  test("connecting ChatGPT from the model list comes back to it, and it then lists every subscription model, focused on the first", async () => {
    let signedIn = false
    const info = { engine: "native", model: "gpt-6-luna", dataDir: "/tmp/mendcode-demo", pid: 7, buildId: "deadbeefcafe", ownLogins: true, harnesses }
    const authorized = { provider: "chatgpt", state: "authorized", source: "v2", accessTokenPresent: true, refreshTokenPresent: true, accountIdPresent: true }
    const h = onboardingHarness({}, { width: 120, height: 40, reply: (command) => {
      if (command.type === "daemon.info") return { ok: true, result: { ...info, login: { ok: signedIn } } } as never
      if (command.type === "providers.auth.status") return { ok: true, result: { statuses: [authorized] } } as never
      if (command.type === "models.list") return { ok: true, result: { engine: "native", selectable: true, models: [...(signedIn ? CHATGPT : FALLBACK), ...CLAUDE], defaults: { model: "gpt-6-luna" }, roles: {} } } as never
      return undefined
    } })
    await h.app.openSetupIfFirstRun({})
    await h.app.onKey(" ")
    h.app.render()
    expect(h.text().join("\n")).toContain("Model · 4 models found")
    // The list opens on the chosen Fable; the sign-ins stand above it: up is API keys, up again ChatGPT.
    await h.app.onKey("k")
    h.app.render()
    expect(h.text().join("\n")).toContain("❯ + Add an API-key provider")
    await h.app.onKey("k")
    await h.app.onKey("\r")
    await Bun.sleep(5)
    expect(h.app.page).toBe("connect")
    signedIn = true
    await h.app.onKey("m")
    await Bun.sleep(5)
    expect(h.app.page).toBe("setup")
    h.app.render()
    const text = h.text().join("\n")
    expect(text).toContain("Model · 8 models found")
    for (const name of ["GPT-6.1-Terra", "GPT-6.1-Astra", "GPT-6-Luna", "GPT-6.1-Sol", "Haiku", "Sonnet"]) expect(text).toContain(name)
    expect(text).not.toContain("Sign in to ChatGPT")
    expect(text).toContain("❯ ✓ GPT-6.1-Terra")
    // Back on the page, the recommendation is now the subscription's first model, and nothing was written on the way.
    await h.app.onKey("\x1b")
    h.app.render()
    expect(h.text().join("\n")).toContain("Model       ‹ GPT-6.1-Terra · ChatGPT ›")
    expect(h.sentOf("settings.set")).toEqual([])
  })
})

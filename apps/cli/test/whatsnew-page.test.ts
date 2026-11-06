import { describe, expect, test } from "bun:test"
import { createWhatsNewState, renderWhatsNewPage, whatsNewCostText, whatsNewKey, type WhatsNewState } from "../src/view/whatsnew-page"

const text = (state: WhatsNewState, width = 90, height = 30) => renderWhatsNewPage({ state, width, height }).map((line) => line.map((part) => part.text).join("")).join("\n")
const changes = [
  { section: "Unreleased · in 0.0.4-nightly", text: "`/whatsnew` lists what changed and what fits you.", fresh: true },
  { section: "v0.0.3 · 2026-11-01", text: "Worktrees answer at once.", fresh: false },
]
const ready = (): WhatsNewState => ({
  ...createWhatsNewState({ all: false, summary: "2 changes since your last look", changes }),
  status: "ready",
  picks: [
    { text: "Turn on message threads: you use an Anthropic key.", patch: { tier: { message_threads: true } }, diff: ["message_threads: off → on"] },
    { text: "Try the worktree cleanup.", command: "/storage" },
    { text: "Read the new docs.", dropped: "no setting changes this" },
  ],
})

describe("/whatsnew page", () => {
  test("while the model reads, the changes are already listed under a loading line", () => {
    const page = text(createWhatsNewState({ all: false, summary: "", changes }))
    expect(page).toContain("For you")
    expect(page).toContain("the changes are below while the model reads them")
    expect(page).toContain("Worktrees answer at once.")
  })

  test("/whatsnew all lists the changes alone, with no For you section", () => {
    const page = text(createWhatsNewState({ all: true, summary: "", changes }))
    expect(page).toContain("What's new · all")
    expect(page).not.toContain("For you  ")
    expect(page).toContain(" new")
  })

  test("a settings pick needs a second Enter; Esc on the preview keeps things as they are", () => {
    let state = ready()
    let step = whatsNewKey(state, "\r")
    expect(step.action).toEqual({ type: "none" })
    expect(step.state.confirm).toBe(0)
    expect(text(step.state)).toContain("Change MendCode settings?")
    expect(whatsNewKey(step.state, "\x1b")).toMatchObject({ action: { type: "none" }, state: { confirm: undefined } })
    step = whatsNewKey(step.state, "\r")
    expect(step.action).toEqual({ type: "apply", pick: 0 })
    state = step.state
    expect(state.confirm).toBeUndefined()
  })

  test("a command pick inserts its command only after the second Enter", () => {
    const down = whatsNewKey(ready(), "\x1b[B").state
    const preview = whatsNewKey(down, "\r")
    expect(text(preview.state)).toContain("Put /storage in the prompt?")
    expect(whatsNewKey(preview.state, "\r").action).toEqual({ type: "command", pick: 1 })
  })

  test("a pick with no action never opens a preview", () => {
    let state = ready()
    state = whatsNewKey(whatsNewKey(state, "\x1b[B").state, "\x1b[B").state
    const step = whatsNewKey(state, "\r")
    expect(step.state.confirm).toBeUndefined()
    expect(text(step.state)).toContain("no action · no setting changes this")
  })

  test("the search filters picks and changes; Esc clears it before leaving the page", () => {
    let state = ready()
    for (const key of ["/", "w", "o", "r", "k"]) state = whatsNewKey(state, key).state
    const page = text(state)
    expect(page).toContain("Worktrees answer at once.")
    expect(page).not.toContain("Turn on message threads")
    state = whatsNewKey(state, "\r").state
    expect(whatsNewKey(state, "\x1b").action).toEqual({ type: "none" })
    expect(whatsNewKey(whatsNewKey(state, "\x1b").state, "\x1b").action).toEqual({ type: "close" })
  })

  test("a failed call shows its error and keeps the changes", () => {
    const page = text({ ...ready(), status: "error", error: "the model call failed: no login", picks: [] })
    expect(page).toContain("the model call failed: no login")
    expect(page).toContain("Worktrees answer at once.")
  })

  test("the cost line shows the estimate while asking, then what the provider counted", () => {
    expect(whatsNewCostText(undefined, "loading")).toBe("reading your setup…")
    expect(whatsNewCostText({ model: "gpt-6-luna", estimate: 4200 }, "loading")).toBe("asking gpt-6-luna · about 4.2k tokens")
    expect(whatsNewCostText({ model: "gpt-6-luna", estimate: 4200, usage: { input: 3900, output: 300, costMicros: 2500 } }, "ready")).toBe("gpt-6-luna · 3.9k in · 300 out · $0.0025")
  })

  test("the page fits a narrow terminal", () => {
    const lines = renderWhatsNewPage({ state: ready(), width: 50, height: 20 })
    expect(lines.length).toBeLessThanOrEqual(20)
  })
})

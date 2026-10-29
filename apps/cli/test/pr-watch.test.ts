import { afterAll, describe, expect, test } from "bun:test"
import { parseSlash } from "../src/view/commands"
import { parsePrCommand, prSections, prSummary, PR_USAGE, type PrWatchRow } from "../src/view/pr-watch"
import { appHarness, cleanTemps } from "./session-ui-harness"

afterAll(cleanTemps)

const row = (patch: Partial<PrWatchRow> = {}): PrWatchRow => ({ number: 7, title: "Add the thing", url: "https://github.com/acme/app/pull/7", state: "watching", summary: "open · checks 5 passed, 1 failed, 0 pending · review none · mergeable", ...patch })

describe("/pr words", () => {
  test("no words list, a bare reference watches, and the verbs take at most one reference", () => {
    expect(parsePrCommand("")).toEqual({ ok: true, command: { action: "list" } })
    expect(parsePrCommand("7")).toEqual({ ok: true, command: { action: "watch", pr: "7" } })
    expect(parsePrCommand("watch #7")).toEqual({ ok: true, command: { action: "watch", pr: "#7" } })
    expect(parsePrCommand("watch")).toEqual({ ok: true, command: { action: "watch" } })
    expect(parsePrCommand("stop https://github.com/acme/app/pull/7")).toEqual({ ok: true, command: { action: "unwatch", pr: "https://github.com/acme/app/pull/7" } })
    expect(parsePrCommand("status feature")).toEqual({ ok: true, command: { action: "check", pr: "feature" } })
    expect(parsePrCommand("unwatch")).toEqual({ ok: true, command: { action: "unwatch" } })
    expect(parsePrCommand("watch 7 8")).toEqual({ ok: false, error: PR_USAGE })
    expect(parsePrCommand("list 7")).toEqual({ ok: false, error: PR_USAGE })
    expect(parseSlash("/pr watch 7")).toMatchObject({ command: { name: "pr" }, args: "watch 7" })
  })

  test("the page leads with the PR's state for watch and check, then lists what the session watches", () => {
    const sections = prSections({ action: "watch", text: "Watching.\nPR #7 \"Add the thing\" · open", watches: [row(), row({ number: 9, state: "merged", title: "Old" })] })
    expect(sections.map((section) => section.heading)).toEqual(["Now watching", "Watched by this session"])
    expect(sections[0]!.lines).toEqual(["Watching.", "PR #7 \"Add the thing\" · open"])
    expect(sections[1]!.lines).toContain("#7 watching")
    expect(sections[1]!.lines).toContain("#9 ended · merged")
    expect(prSections({ action: "list", text: "", watches: [] })[0]!.lines[0]).toContain("/pr watch NUMBER")
    expect(prSummary([row(), row({ state: "merged" })])).toBe("1 watching · 1 ended · gh is read about every minute · esc closes")
  })
})

describe("/pr in the terminal", () => {
  test("/pr 7 asks the daemon to watch, opens the page with the state and the watch list, and esc closes it", async () => {
    const h = appHarness({ reply: (command) => command.type === "pr.watch" ? { ok: true, result: { text: "Watching.\nPR #7 \"Add the thing\" · open\nchecks: 5 passed, 1 failed, 0 pending", watches: [row()] } } : undefined })
    await h.type("/pr 7\r")
    expect(h.sentOf("pr.watch")).toEqual([{ type: "pr.watch", sessionId: h.sessionId, action: "watch", pr: "7" }])
    const text = h.text().join("\n")
    expect(text).toContain("Pull requests")
    expect(text).toContain("checks: 5 passed, 1 failed, 0 pending")
    expect(text).toContain("#7 watching")
    await h.app.onKey("\x1b")
    expect(h.text().join("\n")).not.toContain("Watched by this session")
  })

  test("/pr lists, /pr unwatch stops and says so without leaving the chat, a refusal is shown on the page", async () => {
    const h = appHarness({ reply: (command) => {
      if (command.type !== "pr.watch") return undefined
      if (command.action === "unwatch") return { ok: true, result: { text: "Stopped watching #7.", watches: [] } }
      if (command.action === "check") return { ok: false, error: { code: "invalid_command", message: "[DAEMON]: PR watch is off: turn it on with /experimental pr_watch on" } }
      return { ok: true, result: { text: "", watches: [] } }
    } })
    await h.type("/pr\r")
    expect(h.sentOf("pr.watch").at(-1)).toEqual({ type: "pr.watch", sessionId: h.sessionId, action: "list" })
    expect(h.text().join("\n")).toContain("Nothing yet")
    await h.app.onKey("\x1b")
    await h.type("/pr unwatch\r")
    expect(h.sentOf("pr.watch").at(-1)).toEqual({ type: "pr.watch", sessionId: h.sessionId, action: "unwatch" })
    expect(h.text().join("\n")).toContain("Stopped watching #7.")
    await h.type("/pr check 7\r")
    expect(h.text().join("\n")).toContain("PR watch is off: turn it on with /experimental pr_watch on")
  })

  test("bad words are refused before anything is sent, and a remote client never asks: gh runs on the daemon's machine", async () => {
    const local = appHarness()
    await local.type("/pr watch 7 8\r")
    expect(local.sentOf("pr.watch")).toEqual([])
    expect(local.text().join("\n")).toContain("usage: /pr")
    const remote = appHarness({ remote: { host: "box", readOnly: false } })
    await remote.type("/pr 7\r")
    expect(remote.sentOf("pr.watch")).toEqual([])
    expect(remote.text().join("\n")).toContain("pr: gh runs on the daemon's own machine")
  })
})

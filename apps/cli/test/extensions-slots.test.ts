import { afterEach, describe, expect, test } from "bun:test"
import { textWidth } from "../src/view/wrap"
import { renderHome } from "../src/view/home"
import { appHarness, extension, plain, scratch } from "./extensions-harness"

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

const LONG = "L".repeat(300)

/** One extension that draws in every slot, with text far wider than any terminal under test. */
const EVERYWHERE = extension(
  "everywhere",
  `
  api.slot("header.replace", () => [[{ text: "HEAD:" + ${JSON.stringify(LONG)}, fg: "primary" }], [{ text: "HEAD2", fg: "no-such-role", bg: "no-such-bg", bold: true }]])
  api.slot("footer.left", () => [[{ text: "FL", fg: "success" }]])
  api.slot("footer.right", () => [[{ text: "FR:" + ${JSON.stringify(LONG)}, fg: "warning" }]])
  api.slot("welcome.below", () => [[{ text: "BELOW:" + ${JSON.stringify(LONG)} }], [{ text: "BELOW2" }]])
  api.slot("prompt.above", () => [[{ text: "ABOVE:" + ${JSON.stringify(LONG)} }]])
  api.slot("prompt.below", () => [[{ text: "UNDER:" + ${JSON.stringify(LONG)} }]])
  api.slot("working.replace", () => [[{ text: "WORKING-X:" + ${JSON.stringify(LONG)} }]])
`,
)

const widest = (rows: string[]) => Math.max(...rows.map(textWidth))

describe("slots draw where MendCode draws and stay inside the terminal", () => {
  for (const width of [60, 100]) {
    test(`header.replace takes the top bar's place at ${width} columns, clipped, with unknown roles falling back to text`, async () => {
      const { dataDir, write } = layout()
      write("data/extensions/all.ts", EVERYWHERE)
      const h = await appHarness({ dataDir, width })
      await h.start()
      h.message("question", "answer")
      const rows = h.rows()
      expect(rows[0]).toStartWith("  HEAD:LLL")
      expect(rows[1]).toStartWith("  HEAD2")
      expect(widest(rows)).toBeLessThanOrEqual(width)
      // The default top bar (`<branch> <path>`) is gone.
      expect(rows[0]).not.toContain("/work/app")
      const head2 = h.frames.at(-1)![1]!.find((span) => span.text.startsWith("HEAD2"))!
      // An unknown foreground role is `text`; an unknown background is dropped rather than painted.
      expect(head2.fg).toBe("text")
      expect(head2.bg).toBeUndefined()
      expect(head2).toMatchObject({ bold: true })
      const head = h.frames.at(-1)![0]!.find((span) => span.text.startsWith("HEAD:"))!
      expect(head.fg).toBe("primary")
    })

    test(`footer.left and footer.right share the status row in balanced and the footer in full at ${width} columns`, async () => {
      const { dataDir, write } = layout()
      write("data/extensions/all.ts", EVERYWHERE)
      for (const mode of ["balanced", "full"] as const) {
        const h = await appHarness({ dataDir, width, mode })
        await h.start()
        h.message("question", "answer")
        const rows = h.rows()
        const row = rows.find((candidate) => candidate.includes("FL") && candidate.includes("FR:"))!
        expect(row).toBeDefined()
        expect(textWidth(row)).toBeLessThanOrEqual(width)
        expect(row.indexOf("FL")).toBeLessThan(row.indexOf("FR:"))
        // The right block is cut, not dropped, and ends at the prompt margin.
        expect(row.trimEnd()).toMatch(/FR:L+$/)
        expect(widest(rows)).toBeLessThanOrEqual(width)
      }
    })

    test(`welcome.below sits under the home content at ${width} columns`, async () => {
      const { dataDir, write } = layout()
      write("data/extensions/all.ts", EVERYWHERE)
      const h = await appHarness({ dataDir, width })
      await h.start()
      const rows = h.rows()
      const below = rows.findIndex((row) => row.includes("BELOW:LLL"))
      expect(below).toBeGreaterThan(rows.findIndex((row) => row.includes("No sessions yet")))
      expect(rows[below + 1]).toContain("BELOW2")
      expect(widest(rows)).toBeLessThanOrEqual(width)
    })

    test(`prompt.above and prompt.below surround the prompt box at ${width} columns`, async () => {
      const { dataDir, write } = layout()
      write("data/extensions/all.ts", EVERYWHERE)
      const h = await appHarness({ dataDir, width })
      await h.start()
      h.message("question", "answer")
      const rows = h.rows()
      const above = rows.findIndex((row) => row.startsWith("ABOVE:LLL"))
      const prompt = rows.findIndex((row) => row.includes("❭"))
      const under = rows.findIndex((row) => row.startsWith("UNDER:LLL"))
      expect(above).toBeGreaterThan(-1)
      expect(above).toBeLessThan(prompt)
      expect(under).toBeGreaterThan(prompt)
      // Replace-style fitting: exactly the width, never wider.
      expect(textWidth(rows[above]!)).toBe(width)
      expect(widest(rows)).toBeLessThanOrEqual(width)
    })

    test(`working.replace draws in the spinner row's place at ${width} columns`, async () => {
      const { dataDir, write } = layout()
      write("data/extensions/all.ts", EVERYWHERE)
      const h = await appHarness({ dataDir, width })
      await h.start()
      h.message("question", "answer")
      h.working()
      const rows = h.rows()
      expect(rows.some((row) => row.includes("WORKING-X:LLL"))).toBe(true)
      expect(h.text()).not.toContain("Generating...")
      expect(widest(rows)).toBeLessThanOrEqual(width)
    })
  }

  test("welcome.replace is the whole home and footer.replace the whole footer row", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/replace.ts",
      extension(
        "replace",
        `
      api.slot("welcome.replace", (ctx) => [[{ text: "CUSTOM WELCOME " + ctx.width + "x" + ctx.height }]])
      api.slot("footer.replace", () => [[{ text: "CUSTOM FOOTER" }]])
    `,
      ),
    )
    const h = await appHarness({ dataDir, width: 80, height: 24 })
    await h.start()
    expect(h.text()).toContain("CUSTOM WELCOME 80x")
    expect(h.text()).not.toContain("No sessions yet")
    expect(h.text()).not.toContain("MendCode")
    expect(h.rows().some((row) => row.includes("CUSTOM FOOTER"))).toBe(true)
    expect(h.text()).not.toContain("ready")
  })

  test("a slot that returns undefined keeps the default", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/quiet.ts", extension("quiet", `api.slot("welcome.replace", () => undefined); api.slot("header.replace", () => undefined)`))
    const h = await appHarness({ dataDir })
    await h.start()
    expect(h.text()).toContain("No sessions yet")
  })

  test("several extensions: additive slots stack in load order, replace slots go to the last that answers", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/a.ts", extension("a", `api.slot("welcome.below", () => [[{ text: "FROM-A" }]]); api.slot("welcome.replace", () => [[{ text: "REPLACE-A" }]])`))
    write("data/extensions/b.ts", extension("b", `api.slot("welcome.below", () => [[{ text: "FROM-B" }]]); api.slot("welcome.replace", () => undefined)`))
    const h = await appHarness({ dataDir })
    await h.start()
    // b declines to replace, so a's replacement wins (below is not drawn by a replaced home).
    expect(h.text()).toContain("REPLACE-A")
    write("data/extensions/c.ts", extension("c", `api.slot("welcome.replace", () => [[{ text: "REPLACE-C" }]])`))
    const again = await appHarness({ dataDir })
    await again.start()
    expect(again.text()).toContain("REPLACE-C")
    expect(again.text()).not.toContain("REPLACE-A")
    const rows = renderHome({ width: 80, height: 24, root: "~", below: [[{ text: "x" }]] }).map(plain)
    expect(rows.at(-1)).toBe("x")
  })

  test("the context has the screen, the session and the working state", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/ctx.ts", extension("ctx", `api.slot("footer.left", (ctx) => { globalThis.__ext.last = ctx; return [[{ text: "ctx" }]] })`))
    const h = await appHarness({ dataDir, width: 90, height: 28, directory: "/work/app" })
    await h.start()
    h.message("question", "answer")
    const idle = store.__ext!.last as Record<string, unknown>
    expect(idle).toMatchObject({ directory: "/work/app", state: "idle", now: 1_800_000_000_000, sessionId: h.sessionId })
    expect(idle.width as number).toBeGreaterThan(40)
    expect(Object.isFrozen(idle)).toBe(true)
    h.working()
    expect((store.__ext!.last as Record<string, unknown>).state).toBe("working")
    h.app.onConnection("reconnecting")
    h.app.render()
    expect((store.__ext!.last as Record<string, unknown>).state).toBe("offline")
  })
})

describe("a renderer that throws is disabled for the session and reported", () => {
  test("it is called once, the screen keeps drawing, and the rest of the extension still works", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/fragile.ts",
      extension(
        "fragile",
        `
      globalThis.__ext.calls = 0
      api.slot("prompt.below", () => { globalThis.__ext.calls++; throw new Error("renderer blew up") })
      api.slot("footer.left", () => [[{ text: "STILL-HERE" }]])
    `,
      ),
    )
    const h = await appHarness({ dataDir })
    await h.start()
    h.message("question", "answer")
    h.app.render()
    h.app.render()
    expect(store.__ext!.calls).toBe(1)
    expect(h.text()).toContain("STILL-HERE")
    expect(h.text()).not.toContain("UNDER")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("fragile: slot prompt.below disabled: renderer blew up")
  })

  test("a renderer returning the wrong shape is disabled too", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/wrong.ts", extension("wrong", `globalThis.__ext.calls = 0; api.slot("footer.right", () => { globalThis.__ext.calls++; return "not lines" })`))
    const h = await appHarness({ dataDir })
    await h.start()
    h.app.render()
    h.app.render()
    expect(store.__ext!.calls).toBe(1)
    await h.type("/help\r")
    expect(h.text()).toContain("expected Line[] or undefined, got string")
  })

  test("a slot given hostile text cannot smuggle terminal controls into a frame", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/evil.ts", extension("evil", `api.slot("footer.left", () => [[{ text: "a\\x1b[2Jb\\x07c\\nd\\te" }]])`))
    const h = await appHarness({ dataDir })
    await h.start()
    expect(h.text()).toContain("abc d e")
    expect(h.text()).not.toContain("\x1b")
  })
})

describe("renderTool", () => {
  test("an extension draws the card of a built-in tool; other tools keep the default card", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/tools.ts",
      extension(
        "tools",
        `api.renderTool("shell", ({ tool, args, output, status, width, expanded }) => [[{ text: "SHELL<" + tool + "|" + args.detail + "|" + status + "|" + output.trim() + "|" + (width > 10) + "|" + expanded + ">", fg: "success" }]])
      api.renderTool("edit", () => undefined)`,
      ),
    )
    const h = await appHarness({ dataDir, width: 100 })
    await h.start()
    h.tool("shell: make test", "all green")
    h.tool("read: src/a.ts", "contents")
    expect(h.text()).toContain("SHELL<shell|make test|ok|all green|true|false>")
    // The default shell box would show `$ make test`.
    expect(h.text()).not.toContain("$ make test")
    h.tool("edit: src/b.ts", "")
    expect(h.text()).toContain("src/b.ts")
  })

  test("the running and failed states are passed on, and the body is clipped to the card", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/tools.ts", extension("tools", `api.renderTool("custom__x", ({ status }) => [[{ text: status + ":" + ${JSON.stringify(LONG)} }]])`))
    const h = await appHarness({ dataDir, width: 60 })
    await h.start()
    h.tool("custom__x", "boom", "error")
    const row = h.rows().find((candidate) => candidate.includes("error:LLL"))!
    expect(row).toBeDefined()
    expect(textWidth(row)).toBeLessThanOrEqual(60)
  })

  test("a tool renderer that throws is disabled and the default card returns", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/tools.ts", extension("tools", `globalThis.__ext.calls = 0; api.renderTool("shell", () => { globalThis.__ext.calls++; throw new Error("card blew up") })`))
    const h = await appHarness({ dataDir })
    await h.start()
    h.tool("shell: make", "ok")
    await Bun.sleep(5)
    h.app.render()
    expect(store.__ext!.calls).toBe(1)
    expect(h.text()).toContain("make")
    expect(h.text()).toContain("tools: renderTool shell disabled: card blew up")
  })

  test("a finished call hands over every argument, frozen; a cut or missing input is { detail } and not final", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/tools.ts",
      extension(
        "tools",
        `api.renderTool("custom__deploy", ({ args, final }) => {
        let blocked = "no"
        try { args.target = "prod"; blocked = "silent" } catch { blocked = "threw" }
        try { args.steps.push("x") } catch { blocked += "+threw" }
        return [[{ text: "ARGS<" + final + "|" + args.detail + "|" + args.target + "|" + (args.steps ? args.steps.join(",") : "-") + "|" + (args.note ? args.note.length : 0) + "|" + Object.isFrozen(args) + "|" + blocked + ">" }]]
      })`,
      ),
    )
    const h = await appHarness({ dataDir, width: 160 })
    await h.start()
    h.tool("custom__deploy: staging", "done", "ok", JSON.stringify({ target: "staging", steps: ["build", "push"], note: "n".repeat(5000) }))
    // Strings over 2000 characters are cut (with the ellipsis), the object and its lists are frozen in strict module code.
    expect(h.text()).toContain("ARGS<true|staging|staging|build,push|2000|true|threw+threw>")
    h.tool("custom__deploy: canary", "done", "ok", '{"target": "can')
    expect(h.text()).toContain("ARGS<false|canary|undefined|-|0|true|threw+threw>")
  })

  test("patterns: the exact name beats the longest prefix, which beats *; equals go to the later one; undefined passes it on", async () => {
    const { dataDir, write } = layout()
    write(
      "data/extensions/a.ts",
      extension(
        "a",
        `api.renderTool("*", ({ tool }) => [[{ text: "ANY<" + tool + ">" }]])
      api.renderTool("mcp__*", ({ tool }) => [[{ text: "MCP<" + tool + ">" }]])
      api.renderTool("mcp__github__*", ({ tool }) => tool.endsWith("skip") ? undefined : [[{ text: "GH<" + tool + ">" }]])
      api.renderTool("mcp__github__issue", () => [[{ text: "EXACT-A" }]])`,
      ),
    )
    write("data/extensions/b.ts", extension("b", `api.renderTool("mcp__github__issue", () => [[{ text: "EXACT-B" }]])`))
    const h = await appHarness({ dataDir, width: 100 })
    await h.start()
    h.tool("mcp__github__issue: 12", "ok")
    h.tool("mcp__github__pr: 3", "ok")
    h.tool("mcp__github__skip", "ok")
    h.tool("mcp__slack__post", "ok")
    h.tool("shell: ls", "ok")
    const text = h.text()
    expect(text).toContain("EXACT-B")
    expect(text).not.toContain("EXACT-A")
    expect(text).toContain("GH<mcp__github__pr>")
    expect(text).toContain("MCP<mcp__github__skip>")
    expect(text).toContain("MCP<mcp__slack__post>")
    expect(text).toContain("ANY<shell>")
  })

  test("a * anywhere but the end is refused at load", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/a.ts", extension("a", `api.renderTool("mcp__*__issue", () => undefined)`))
    const h = await appHarness({ dataDir })
    await h.start()
    expect(h.text()).toContain(`"*" may only end the name`)
  })
})

describe("markdown transforms", () => {
  test("apply to assistant text only, chained in load order", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/a.ts", extension("a", `api.markdown((text) => text.replaceAll("alpha", "beta"))`))
    write("data/extensions/b.ts", extension("b", `api.markdown((text) => text.replaceAll("beta", "gamma"))`))
    const h = await appHarness({ dataDir })
    await h.start()
    h.message("say alpha", "alpha is first")
    expect(h.text()).toContain("gamma is first")
    // The user's own message is not assistant markdown.
    expect(h.text()).toContain("say alpha")
  })

  test("the transform sees the whole text, so markdown it adds is rendered", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/bold.ts", extension("bold", `api.markdown((text) => text.replace("IMPORTANT", "**IMPORTANT**"))`))
    const h = await appHarness({ dataDir })
    await h.start()
    h.message("q", "IMPORTANT news")
    const span = h.frames.at(-1)!.flat().find((candidate) => candidate.text === "IMPORTANT")
    expect(span).toMatchObject({ bold: true })
    expect(h.text()).not.toContain("**")
  })

  test("a transform that throws is disabled and the text passes through unchanged", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/bad.ts", extension("bad", `globalThis.__ext.calls = 0; api.markdown(() => { globalThis.__ext.calls++; throw new Error("transform blew up") })`))
    const h = await appHarness({ dataDir })
    await h.start()
    h.message("q", "plain text")
    expect(h.text()).toContain("plain text")
    expect(store.__ext!.calls).toBe(1)
    h.app.render()
    expect(store.__ext!.calls).toBe(1)
  })
})

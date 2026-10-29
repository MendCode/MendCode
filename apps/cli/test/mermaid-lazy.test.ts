import { describe, expect, test } from "bun:test"
import path from "node:path"

/**
 * The mermaid renderer (~1000 lines, ~3 MB of parsed bytecode measured in isolation) loads on first
 * ```mermaid fence, not at startup (see mermaid-lazy.ts). Each test runs in a fresh process — this
 * module's own singleton state, and any other test file's, must not leak into it.
 */
const cli = path.join(import.meta.dir, "..")

function probe(script: string) {
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: cli, stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString().trim())
}

const FENCE = "```mermaid\nflowchart TD\n A --> B\n```"

describe("mermaid loads lazily", () => {
  test("is absent from the app's startup module graph", () => {
    const script = `await import("./src/ui/app.ts")
console.log(JSON.stringify({ loaded: Object.keys(require.cache).some((k) => k.endsWith("/view/mermaid.ts")) }))`
    expect(probe(script).loaded).toBe(false)
  })

  test("a fence renders as a placeholder immediately, then as the real diagram once the module loads", () => {
    const script = `const { renderMarkdown } = await import("./src/view/markdown.ts")
const text = (lines) => lines.map((l) => l.map((s) => s.text).join("")).join("\\n")
const before = text(renderMarkdown(${JSON.stringify(FENCE)}, 100))
await new Promise((r) => setTimeout(r, 100))
const after = text(renderMarkdown(${JSON.stringify(FENCE)}, 100))
console.log(JSON.stringify({ before, after }))`
    const { before, after } = probe(script)
    expect(before).toContain("loading diagram…")
    expect(before).not.toContain("│ A │")
    expect(after).toContain("│ A │")
  })

  test("the placeholder never exceeds the requested width", () => {
    const script = `const { renderMarkdown } = await import("./src/view/markdown.ts")
const { textWidth } = await import("./src/view/wrap.ts")
const lines = renderMarkdown(${JSON.stringify(FENCE)}, 20)
console.log(JSON.stringify({ widths: lines.map((l) => textWidth(l.map((s) => s.text).join(""))) }))`
    for (const width of probe(script).widths) expect(width).toBeLessThanOrEqual(20)
  })

  test("onMermaidLoaded fires once, asynchronously, even when called after the module already loaded", () => {
    const script = `const { ensureMermaid, onMermaidLoaded } = await import("./src/view/mermaid-lazy.ts")
ensureMermaid()
await new Promise((r) => setTimeout(r, 100))
let calls = 0
onMermaidLoaded(() => { calls++ })
const immediately = calls
await Promise.resolve()
await Promise.resolve()
console.log(JSON.stringify({ immediately, after: calls }))`
    const { immediately, after } = probe(script)
    expect(immediately).toBe(0)
    expect(after).toBe(1)
  })

  test("a completed message rendered before the module loaded upgrades once it does (transcript cache)", () => {
    const script = `const { createTranscript } = await import("./src/view/transcript.ts")
const { glyphs } = await import("./src/ui/theme.ts")
const t = createTranscript({ glyphs: glyphs({}) })
const turnId = "t1", itemId = "i1"
let seq = 0
const ev = (e) => ({ sessionId: "s1", seq: ++seq, at: 0, ...e })
t.apply(ev({ type: "turn.started", turnId, queueId: "q1" }))
t.apply(ev({ type: "item.started", turnId, itemId, kind: "agent_message" }))
t.apply(ev({ type: "item.completed", itemId, status: "ok", text: ${JSON.stringify(FENCE)} }))
const before = t.viewport(100, 20).map((l) => l.text).join("\\n")
await new Promise((r) => setTimeout(r, 150))
const after = t.viewport(100, 20).map((l) => l.text).join("\\n")
console.log(JSON.stringify({ before, after }))`
    const { before, after } = probe(script)
    expect(before).toContain("loading diagram…")
    expect(after).toContain("│ A │")
  })
})

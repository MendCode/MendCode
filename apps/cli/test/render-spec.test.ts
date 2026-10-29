import { describe, expect, test } from "bun:test"
import { normalizeRenderSpec, parseRenderSpec, type RenderNode } from "@mendcode/protocol"
import { renderSpecLines } from "../src/view/render-spec"
import { renderToolCard } from "../src/view/tool-card"
import { textWidth } from "../src/view/wrap"
import type { Line } from "../src/ui/theme"

const text = (line: Line) => line.map((span) => span.text).join("")

const spec: RenderNode = {
  type: "stack",
  children: [
    { type: "row", children: [{ type: "badge", text: "zod", tone: "accent" }, { type: "text", text: "v4.6.5", tone: "success", bold: true }] },
    { type: "box", title: "Size", children: [{ type: "progress", value: 51, max: 100, label: "bundle" }, { type: "sparkline", values: [1, 3, 2, 8, 5], label: "weekly" }] },
    { type: "table", columns: ["dep", "version"], rows: [["a", "1.0.0"], ["b", "2.1.0"]] },
    { type: "kv", items: [{ key: "license", value: "MIT" }, { key: "types", value: "yes", tone: "success" }] },
    { type: "list", items: ["one", "two"], ordered: true },
    { type: "code", text: "import { z } from 'zod'" },
    { type: "diff", text: "@@ -1,1 +1,1 @@\n-old\n+new" },
  ],
}

describe("render specs in the protocol", () => {
  test("a valid spec passes; unknown node types and oversized trees are refused", () => {
    expect(parseRenderSpec(spec).ok).toBe(true)
    expect(parseRenderSpec({ type: "script", src: "rm -rf /" })).toMatchObject({ ok: false })
    let deep: RenderNode = { type: "text", text: "x" }
    for (let i = 0; i < 8; i++) deep = { type: "stack", children: [deep] }
    expect(parseRenderSpec(deep)).toMatchObject({ ok: false, error: expect.stringContaining("deeper") })
    const wide = { type: "stack", children: Array.from({ length: 40 }, () => ({ type: "stack", children: Array.from({ length: 6 }, () => ({ type: "text", text: "x" })) })) }
    expect(parseRenderSpec(wide)).toMatchObject({ ok: false, error: expect.stringContaining("nodes") })
  })

  test("normalization turns loose tool JSON into a valid spec (numbers in text slots, numeric strings in bars)", () => {
    const loose = { type: "stack", children: [{ type: "table", columns: ["n", 2], rows: [[1, true], ["x"]] }, { type: "progress", value: "42" }, { type: "kv", items: [{ key: "k", value: 7 }] }] }
    expect(parseRenderSpec(loose).ok).toBe(false)
    const normalized = parseRenderSpec(normalizeRenderSpec(loose))
    expect(normalized.ok).toBe(true)
    if (normalized.ok) expect(normalized.spec).toMatchObject({ children: [{ rows: [["1", "true"], ["x"]] }, { value: 42 }, { items: [{ value: "7" }] }] })
  })
})

describe("renderSpecLines", () => {
  test("draws every primitive", () => {
    const out = renderSpecLines(spec, 60).map(text)
    expect(out[0]).toContain(" zod ")
    expect(out[0]).toContain("v4.6.5")
    expect(out.some((l) => l.startsWith("┌") && l.endsWith("┐"))).toBe(true)
    expect(out.some((l) => l.includes("│ Size"))).toBe(true)
    expect(out.some((l) => l.includes("bundle") && l.includes("█") && l.includes("51%"))).toBe(true)
    expect(out.some((l) => l.includes("weekly") && /[▁▂▃▄▅▆▇█]{5}/.test(l))).toBe(true)
    expect(out.some((l) => l.startsWith("dep") && l.includes("version"))).toBe(true)
    expect(out.some((l) => l.startsWith("license") && l.includes("MIT"))).toBe(true)
    expect(out).toContain("1. one")
    expect(out.some((l) => l.startsWith("│ import"))).toBe(true)
    expect(out.some((l) => l.includes("- old")) && out.some((l) => l.includes("+ new"))).toBe(true)
  })

  test.each([20, 40, 80, 140])("never exceeds width %i", (width) => {
    for (const line of renderSpecLines(spec, width)) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
  })

  test("a tool card with a render spec shows its header and the drawing instead of the text", () => {
    const rows = renderToolCard({ title: "custom__pkg: zod", text: '{"version":"4.6.5"}', status: "ok", width: 70, expanded: false, frame: 0, tailLines: 4, render: { type: "badge", text: "4.6.5" } }).map(text)
    expect(rows[0]).toBe("   ◆ pkg zod")
    expect(rows[1]).toContain(" 4.6.5 ")
    expect(rows.join("\n")).not.toContain('{"version"')
    const failed = renderToolCard({ title: "custom__pkg: zod", text: "boom", status: "error", width: 70, expanded: false, frame: 0, tailLines: 4, render: { type: "badge", text: "x" } }).map(text)
    expect(failed.join("\n")).toContain("boom")
  })
})

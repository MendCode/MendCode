import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { detailsDefaults, renderMarkdown } from "../src/view/markdown"
import { mathDisplay, mathInline } from "../src/view/math"
import { createTranscript } from "../src/view/transcript"
import { textWidth } from "../src/view/wrap"

const rows = (source: string, width = 60, options?: Parameters<typeof renderMarkdown>[3]) =>
  renderMarkdown(source, width, "body", options).map((line) => line.map((span) => span.text).join(""))

describe("math as Unicode", () => {
  test("the reported display equations render without LaTeX", () => {
    expect(rows("$$ d = v \\times t $$").join("\n").trim()).toBe("d = v × t")
    expect(rows("$$ A = \\pi r^2 $$").join("\n").trim()).toBe("A = πr²")
    expect(rows("$$\nA = \\pi r^2\n$$").join("\n").trim()).toBe("A = πr²")
    expect(rows("$$ d = v \\times t $$").join("")).not.toContain("$")
  })

  test("inline math inside prose, with Greek letters, operators and scripts", () => {
    expect(rows("La energía $E = mc^2$ y $\\alpha_1 \\leq \\beta$ valen.")[0]).toBe("La energía E = mc² y α₁ ≤ β valen.")
    expect(mathInline("x_i^2 + \\Delta y \\neq \\infty")).toBe("xᵢ² + Δy ≠ ∞")
    expect(mathInline("\\sqrt{x^2 + y^2}")).toBe("√(x² + y²)")
    expect(mathInline("e^{-x}")).toBe("e⁻ˣ")
  })

  test("money and shell-style dollars stay literal", () => {
    expect(rows("Cuesta $5 y luego $10 en total.")[0]).toBe("Cuesta $5 y luego $10 en total.")
    expect(rows("echo $HOME y $PATH")[0]).toBe("echo $HOME y $PATH")
  })

  test("fractions are a/b inline and stacked in display math", () => {
    expect(mathInline("\\frac{a+b}{c}")).toBe("(a + b)/c")
    expect(mathInline("\\frac{1}{2}")).toBe("½")
    expect(mathDisplay("\\frac{a+b}{c}", 40)).toEqual([" a + b", "───────", "   c"])
    const sum = mathDisplay("\\sum_{i=1}^{n} x_i", 40)
    expect(sum).toHaveLength(3)
    expect(sum.join("\n")).toContain("∑")
  })

  test("matrices, cases and aligned rows lay out as several lines", () => {
    expect(mathDisplay("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", 40)).toEqual(["⎛a  b⎞", "⎝c  d⎠"])
    expect(mathDisplay("f(x) = \\begin{cases} x & x > 0 \\\\ -x & \\text{otherwise} \\end{cases}", 60)).toHaveLength(2)
    expect(mathDisplay("\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}", 40)).toEqual(["a = b + c", "d = e"])
  })

  test("a display wider than the viewport falls back to flat lines that fit", () => {
    const wide = "\\frac{aaaaaaaaaaaaaaaaaaaa}{bbbbbbbbbbbbbbbbbbbb}"
    for (const line of mathDisplay(wide, 20)) expect(textWidth(line)).toBeGreaterThan(0)
    expect(mathDisplay(wide, 20)).toHaveLength(1)
  })

  test("malformed and hostile input never throws", () => {
    for (const source of ["x^{", "\\frac{", "\\begin{pmatrix} a &", "\\unknown{y}", "}}}{{{", "\\constructor", "\\\\", "{".repeat(200), "\\frac".repeat(50)]) {
      expect(() => mathInline(source)).not.toThrow()
      expect(() => mathDisplay(source, 30)).not.toThrow()
    }
  })

  test("an unclosed $$ block stays as text instead of swallowing the rest", () => {
    expect(rows("$$ x\n\nSigue el texto.").join("\n")).toContain("Sigue el texto.")
  })

  test("math lines never exceed the width", () => {
    for (const line of rows("$$\\sum_{i=1}^{n} \\frac{x_i}{y_i} = \\frac{\\alpha + \\beta + \\gamma + \\delta}{\\epsilon + \\zeta}$$", 24)) expect(textWidth(line)).toBeLessThanOrEqual(24)
  })
})

describe("collapsible details", () => {
  const source = "Antes\n\n<details>\n<summary>Ver <b>más</b></summary>\n\nCuerpo **oculto** con $x^2$.\n\n<details><summary>Interior</summary>\nprofundo\n</details>\n\n</details>\n\nDespués"

  test("collapsed by default: summary with a ▸ marker and the hidden line count, nothing of the body", () => {
    const out = rows(source)
    expect(out.join("\n")).toContain("▸ Ver más · 2 lines")
    expect(out.join("\n")).not.toContain("Cuerpo")
    expect(out.at(-1)).toBe("Después")
    expect(out.join("\n")).not.toContain("<details")
  })

  test("expanded shows the body indented, with inline markup and nested blocks still collapsed", () => {
    const out = rows(source, 60, { detailsOpen: (n) => (n === 0 ? true : undefined) })
    expect(out.join("\n")).toContain("▾ Ver más")
    expect(out).toContain("  Cuerpo oculto con x².")
    expect(out.join("\n")).toContain("  ▸ Interior")
    expect(out.join("\n")).not.toContain("profundo")
  })

  test("state is per block: opening the nested block alone leaves the outer one closed", () => {
    expect(rows(source, 60, { detailsOpen: (n) => n === 1 }).join("\n")).not.toContain("profundo")
    expect(rows(source, 60, { detailsOpen: () => true }).join("\n")).toContain("profundo")
  })

  test("the open attribute is honored until an explicit state overrides it", () => {
    const open = "<details open><summary>Abierto</summary>cuerpo</details>"
    expect(rows(open).join("\n")).toContain("▾ Abierto")
    expect(rows(open, 60, { detailsOpen: () => false }).join("\n")).toContain("▸ Abierto")
    expect(detailsDefaults(`${open}\n<details><summary>x</summary>y</details>`)).toEqual([true, false])
  })

  test("a streaming, unclosed block and a summary-less block still render", () => {
    expect(rows("<details>\n<summary>Parcial</summary>\nse está escrib").join("\n")).toContain("▸ Parcial")
    expect(rows("<details>\ncuerpo\n</details>").join("\n")).toContain("▸ Details")
  })

  test("a long summary wraps within the width", () => {
    for (const line of rows("<details><summary>" + "palabra ".repeat(20) + "</summary>x</details>", 30)) expect(textWidth(line)).toBeLessThanOrEqual(30)
  })

  test("the transcript keeps one open state per block and ctrl-o opens them all", () => {
    const ids = createIdFactory()
    const sessionId = ids("session")
    const itemId = ids("item")
    const turnId = ids("turn")
    let seq = 0
    const push = (event: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...event }) as SessionEvent
    const t = createTranscript()
    t.apply(push({ type: "turn.started", turnId, queueId: ids("queue") }))
    t.apply(push({ type: "item.started", turnId, itemId, kind: "agent_message" }))
    t.apply(push({ type: "item.completed", itemId, status: "ok", text: "<details><summary>Uno</summary>\nprimero\n</details>\n\n<details><summary>Dos</summary>\nsegundo\n</details>" }))
    const text = () => t.viewport(80, 30).map((line) => line.text).join("\n")
    expect(text()).not.toContain("primero")
    t.toggleDetails(itemId, 0)
    expect(text()).toContain("primero")
    expect(text()).not.toContain("segundo")
    t.toggleDetails(itemId, 0)
    expect(text()).not.toContain("primero")
    t.toggleDetails(itemId)
    expect(text()).toContain("segundo")
    t.toggleDetails(itemId)
    expect(text()).not.toContain("segundo")
    t.toggleTools()
    expect(text()).toContain("segundo")
  })

  test("summary rows carry their block's ordinal, and a block can be folded on its own while ctrl-o has everything open", () => {
    const ids = createIdFactory()
    const sessionId = ids("session")
    const itemId = ids("item")
    const turnId = ids("turn")
    let seq = 0
    const push = (event: Record<string, unknown>) => ({ sessionId, seq: ++seq, at: 0, ...event }) as SessionEvent
    const t = createTranscript()
    t.apply(push({ type: "turn.started", turnId, queueId: ids("queue") }))
    t.apply(push({ type: "item.started", turnId, itemId, kind: "agent_message" }))
    t.apply(push({ type: "item.completed", itemId, status: "ok", text: "<details><summary>Uno</summary>\nprimero\n</details>\n\n<details><summary>Dos</summary>\nsegundo\n</details>" }))
    const text = () => t.viewport(80, 30).map((line) => line.text).join("\n")
    expect(t.viewport(80, 30).filter((line) => line.fold !== undefined).map((line) => [line.fold, line.itemId])).toEqual([[0, itemId], [1, itemId]])
    t.toggleTools()
    expect(text()).toContain("primero")
    t.toggleDetails(itemId, 0)
    expect(text()).not.toContain("primero")
    expect(text()).toContain("segundo")
    t.toggleDetails(itemId, 0)
    expect(text()).toContain("primero")
    t.toggleDetails(itemId, 1)
    t.toggleTools()
    expect(text()).not.toContain("primero")
    expect(text()).not.toContain("segundo")
  })
})

describe("inline html", () => {
  test("<br> breaks the line, in paragraphs and table cells", () => {
    expect(rows("uno<br>dos<br/>tres")).toEqual(["uno", "dos", "tres"])
    const table = rows("| a<br>b | c |\n|---|---|\n| x | y |")
    expect(table.some((line) => line.includes("│ a "))).toBe(true)
    expect(table.some((line) => line.includes("│ b "))).toBe(true)
  })

  test("<kbd> shows a key cap, <sub> and <sup> use script characters", () => {
    expect(rows("Pulsa <kbd>Ctrl</kbd>+<kbd>C</kbd>")[0]).toBe("Pulsa [Ctrl]+[C]")
    expect(rows("H<sub>2</sub>O y x<sup>2</sup> y a<sup>n+1</sup> y C<sub>máx</sub>")[0]).toBe("H₂O y x² y aⁿ⁺¹ y C_(máx)")
  })

  test("common formatting tags, links, entities and comments degrade cleanly", () => {
    const [line] = rows("<b>negrita</b> <i>cursiva</i> <code>x</code> &amp; &lt;t&gt; <!-- oculto --><span class=\"x\">fin</span>")
    expect(line).toBe("negrita cursiva x & <t> fin")
    expect(rows('<a href="https://x.dev">sitio</a>')[0]).toBe("sitio (https://x.dev)")
    expect(rows('<img src="a.png" alt="logo">')[0]).toBe("[logo]")
  })

  test("generic text in angle brackets is not eaten", () => {
    expect(rows("usa Array<string> y Map<K, V>")[0]).toBe("usa Array<string> y Map<K, V>")
  })

  test("everything stays within the width", () => {
    for (const line of rows("<b>" + "palabra ".repeat(30) + "</b><br>" + "<kbd>x</kbd> ".repeat(30), 25)) expect(textWidth(line)).toBeLessThanOrEqual(25)
  })
})

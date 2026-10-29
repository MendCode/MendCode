import { describe, expect, test } from "bun:test"
import { bindRenderTemplate } from "../src/render-bind"

describe("bindRenderTemplate", () => {
  const scope = { args: { pkg: "zod" }, result: { version: "4.6.5", size: 51234, deps: [{ name: "a", v: 1 }, { name: "b", v: 2 }], weekly: [1, 3, 2] } }

  test("bindings inside strings are replaced; a string that is one binding takes the raw value", () => {
    expect(bindRenderTemplate({ type: "text", text: "{{args.pkg}} v{{result.version}}" }, scope)).toEqual({ type: "text", text: "zod v4.6.5" })
    expect(bindRenderTemplate({ type: "sparkline", values: "{{result.weekly}}" }, scope)).toEqual({ type: "sparkline", values: [1, 3, 2] })
    expect(bindRenderTemplate({ type: "text", text: "{{result.missing}}!" }, scope)).toEqual({ type: "text", text: "!" })
    expect(bindRenderTemplate("{{result.deps[1].name}}", scope)).toBe("b")
  })

  test("$each expands one mapped element per item, bounded", () => {
    const template = { type: "table", columns: ["dep", "v"], rows: [{ $each: "{{result.deps}}", map: ["{{item.name}}", "{{item.v}}"] }] }
    expect(bindRenderTemplate(template, scope)).toEqual({ type: "table", columns: ["dep", "v"], rows: [["a", 1], ["b", 2]] })
    const many = { items: [{ $each: "{{result.list}}", map: "{{item}}" }] }
    expect((bindRenderTemplate(many, { result: { list: Array.from({ length: 80 }, (_, i) => i) } }) as { items: unknown[] }).items).toHaveLength(50)
  })

  test("non-array $each sources expand to nothing; deep templates stop", () => {
    expect(bindRenderTemplate({ items: [{ $each: "{{result.version}}", map: "x" }] }, scope)).toEqual({ items: [] })
    let deep: unknown = "leaf"
    for (let i = 0; i < 20; i++) deep = { child: deep }
    expect(JSON.stringify(bindRenderTemplate(deep, scope))).not.toContain("leaf")
  })
})

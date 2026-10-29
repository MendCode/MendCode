import { expect, test } from "bun:test"
import { z } from "zod"
import { assembleSchema, createSchemaCatalog, Frame, MAX_FRAME_BYTES, type SchemaCatalog } from "../src"

type Schema = Record<string, unknown>
const envelope = (value: unknown) => Buffer.byteLength(JSON.stringify({ v: 1, kind: "ack", id: "cmd_00000000000000000000000000", result: { report: { facts: { contract: value } } } }))
const everything = (catalog: SchemaCatalog) => {
  const first = catalog.index()!
  const indexes = Array.from({ length: first.indexPages }, (_, page) => catalog.index(page)!)
  return { indexes, pages: Array.from({ length: first.pages }, (_, page) => catalog.page(page)!) }
}

/** The real protocol schema with every command body repeated under new names, as if the protocol had `times` times as many commands. */
function grown(times: number): Schema {
  const source = z.toJSONSchema(Frame, { io: "input", reused: "ref" }) as Schema
  const variants = (source.oneOf as Schema[]).map((variant) => structuredClone(variant))
  const command = variants.find((variant) => ((variant.properties as Schema).kind as Schema).const === "command")!
  const body = (command.properties as Schema).body as { oneOf: Schema[] }
  const original = body.oneOf
  const defs = { ...(source.$defs as Record<string, Schema>) }
  body.oneOf = []
  for (let copy = 0; copy < times; copy++) {
    for (const member of original) {
      const clone = structuredClone(member)
      ;((clone.properties as Schema).type as Schema).const = `${(((member.properties as Schema).type as Schema).const as string)}.copy${copy}`
      body.oneOf.push(clone)
    }
    if (copy > 0) for (const [name, definition] of Object.entries(source.$defs as Record<string, Schema>)) defs[`${name}_copy${copy}`] = definition
  }
  return { ...source, oneOf: variants, $defs: defs }
}

test("the catalog pages join back into exactly the protocol schema", () => {
  const source = z.toJSONSchema(Frame, { io: "input", reused: "ref" }) as Schema
  expect(assembleSchema(everything(createSchemaCatalog(source)))).toEqual(source)
})

test("every reply stays well inside a frame, and an entry carries only the definitions it references", () => {
  const source = z.toJSONSchema(Frame, { io: "input", reused: "ref" }) as Schema
  const catalog = createSchemaCatalog(source)
  const { indexes, pages } = everything(catalog)
  for (const index of indexes) expect(envelope({ index })).toBeLessThan(MAX_FRAME_BYTES / 2)
  for (const page of pages) expect(envelope({ page })).toBeLessThan(MAX_FRAME_BYTES / 2 + 1024)
  const entry = catalog.entry("command:tui.query")!
  expect(JSON.stringify(entry)).toContain("tui.query")
  expect(JSON.stringify(entry)).not.toContain("session.send")
  expect(Object.keys(entry.$defs as object).length).toBeLessThan(Object.keys(source.$defs as object).length / 10)
  expect(catalog.entry("command:nope")).toBeUndefined()
  expect(catalog.page(pages.length)).toBeUndefined()
  expect(catalog.index(indexes.length)).toBeUndefined()
})

test("a protocol 2x and 10x larger still fits: every reply is one frame and the dump reassembles", () => {
  for (const times of [2, 10]) {
    const source = grown(times)
    expect(Buffer.byteLength(JSON.stringify(source))).toBeGreaterThan(MAX_FRAME_BYTES * (times === 2 ? 2 : 8))
    const catalog = createSchemaCatalog(source)
    const { indexes, pages } = everything(catalog)
    expect(pages.length).toBeGreaterThan(1)
    for (const index of indexes) expect(envelope({ index })).toBeLessThan(MAX_FRAME_BYTES)
    for (const page of pages) expect(envelope({ page })).toBeLessThan(MAX_FRAME_BYTES)
    for (const { name } of indexes.flatMap((index) => index.entries)) expect(envelope({ schema: catalog.entry(name) })).toBeLessThan(MAX_FRAME_BYTES)
    expect(assembleSchema({ indexes, pages })).toEqual(source)
  }
})

test("assembling refuses a dump with a missing page or index page", () => {
  const { indexes, pages } = everything(createSchemaCatalog(grown(10)))
  expect(indexes.length).toBeGreaterThan(1)
  expect(() => assembleSchema({ indexes, pages: pages.slice(1) })).toThrow("incomplete")
  expect(() => assembleSchema({ indexes: indexes.slice(1), pages })).toThrow("incomplete")
})

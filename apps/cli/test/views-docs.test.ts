import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, scratch } from "./extensions-harness"

/** The examples in docs/views.md run exactly as written. Set VIEWS_DUMP_DIR to write their frames to a folder. */

const doc = readFileSync(path.join(import.meta.dir, "../../../docs/views.md"), "utf8")
const example = (name: string) => {
  const match = new RegExp(`<!-- example: ${name} -->\\n\`\`\`ts\\n([\\s\\S]*?)\`\`\``).exec(doc)
  if (!match) throw new Error(`docs/views.md has no example ${name}`)
  return match[1]!
}

const temporary: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })

async function run(name: string, size: { width: number; height: number }, fill: (h: Awaited<ReturnType<typeof appHarness>>) => void) {
  const temp = scratch()
  temporary.push(temp)
  temp.write(`data/extensions/${name}.ts`, example(name))
  const h = await appHarness({ dataDir: temp.dataDir, directory: temp.project, ...size })
  await h.start({ onboarded: true })
  fill(h)
  const dump = process.env.VIEWS_DUMP_DIR
  if (dump) {
    mkdirSync(dump, { recursive: true })
    writeFileSync(path.join(dump, `${name}-${size.width}x${size.height}.txt`), `${h.rows().map((row) => row.trimEnd()).join("\n")}\n`)
  }
  return h
}

test("compact-read draws read calls as one line and leaves the other cards alone", async () => {
  for (const size of [{ width: 100, height: 30 }, { width: 200, height: 60 }]) {
    const h = await run("compact-read", size, (h) => {
      h.message("Find where the cache key is built", "Reading the store first.")
      h.tool("read: src/store.ts", Array.from({ length: 14 }, (_, i) => `${String(i + 1).padStart(6)}\tconst line${i} = cache.get(name)`).join("\n"))
      h.tool("grep: cache.get", "src/store.ts:12:const hit = cache.get(name)\nsrc/config.ts:7:cache.get(path)")
      h.tool("read: src/missing.ts", "ENOENT: no such file", "error")
    })
    const text = h.text()
    expect(text).toContain("◇ read src/store.ts · 14 lines")
    expect(text).toContain("◇ read src/missing.ts · 1 line")
    // The built-in card still draws grep, with its output
    expect(text).toContain("Grep cache.get")
    expect(text).toContain("cache.get(path)")
    expect(text).not.toContain("const line3 = cache.get(name)")
  }
})

test("rail-assistant keeps the Markdown behind a rail", async () => {
  for (const size of [{ width: 100, height: 30 }, { width: 200, height: 60 }]) {
    const h = await run("rail-assistant", size, (h) => {
      h.message("What changed?", "The cache key ignored the directory.\n\n```ts\nconst key = `${directory}:${name}`\n```\n\n- both sessions get their own entry\n- the **test** passes")
    })
    const rows = h.rows()
    expect(rows.some((row) => row.includes("┃ assistant"))).toBe(true)
    const body = rows.filter((row) => row.includes("┃ ") && !row.includes("assistant"))
    expect(body.join("\n")).toContain("The cache key ignored the directory.")
    expect(body.join("\n")).toContain("const key = `${directory}:${name}`")
    expect(body.join("\n")).toContain("both sessions get their own entry")
    // Every row of the message fits: the 4 spare cells held the rail
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(size.width)
  }
})

test("message-footer adds its line under the built-in answer and keeps the answer as it was", async () => {
  const h = await run("message-footer", { width: 100, height: 30 }, (h) => {
    h.message("What changed?", "The cache key ignored the directory.")
  })
  const rows = h.rows()
  const answer = rows.findIndex((row) => row.includes("The cache key ignored the directory."))
  const footer = rows.findIndex((row) => /sent .+ · 6 words/.test(row))
  expect(answer).toBeGreaterThanOrEqual(0)
  expect(footer).toBeGreaterThan(answer)
})

test("docs/views.md documents every slot and states plainly that views are not sandboxed", async () => {
  const { VIEW_SLOT_NAMES } = await import("@mendcode/extension-api/views")
  const { VIEWS_TRUST } = await import("../src/view/customize-page")
  expect(VIEW_SLOT_NAMES.filter((slot) => !doc.includes(`### ${slot}`) && !new RegExp(`^###.*\\b${slot.replace('.', '\\.')}\\b`, "m").test(doc) && !doc.includes(`\`${slot}\``))).toEqual([])
  expect(doc).toContain("not sandboxed")
  expect(doc).toContain("trusting its author")
  expect(VIEWS_TRUST.join(" ")).toContain("not sandboxed")
})

import { expect, test } from "bun:test"
import { fileContentPatch } from "../src/file-rest-patch"

function side(lines: string[], prefix: "+" | "-") {
  const output: string[] = []
  let included = false
  for (const line of lines) {
    if (line.startsWith("\\")) { if (included) output[output.length - 1] = output.at(-1)!.replace(/\n$/, ""); continue }
    included = line.startsWith(prefix) || line.startsWith(" ")
    if (included) output.push(line.slice(1) + "\n")
  }
  return output.join("")
}

test.each([
  ["", "new"], ["old\n", ""], ["old\n", "new"],
  ["a\nb\nc\n", "a\nnew\nc"], ["a\nb\na\nb\n", "b\na\nnew\nb"],
  ["a\nb\nc", "x\na\nb\nc\ny"], ["a\r\nb\r\n", "a\r\nx"],
])("B35 full-context patch transforms %j into %j with accurate EOF markers", (original, content) => {
  const result = fileContentPatch("app.ts", original, content), hunk = result.patch!.hunks[0]!
  expect(side(hunk.lines, "-")).toBe(original)
  expect(side(hunk.lines, "+")).toBe(content)
  expect(hunk.oldLines).toBe((original.match(/[^\n]*\n|[^\n]+$/g) ?? []).length)
  expect(hunk.newLines).toBe((content.match(/[^\n]*\n|[^\n]+$/g) ?? []).length)
  expect(result.diff).toContain("Index: app.ts")
})

test("B35 unchanged/whitespace-only content has no edits; pathological replacements fail at the local work cap", () => {
  expect(fileContentPatch("app.ts", "a\n b\n", "a\nb\n").patch!.hunks).toEqual([])
  expect(() => fileContentPatch("app.ts", "old\n".repeat(1000), "new\n".repeat(1000))).toThrow("complexity limit")
})

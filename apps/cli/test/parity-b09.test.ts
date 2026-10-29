import { afterEach, expect, test } from "bun:test"
import { callTitle } from "../../../packages/engine-native/src/engine"
import { cleanTemps } from "./session-ui-harness"
import { lspCases, lspScene } from "./lsp-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("LSP titles distinguish operations and paths before results arrive", () => {
  const args = { operation: "hover", filePath: "src/a.ts", line: 3, character: 7 }
  expect(callTitle({ callId: "1", name: "lsp", args })).toBe("lsp: hover src/a.ts:3:7")
  expect(callTitle({ callId: "2", name: "lsp", args: { ...args, operation: "documentSymbol" } })).toBe("lsp: documentSymbol src/a.ts")
  expect(callTitle({ callId: "3", name: "lsp", args: { ...args, operation: "workspaceSymbol", query: "execute" } })).toBe("lsp: workspaceSymbol execute")
  expect(callTitle({ callId: "4", name: "read", args: { path: "src/a.ts" } })).toBe("read: src/a.ts")
})

test("semantic results, empty and error states render through the app and remain readable in history at every breakpoint", async () => {
  const cases = await lspCases()
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    for (const scene of cases) {
      const h = lspScene(scene, width!, height!)
      const check = () => {
        expect(h.frames.at(-1)).toHaveLength(height!)
        for (const row of h.text()) {
          expect(textWidth(row)).toBeLessThanOrEqual(width!)
          expect(row).not.toContain("\x1b")
        }
      }
      check()
      expect(h.text().join("\n")).toContain(scene.input.operation)
      await h.type("/history\r")
      check()
      expect(h.text().join("\n")).toContain("History")
      await h.type("t")
      await h.type("\r")
      check()
      expect(h.text().join("\n")).toContain("lsp")
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
  }
}, 15_000)

import { expect, test } from "bun:test"
import { ContextReport, createIdFactory } from "../src"

const legacy = { model: "fake", sections: [], largest: [], images: 0, estimatedTokens: 0, compactAtTokens: 160000 }

test("context additions are optional for older reports and validate real counts, windows and re-reads", () => {
  expect(ContextReport.parse(legacy)).toEqual(legacy)
  const extra = { sessionId: createIdFactory()("session"), contextWindow: 200000, categories: [{ id: "skills", label: "skills", chars: 40, tokens: 10, count: 2 }], mcpTools: [], repeatedReads: [{ path: "src/main.ts", count: 2, tokens: 500 }] }
  expect(ContextReport.parse({ ...legacy, ...extra })).toEqual({ ...legacy, ...extra })
  expect(ContextReport.safeParse({ ...legacy, contextWindow: 0 }).success).toBe(false)
  expect(ContextReport.safeParse({ ...legacy, repeatedReads: [{ path: "a", count: 0, tokens: 1 }] }).success).toBe(false)
  expect(ContextReport.safeParse({ ...legacy, categories: [{ id: "mcp", label: "MCP", chars: 4, tokens: 1, count: -1 }] }).success).toBe(false)
})

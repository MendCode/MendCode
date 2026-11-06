import { z } from "zod"
import { MAX_RESULTS } from "./types"

const callDepth = z.union([z.number().int().min(1).max(20), z.literal("all")]).optional()

/** Tool discovery needs these schemas, not a scanner or an indexer. Shared with the implementations. */
export const graphToolDefinitions = {
  find: {
    name: "graph_find",
    description: "Where code is: symbols ranked by name, with file:line, from the project index. Ask this before grep or reading files to find a function, class or type. TS/JS/Python/Go/Rust/Swift.",
    permission: "read",
    args: z.object({
      query: z.string().trim().min(1).describe("Name or Class.method"),
      kind: z.string().optional().describe("Declaration kind, e.g. function, class, method"),
      path: z.string().optional().describe("File/directory scope"),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe("Max results (default 20)"),
      source: z.boolean().optional().describe("8 source lines/match"),
    }),
  },
  callers: {
    name: "graph_callers",
    description: "Who calls a symbol, or what it calls, across files; ask before changing it. Follows aliases/re-exports; dynamic dispatch may be missing.",
    permission: "read",
    args: z.object({
      symbol: z.string().trim().min(1).describe("Symbol, Class.method or path#name"),
      direction: z.enum(["in", "out"]).default("in").describe("in = callers, out = callees"),
      depth: callDepth.describe("Default 1; all = full reach, capped output"),
      path: z.string().optional().describe("Disambiguate by file or directory"),
    }),
  },
  fileApi: {
    name: "graph_file_api",
    description: "One file's symbols with line spans and imports, without its contents; ask before reading a large file whole.",
    permission: "read",
    args: z.object({ path: z.string().min(1).describe("Project-relative file") }),
  },
  map: {
    name: "graph_map",
    description: "Project directories, languages and most-called symbols.",
    permission: "read",
    args: z.object({
      path: z.string().optional().describe("Only under this directory"),
      depth: z.number().int().min(1).max(3).optional().describe("Directory levels to group by (default 2)"),
    }),
  },
  search: {
    name: "code_search",
    description: "Concept search via jg; falls back to symbols and literal text.",
    permission: "read",
    args: z.object({
      query: z.string().trim().min(1).describe("Concept or identifier"),
      path: z.string().optional().describe("File/directory scope (default: the whole project)"),
    }),
  },
  impact: {
    name: "graph_impact",
    description: "Cached transitive callers/importers. No scan; not safety proof.",
    tier: "balanced",
    permission: "read",
    args: z.object({ path: z.string().min(1).max(4096), depth: callDepth.describe("Default 2, or all") }),
  },
} as const

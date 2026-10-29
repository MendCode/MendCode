import { z } from "zod"
import { CODE_LIMITS } from "./code-runtime"

export const CODE_TOOL = {
  name: "code",
  description: "Run confined JavaScript or TypeScript (types are stripped) to orchestrate tools and return only selected data. Use tools.<name>(input), await, Promise.all/race/any and .then chains, destructuring, template literals, functions, classes (extends, super, static, getters/setters, #private), generators, Map/Set/Date/RegExp/URL, loops with labeled break/continue and console.log. Tool results are {output, title, meta?, truncated}; parse JSON output when needed. search({query, limit?}) returns eligible tool schemas locally. Every tool call keeps its own validation, permissions and extension hooks. No process, filesystem, network, timers, imports, eval or Function globals; regular expressions are checked for backtracking limits. Return JSON data (Map/Set/RegExp must be converted first); await every started promise. Limits: 32 KiB code, 16 calls, 24 KiB result/logs, 30 seconds.",
  args: z.strictObject({ code: z.string().min(1).refine((code) => Buffer.byteLength(code) <= CODE_LIMITS.maxCodeBytes, "code exceeds 32 KiB") }),
}

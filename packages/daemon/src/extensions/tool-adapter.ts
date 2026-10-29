import type { ExtensionTool, ExtensionToolContext, ExtensionToolResult } from "@mendcode/extension-api"
import { OUTPUT_LIMITS, type Tool, type ToolContext, type ToolResult } from "@mendcode/tools"
import { isTier } from "@mendcode/protocol"
import { z } from "zod"

/** A tool the engine takes from `projectTools`: its JSON schema goes to the model as-is; `override` replaces a built-in of the same name. */
export type ExtensionEngineTool = Tool & { jsonSchema: Record<string, unknown>; override: boolean }

export const EXTENSION_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** Names the engine handles itself, and the prefixes of the other tool families: never available to extensions. */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(["plan_submit", "task", "tool_search", "mendcode_tool_search", "code"])
export const RESERVED_TOOL_PREFIXES = ["mcp__", "custom__"] as const

const PERMISSIONS = new Set(["read", "write", "execute"])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Why a registered value is not an acceptable tool, or undefined when it is. */
export function toolProblem(tool: unknown): string | undefined {
  if (!isRecord(tool)) return "a tool must be an object"
  if (typeof tool.name !== "string" || !EXTENSION_TOOL_NAME.test(tool.name)) return "tool names use letters, digits, _ and - (max 64)"
  if (RESERVED_TOOL_NAMES.has(tool.name) || RESERVED_TOOL_PREFIXES.some((prefix) => (tool.name as string).startsWith(prefix))) return `the name ${tool.name} is reserved`
  if (typeof tool.description !== "string" || !tool.description.trim()) return `${tool.name}: description is required`
  if (!isRecord(tool.parameters)) return `${tool.name}: parameters must be a JSON schema object`
  if (typeof tool.permission !== "string" || !PERMISSIONS.has(tool.permission)) return `${tool.name}: permission must be read, write or execute`
  if (typeof tool.execute !== "function") return `${tool.name}: execute must be a function`
  if (tool.validateArgs !== undefined && typeof tool.validateArgs !== "function") return `${tool.name}: validateArgs must be a function`
  if (tool.tier !== undefined && !isTier(tool.tier)) return `${tool.name}: tier must be minimalist, balanced or full`
  return undefined
}

/** The engine's full tool context behind an extension-facing one, so a wrapped built-in keeps its background/workflow ports. */
const fullContexts = new WeakMap<object, ToolContext>()

const cut = (output: string) => (output.length > OUTPUT_LIMITS.maxBytes ? { output: `${output.slice(0, OUTPUT_LIMITS.maxBytes)}\n… output truncated`, truncated: true } : { output, truncated: false })

function metaOf(meta: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(meta)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(meta)) if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value
  return Object.keys(out).length ? out : undefined
}

/** An extension's answer as the engine's ToolResult; a malformed answer becomes an error the model can read. */
function toToolResult(tool: string, result: unknown): ToolResult {
  if (!isRecord(result) || typeof result.output !== "string") return { output: `[EXTENSIONS]: ${tool} returned an invalid result (expected { output: string })`, truncated: false, title: tool, isError: true }
  const meta = metaOf(result.meta)
  return {
    ...cut(result.output),
    title: typeof result.title === "string" && result.title ? result.title.slice(0, 120) : tool,
    isError: result.isError === true,
    ...(meta ? { meta } : {}),
    ...(result.render !== undefined ? { render: result.render } : {}),
  }
}

/** Native tools keep their object contract; schema-bearing adapters can validate before approval too. */
export function adaptTool({ tool, sessionId, breaker }: { tool: ExtensionTool; sessionId: string; breaker?: { stopped(): boolean; failed(): void; ok(): void } }): ExtensionEngineTool {
  return {
    name: tool.name,
    description: tool.description,
    permission: tool.permission,
    ...(tool.tier ? { tier: tool.tier } : {}),
    args: tool.validateArgs ? z.looseObject({}).superRefine((args, ctx) => {
      try {
        const error = tool.validateArgs!(args)
        if (error) ctx.addIssue({ code: "custom", message: error })
      } catch { ctx.addIssue({ code: "custom", message: "extension argument validation failed" }) }
    }) : z.looseObject({}),
    jsonSchema: tool.parameters,
    override: tool.override === true,
    async execute(args, context): Promise<ToolResult> {
      if (context.signal.aborted) return { output: "cancelled", truncated: false, title: tool.name, isError: true }
      // The breaker only stops new calls: it never reaches into one that is already running.
      if (breaker?.stopped()) return { output: `[EXTENSIONS]: ${tool.name} is stopped for this session after repeated failures; /extensions reload turns it back on. Continue without it.`, truncated: false, title: tool.name, isError: true }
      const extensionContext: ExtensionToolContext = { sessionId, cwd: context.cwd, signal: context.signal, onOutput: (chunk) => context.onOutput?.(chunk) }
      fullContexts.set(extensionContext, context)
      try {
        const raw: unknown = await tool.execute(args as Record<string, unknown>, extensionContext)
        if (isRecord(raw) && typeof raw.output === "string") breaker?.ok()
        else breaker?.failed()
        return toToolResult(tool.name, raw)
      } catch (error) {
        if (!context.signal.aborted) breaker?.failed()
        return { output: `[EXTENSIONS]: ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false, title: tool.name, isError: true }
      }
    },
  }
}

/**
 * A built-in tool as an extension tool, so an override can wrap it. It validates against the built-in's own schema and
 * runs with the engine's full context when called from an adapted tool (images a built-in returns are dropped).
 */
export function wrapBuiltin(builtin: Tool): ExtensionTool {
  return {
    name: builtin.name,
    description: builtin.description,
    parameters: z.toJSONSchema(builtin.args) as Record<string, unknown>,
    permission: builtin.permission,
    async execute(args, context): Promise<ExtensionToolResult> {
      const parsed = builtin.args.safeParse(args)
      if (!parsed.success) return { output: `invalid arguments for ${builtin.name}: ${z.prettifyError(parsed.error)}`, isError: true }
      const full = fullContexts.get(context) ?? { cwd: context.cwd, signal: context.signal, onOutput: context.onOutput }
      const result = await builtin.execute(parsed.data, full)
      const meta = metaOf(result.meta)
      return { output: result.output, isError: result.isError, title: result.title, ...(result.render !== undefined ? { render: result.render as never } : {}), ...(meta ? { meta } : {}) }
    },
  }
}

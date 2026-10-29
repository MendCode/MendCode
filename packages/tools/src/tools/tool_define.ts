import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { CUSTOM_TOOL_NAME, CUSTOM_TOOL_PREFIX, loadCustomToolFile, MAX_CUSTOM_TIMEOUT_MS } from "../custom-tools"
import { compileArgsSchema, SchemaError } from "../json-schema"
import { renderTemplateProblems } from "../render-bind"
import { defineTool, type Tool } from "../tool"
import { fail, truncateHeadTail } from "../util"

const MAX_SCRIPT_BYTES = 64 * 1024
const RUNNERS = { direct: [], bun: ["bun"], node: ["node"], python3: ["python3"], sh: ["/bin/sh"] } as const

const args = z.object({
  name: z.string().regex(CUSTOM_TOOL_NAME).describe("Tool name: letters, digits, _ and - (max 40); the model will see custom__<name>"),
  description: z.string().min(1).max(2_000).describe("What the tool does, for the model that will call it"),
  script: z.object({
    file: z.string().regex(/^[\w][\w.-]{0,60}$/).describe("Script file name, e.g. pkg_info.sh or pkg_info.ts"),
    content: z.string().min(1).describe("Script source. It gets the call's arguments as one JSON line on stdin (or as the last argv with input: argv) and prints its result; printing JSON lets the render bind to it"),
  }),
  runner: z.enum(["direct", "bun", "node", "python3", "sh"]).optional().describe("How to run the script: direct (needs a shebang), bun, node, python3 or sh. Default: bun for .ts/.js, python3 for .py, sh for .sh, else direct"),
  input: z.enum(["stdin", "argv"]).optional(),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON schema of the arguments: { type: object, properties, required }"),
  render: z.unknown().optional().describe(
    "Optional renderSpec@1 template for how a call's result is drawn: nodes stack{children,gap} row{children,weights} box{title,children} text{text,tone,bold,dim} badge{text,tone} progress{value,max,label,tone} table{columns,rows} kv{items:[{key,value,tone}]} list{items,ordered} code{text} diff{text} sparkline{values,label,tone}; strings may use {{args.x}} and {{result.y}} (result = the script's stdout parsed as JSON); a string that is only one binding takes the raw value; an array element {\"$each\":\"{{result.list}}\",\"map\":…} expands per item with {{item.…}}. Tones: text muted primary accent secondary info success warning error heading code",
  ),
  timeoutMs: z.number().int().min(1).max(MAX_CUSTOM_TIMEOUT_MS).optional(),
  scope: z.enum(["project", "user"]).optional().describe("project (default): .mendcode/tools of this project, usable once the user trusts it; user: all projects"),
  replace: z.boolean().optional().describe("Overwrite an existing tool of the same name"),
  test: z.record(z.string(), z.unknown()).optional().describe("Sample arguments: run the new tool once with them and show the result (and its render)"),
})

type DefineArgs = z.infer<typeof args>

function defaultRunner(file: string): keyof typeof RUNNERS {
  if (/\.(ts|js|mjs)$/.test(file)) return "bun"
  if (file.endsWith(".py")) return "python3"
  if (file.endsWith(".sh")) return "sh"
  return "direct"
}

function manifestOf(input: DefineArgs) {
  const runner = input.runner ?? defaultRunner(input.script.file)
  return {
    description: input.description,
    command: [...RUNNERS[runner], `./${input.script.file}`],
    ...(input.input ? { input: input.input } : {}),
    ...(input.args ? { args: input.args } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.render !== undefined ? { render: input.render } : {}),
  }
}

/** Everything wrong with a definition before anything is written. */
function problemsOf(input: DefineArgs): string[] {
  const problems: string[] = []
  if (Buffer.byteLength(input.script.content) > MAX_SCRIPT_BYTES) problems.push(`script is larger than ${MAX_SCRIPT_BYTES / 1024} KB`)
  if (input.script.file.endsWith(".json")) problems.push("script file cannot be .json (that is the manifest)")
  if ((input.runner ?? defaultRunner(input.script.file)) === "direct" && !input.script.content.startsWith("#!")) problems.push("a direct script needs a shebang line (#!/usr/bin/env …) or a runner")
  if (input.args) {
    try {
      compileArgsSchema(input.args)
    } catch (error) {
      problems.push(`args: ${error instanceof SchemaError ? error.message : String(error)}`)
    }
  }
  if (input.render !== undefined) problems.push(...renderTemplateProblems(input.render))
  return problems
}

/**
 * Lets the agent create a custom tool (manifest + script in .mendcode/tools, or the user's tools) with an
 * optional render spec, validated before anything is written and, with `test`, run once on sample
 * arguments so the result and its drawing show in the card. Always asks first (execute permission): the
 * approval shows the files. A project tool still runs only after the user trusts the project (/tools).
 */
export function createToolDefine(options: { userDir: string }): Tool {
  return defineTool({
    name: "tool_define",
    description:
      "Create or replace a custom tool: a script plus a manifest (description, JSON-schema args, optional render spec that draws its results as boxes, tables, bars…). Validated before writing; pass `test` to run it once on sample arguments. The user approves it; project tools need the project trusted in /tools before they can be called.",
    permission: "execute",
    args,
    async preview(input) {
      const problems = problemsOf(input)
      if (problems.length) return undefined
      const manifest = JSON.stringify(manifestOf(input), null, 2)
      const script = input.script.content.split("\n").slice(0, 60).join("\n")
      return `${input.scope === "user" ? "user" : "project"} tool ${CUSTOM_TOOL_PREFIX}${input.name}\n\n${input.name}.json\n${manifest}\n\n${input.script.file}\n${script}`.slice(0, 16_000)
    },
    async execute(input, context) {
      const title = `define ${input.name}`
      const problems = problemsOf(input)
      if (problems.length) return fail({ title, message: `not written:\n${problems.map((p) => `- ${p}`).join("\n")}` })
      const dir = input.scope === "user" ? join(options.userDir, "tools") : join(context.cwd, ".mendcode", "tools")
      const manifestFile = join(dir, `${input.name}.json`)
      const scriptFile = join(dir, input.script.file)
      if (!input.replace && (await stat(manifestFile).catch(() => undefined))) return fail({ title, message: `${input.name} already exists; pass replace: true to overwrite it` })
      await mkdir(dir, { recursive: true })
      await writeFile(scriptFile, input.script.content)
      await chmod(scriptFile, 0o755)
      await writeFile(manifestFile, `${JSON.stringify(manifestOf(input), null, 2)}\n`)
      const loaded = await loadCustomToolFile({ file: manifestFile, name: input.name, source: input.scope === "user" ? "user" : "project", directory: context.cwd })
      if ("message" in loaded) {
        await Promise.all([rm(manifestFile, { force: true }), rm(scriptFile, { force: true })])
        return fail({ title, message: `removed again, the manifest did not load: ${loaded.message}` })
      }
      const where = input.scope === "user" ? "your tools (all projects)" : ".mendcode/tools (usable once the project is trusted in /tools)"
      const lines = [`defined ${CUSTOM_TOOL_PREFIX}${input.name} in ${where}; callable from the next message`, `files: ${input.name}.json, ${input.script.file}`]
      if (!input.test) return { output: lines.join("\n"), truncated: false, title, isError: false, meta: { tool: input.name } }
      const run = await loaded.execute(input.test, context)
      const shown = truncateHeadTail({ text: run.output, limits: { maxBytes: 8_000, maxLines: 80 } })
      lines.push("", `test run (${run.isError ? "failed" : "ok"}):`, shown.text)
      return { output: lines.join("\n"), truncated: shown.truncated, title, isError: run.isError, meta: { tool: input.name }, ...(run.render !== undefined ? { render: run.render } : {}) }
    },
  })
}

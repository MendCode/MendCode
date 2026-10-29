import { isScriptFile, parseRunArguments, SCRIPT_NAME } from "./workflow-script"

export type ScriptBudgetArgs = { agents?: number; tokens?: number; usd?: number; minutes?: number }
type Source = { file: string } | { ref: string }

export type WorkflowCommandSpec =
  | { kind: "start"; source: Source; permission?: "ask" | "edits" | "full"; confirmed: boolean }
  | { kind: "run"; source: Source; args?: Record<string, unknown>; permission?: "ask" | "edits" | "full"; confirmed: boolean }
  | { kind: "new"; name: string }
  | { kind: "convert"; file: string }
  | { kind: "budget"; workflowId: string; budget: ScriptBudgetArgs }
  | { kind: "update"; workflowId: string; file: string }
  | { kind: "resume"; workflowId: string }
  | { kind: "accept"; workflowId: string; reason: string }

export type WorkflowCommandParse = { ok: true; spec: WorkflowCommandSpec } | { ok: false; error: string }

export const WORKFLOW_USAGE = "usage: /workflows<name|file.json> [--permission ask|edits|full] [--yes] | run <file.js|name> [args] [--yes] | new <name> | convert <file.json> | budget <id> agents=N tokens=N usd=N minutes=N | update <id> <file.js> | resume <id>"

const PERMISSIONS = new Set(["ask", "edits", "full"])
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
const BUDGET_KEYS = ["agents", "tokens", "usd", "minutes"] as const

function parseRun(rest: string): WorkflowCommandParse {
  let confirmed = false
  let permission: string | undefined
  let body = rest.replace(/(^|\s)--yes(?=\s|$)/g, () => {
    confirmed = true
    return " "
  })
  body = body.replace(/(^|\s)--permission\s+(\S+)/, (_all, _lead, value: string) => {
    permission = value
    return " "
  })
  if (permission !== undefined && !PERMISSIONS.has(permission)) return { ok: false, error: "--permission needs ask, edits or full" }
  const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (!match) return { ok: false, error: "usage: /workflows run <file.js|name> [key=value ... | {json}] [--yes]" }
  const target = match[1]!
  if (target.startsWith("--")) return { ok: false, error: `unknown flag ${target}` }
  const file = isScriptFile(target) || target.includes("/")
  if (!file && !SCRIPT_NAME.test(target)) return { ok: false, error: `"${target}" is not a saved script name or a .js file` }
  const args = parseRunArguments(match[2] ?? "")
  if (!args.ok) return { ok: false, error: args.error }
  return { ok: true, spec: { kind: "run", source: file ? { file: target } : { ref: target }, ...(args.args ? { args: args.args } : {}), ...(permission ? { permission: permission as "ask" | "edits" | "full" } : {}), confirmed } }
}

function parseBudget(rest: string): WorkflowCommandParse {
  const words = rest.trim().split(/\s+/).filter(Boolean)
  const workflowId = words.shift()
  if (!workflowId) return { ok: false, error: "usage: /workflows budget <id> agents=N tokens=N usd=N minutes=N" }
  const budget: ScriptBudgetArgs = {}
  for (const word of words) {
    const [key, raw] = word.split("=")
    if (!(BUDGET_KEYS as readonly string[]).includes(key ?? "")) return { ok: false, error: `unknown cap "${key}" (agents, tokens, usd, minutes)` }
    const value = Number(raw)
    if (!raw || !Number.isFinite(value) || value <= 0) return { ok: false, error: `${key} needs a positive number` }
    budget[key as keyof ScriptBudgetArgs] = value
  }
  return Object.keys(budget).length ? { ok: true, spec: { kind: "budget", workflowId, budget } } : { ok: false, error: "give at least one cap: agents=N tokens=N usd=N minutes=N" }
}

/**
 * Parses `/workflows`: a saved plan name or a plan file (`*.json` or a path), an optional permission, and `--yes` to
 * start after the preview; `run` starts a script (a `.js` file or a saved script name, with arguments); `new` writes a starter;
 * `convert` turns a JSON plan into a script; `budget`/`update`/`resume` act on a script run; `accept <id> <reason>` is what
 * `a` on /workflows prefills.
 */
export function parseWorkflowCommand(args: string): WorkflowCommandParse {
  const text = args.trim()
  if (!text) return { ok: false, error: WORKFLOW_USAGE }
  const accept = /^accept\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text)
  if (accept) {
    const reason = accept[2]?.trim()
    return reason ? { ok: true, spec: { kind: "accept", workflowId: accept[1]!, reason: reason.slice(0, 500) } } : { ok: false, error: "accept needs a reason: /workflows accept <id> <why it is done>" }
  }
  const verb = /^(run|new|convert|budget|update|resume)(?:\s+([\s\S]*))?$/.exec(text)
  if (verb) {
    const rest = verb[2] ?? ""
    const words = rest.trim().split(/\s+/).filter(Boolean)
    switch (verb[1]) {
      case "run":
        return parseRun(rest)
      case "new":
        return words.length === 1 && NAME.test(words[0]!) ? { ok: true, spec: { kind: "new", name: words[0]! } } : { ok: false, error: "usage: /workflows new <name> (a-z 0-9 . _ -)" }
      case "convert":
        return words.length === 1 && (words[0]!.endsWith(".json") || words[0]!.includes("/")) ? { ok: true, spec: { kind: "convert", file: words[0]! } } : { ok: false, error: "usage: /workflows convert <plan.json>" }
      case "budget":
        return parseBudget(rest)
      case "update":
        return words.length === 2 && (isScriptFile(words[1]!) || words[1]!.includes("/")) ? { ok: true, spec: { kind: "update", workflowId: words[0]!, file: words[1]! } } : { ok: false, error: "usage: /workflows update <id> <file.js>" }
      default:
        return words.length === 1 ? { ok: true, spec: { kind: "resume", workflowId: words[0]! } } : { ok: false, error: "usage: /workflows resume <id>" }
    }
  }
  const words = text.split(/\s+/)
  let target: string | undefined
  let permission: "ask" | "edits" | "full" | undefined
  let confirmed = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === "--yes") confirmed = true
    else if (word === "--permission") {
      const value = words[++i]
      if (!value || !PERMISSIONS.has(value)) return { ok: false, error: "--permission needs ask, edits or full" }
      permission = value as "ask" | "edits" | "full"
    } else if (word.startsWith("--")) return { ok: false, error: `unknown flag ${word}` }
    else if (target) return { ok: false, error: WORKFLOW_USAGE }
    else target = word
  }
  if (!target) return { ok: false, error: WORKFLOW_USAGE }
  if (isScriptFile(target)) return { ok: true, spec: { kind: "run", source: { file: target }, ...(permission ? { permission } : {}), confirmed } }
  const isFile = target.endsWith(".json") || target.includes("/")
  if (!isFile && !NAME.test(target)) return { ok: false, error: `"${target}" is not a saved workflow name or a .json file` }
  return { ok: true, spec: { kind: "start", source: isFile ? { file: target } : { ref: target }, ...(permission ? { permission } : {}), confirmed } }
}

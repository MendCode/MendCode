import { z } from "zod"
import type { ExtensionInfo, ExtensionsReport } from "@mendcode/protocol"
import { defineTool, fail } from "@mendcode/tools"
import { PROGRAM_NAME } from "@mendcode/program"
import { outsideProject, writeUiExtension, type UiReloadReport } from "./customize-ui"
import type { DaemonExtensions } from "./extensions/loader"

/** A call a written rule must stop (`block`) or let through (`allow`), tried right after the module loads. */
const RuleCheck = z.strictObject({ tool: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()), expect: z.enum(["block", "allow"]) })
const checks = z.array(RuleCheck).max(20).optional()

export const ExtendArgs = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("write"), file: z.string().max(128), content: z.string().max(65536), checks }),
  z.strictObject({ action: z.literal("edit"), file: z.string().max(128), old: z.string().min(1).max(65536), new: z.string().max(65536), checks }),
  z.strictObject({ action: z.literal("reload") }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("command"), text: z.string().min(2).max(4000) }),
  z.strictObject({ action: z.literal("check"), tool: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) }),
])

/**
 * What the tool needs from the daemon's extensions: reload, the report of a directory, the route a typed `/command` takes, and
 * the `tool.before` handlers of a directory run on a call that is never executed.
 */
export type ExtendPort = {
  reload(directory: string): Promise<UiReloadReport>
  report(directory: string): Promise<ExtensionsReport>
  routeInput(ref: { sessionId: string; cwd: string }, text: string): Promise<{ kind: "submit"; text: string; notice?: string } | { kind: "handled"; notice?: string }>
  checkTool(input: { cwd: string; tool: string; args: Record<string, unknown> }): Promise<{ block?: string; args?: Record<string, unknown> } | undefined>
}

/** `checkTool` over the daemon's extensions: the same `tool.before` chain the engine runs, on a copy of the arguments. */
export function extensionToolCheck(extensions: Pick<DaemonExtensions, "ensure" | "bus">): ExtendPort["checkTool"] {
  return async ({ cwd, tool, args }) => {
    const scope = await extensions.ensure(cwd)
    return extensions.bus.toolBefore(scope.records, { sessionId: "mendcode_extend", turnId: "mendcode_extend", callId: "mendcode_extend", cwd, tool, args: structuredClone(args) })
  }
}

const P = PROGRAM_NAME
export const EXTEND_DESCRIPTION = `Change how MendCode itself behaves, live, for every project: a TypeScript extension in the user's <data dir>/extensions. Use it when the user asks for a slash command, a tool you can call, a rule on tool calls (block, rewrite, log), an input rewrite, text in every system prompt, something at turn or session start/end, a model provider, or a key; never answer such a request with a promise to behave, write the extension. write: file is a flat name.ts, content the whole module, checks (for a rule on tool calls) [{ tool, args, expect: "block"|"allow" }] tried as soon as it loads; edit: file, old (unique text), new; reload: load again; list: every extension with its hooks, tools, commands, provider and errors; command: run "/name args" of an extension command and see its answer; check: tool and args, runs the tool.before rules on that call without running it (try every tool a rule must stop, e.g. read, grep and shell, and one it must let through). A result with errors did not load: fix with edit. Module (no imports needed; node: imports work):
export default { name: "unique", daemon(api) { ... }, tui(api) { ... } }
daemon(api) (register everything in daemon(api) itself: api.on inside a handler is refused):
- api.registerCommand({ name, description, run: async (args, { cwd }) => ({ notice: "shown to the user" }) }) ; or ({ prompt: "sent to you" })
- api.registerTool({ name, description, permission: "read"|"write"|"execute", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async (args, { cwd, signal }) => ({ output: "text" }) })
- api.on("tool.before", (e) => cond ? { block: "reason" } : undefined) ; e.tool, e.args (shell: e.args.command; read/write/edit/grep/glob: e.args.path; read may send e.args.paths), e.cwd ; a rule on a path or folder covers every tool, shell too: /(^|[\\s"'=/])private([/"\\s]|$)/.test(JSON.stringify(e.args)) (a path follows a quote or a space, not only a slash; grep can name the folder itself) ; a call that reads a path through shell, grep or glob is also asked as { tool: "read", args: { path } } (e.via is the real call) ; a command rule matches every spelling (rm -rf, rm -fr, rm -r -f) ; test with checks: every tool it must stop and one it must allow ; a check that must hold each time (a clean git tree) runs inside the handler, e.g. with api.exec ; { args } rewrites them
- api.on("tool.after", (e) => ({ output })) ; api.on("input", (e) => ({ text }) | { handled: true, notice }) ; api.on("prompt.system", (e) => e.system + "\\n...") registered at the top of daemon(api): it runs before every model call of every session, so it also covers "at each session start add X to the context"
- api.on("turn.start" | "turn.end" | "session.start", (e) => { ... }) ; e.sessionId, e.cwd, e.outcome
- api.registerProvider({ id, type: "openai-compatible", baseUrl, apiKeyEnv: "ENV_NAME", models: [{ id }] }) ; never a key in the file
- session (sessionId from the event or the command's ctx; each answers { ok } or { ok: false, error }): await api.setModel(sessionId, "model", { effort }) ; api.setThinkingLevel ; api.setActiveTools(sessionId, ["read", "grep"] | null) narrows tools ; await api.sendUserMessage(sessionId, text) ; api.appendEntry(sessionId, type, data) / api.entries ; api.events.on/emit ; api.registerFlag("name", { type: "boolean"|"string", description }) + api.getFlag(name, sessionId) ; await api.ui.confirm(sessionId, title, message, { default: false }) / select / input (default required; headless answers it) ; api.registerMcpServer(name, { command, args } | { url, headers }) ; api.registerVirtualModel({ id, models, route }) ; "command" here runs outside any session, so session calls answer ok: false ; details: ${P} docs extend-session
- api.exec(program, args, { cwd, input }) resolves { stdout, stderr, code } (input is its stdin) ; files: import { appendFileSync } from "node:fs" ; api.dataDir (private folder) ; api.toast(text) ; api.notify(sessionId, text) ; api.log(level, text)
tui(api): api.key("ctrl+g", (a) => a.submit("/git")) ; api.command(name, description, (args, a) => a.toast(text)) ; api.slot("footer.right", (ctx) => [[{ text }]]) ; a.submit(text) sends text to you as the user's message (a /command runs), a.insert(text) only types it into the prompt, a.openPage(id). The look (theme, footer rows, message style) is customize_ui.
Plain text for every system prompt needs no code: <data dir>/APPEND_SYSTEM.md. Keys only: <data dir>/keybindings.json { "ctrl+g": "command:git" }. A shell command at an event: hooks.json (${P} docs hooks). The code runs with the user's privileges once approved; it is not sandboxed. Reference: ${P} docs extensions.`

const brief = (entry: ExtensionInfo) => ({
  name: entry.name,
  source: entry.source,
  file: entry.file,
  ...(entry.hooks.length ? { hooks: entry.hooks } : {}),
  ...(entry.tools.length ? { tools: entry.tools } : {}),
  ...(entry.commands.length ? { commands: entry.commands.map((name) => `/${name}`) } : {}),
  ...(entry.provider ? { provider: entry.provider } : {}),
  ...(entry.flags?.length ? { flags: entry.flags.map((name) => `--${name}`) } : {}),
  ...(entry.mcpServers?.length ? { mcpServers: entry.mcpServers } : {}),
  ...(entry.virtualModels?.length ? { virtualModels: entry.virtualModels } : {}),
  ...(entry.events?.length ? { events: entry.events } : {}),
  ...(entry.tui ? { tui: true } : {}),
  ...(entry.errors.length ? { errors: entry.errors } : {}),
  ...(entry.kept ? { kept: `old version still running: ${entry.kept}` } : {}),
  ...(entry.disabled ? { disabled: true } : {}),
  ...(!entry.trusted ? { trusted: false } : {}),
})

/** Each check through the directory's `tool.before` chain (never executed), with whether the answer is the one asked for. */
async function ruleChecks(extensions: ExtendPort, cwd: string, list: ReadonlyArray<z.infer<typeof RuleCheck>>) {
  const answers = []
  for (const check of list) {
    const verdict = await extensions.checkTool({ cwd, tool: check.tool, args: check.args })
    const got = verdict?.block !== undefined ? "block" : "allow"
    answers.push({ tool: check.tool, args: check.args, expect: check.expect, got, ok: got === check.expect, ...(verdict?.block !== undefined ? { reason: verdict.block } : {}) })
  }
  return answers
}

/** `mendcode_extend`: writes and reloads the user's extension modules and shows what each one registered. */
export function createExtendTool(input: { dir: string; extensions: ExtendPort }) {
  return defineTool({
    name: "mendcode_extend",
    permission: "write",
    permissionFor: (args) => (args.action === "list" ? "read" : args.action === "command" || args.action === "check" ? "execute" : "write"),
    description: EXTEND_DESCRIPTION,
    args: ExtendArgs,
    async execute(action, ctx) {
      try {
        if (action.action === "list") {
          const report = await input.extensions.report(ctx.cwd)
          return { title: "Extensions", output: JSON.stringify({ extensions: report.extensions.map(brief), ...(report.conflicts?.length ? { conflicts: report.conflicts.map((entry) => entry.note) } : {}) }), truncated: false, isError: false }
        }
        if (action.action === "command") {
          const typed = action.text.trim()
          if (!/^\/[a-z0-9][a-z0-9:_-]*(\s|$)/i.test(typed)) return fail({ title: "mendcode_extend", message: "command: text is /name args" })
          const routed = await input.extensions.routeInput({ sessionId: "mendcode_extend", cwd: ctx.cwd }, typed)
          if (routed.kind === "submit" && routed.text === typed) return fail({ title: "mendcode_extend", message: `${typed.split(/\s/)[0]} is not an extension command here (list shows them)` })
          return { title: `Extension ${typed.split(/\s/)[0]}`, output: JSON.stringify(routed.kind === "handled" ? { notice: routed.notice ?? "" } : { prompt: routed.text, ...(routed.notice ? { notice: routed.notice } : {}) }), truncated: false, isError: false }
        }
        if (action.action === "check") {
          const verdict = await input.extensions.checkTool({ cwd: ctx.cwd, tool: action.tool, args: action.args })
          return { title: `Rule check ${action.tool}`, output: JSON.stringify(verdict?.block !== undefined ? { blocked: verdict.block } : { allowed: true, ...(verdict?.args ? { rewrittenArgs: verdict.args } : {}) }), truncated: false, isError: false }
        }
        outsideProject(input.dir, ctx.cwd)
        const file = action.action === "write" || action.action === "edit" ? writeUiExtension(input.dir, action.file, action.action === "write" ? action.content : "", action.action === "edit" ? { old: action.old, new: action.new } : undefined) : undefined
        const reloaded = await input.extensions.reload(ctx.cwd)
        const report = await input.extensions.report(ctx.cwd)
        const mine = file ? report.extensions.find((entry) => entry.file === file) : undefined
        const errors = file ? mine?.errors ?? [] : reloaded.errors
        const tried = action.action === "write" || action.action === "edit" ? await ruleChecks(input.extensions, ctx.cwd, action.checks ?? []) : []
        const missed = tried.filter((entry) => !entry.ok)
        const guards = mine?.hooks.includes("tool.before") === true
        const result = {
          ...(file ? { file } : {}),
          ...(mine ? { extension: brief(mine) } : {}),
          errors,
          ...(tried.length ? { checks: tried } : {}),
          ...(missed.length ? { failedChecks: `${missed.length} of ${tried.length} checks did not get what they expect: fix the rule with edit (and the same checks)` } : {}),
          ...(mine?.tui ? { terminalValidation: reloaded.terminalValidation } : {}),
          ...(file && !mine?.daemon && !mine?.tui && !errors.length ? { note: "the module registered nothing: export default { name, daemon(api) {...} }" } : {}),
          ...(guards && !tried.length && !errors.length ? { note: "a tool.before rule is untested: write again with checks, the calls it must block (read, shell, grep...) and one it must allow" } : {}),
        }
        return { title: "Extend MendCode", output: JSON.stringify(result), truncated: false, isError: errors.length > 0 || Boolean(mine?.kept) || missed.length > 0 }
      } catch (error) {
        return fail({ title: "mendcode_extend", message: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

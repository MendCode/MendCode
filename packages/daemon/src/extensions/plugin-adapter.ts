import path from "node:path"
import { z } from "zod"
import { record, pluginConfig, type PluginFile } from "@mendcode/extension-api/plugin-files"
import type { DaemonExtensionAPI, Extension, ExtensionTool } from "@mendcode/extension-api"
import type { Plugin, PluginHooks, PluginTool, PluginHook } from "@mendcode/extension-api/plugin"

const nameOf = (file: PluginFile) => file.plugin.spec.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64) || "plugin"
const textParts = (text: string) => [{ type: "text", text }]
const partsText = (parts: unknown) => Array.isArray(parts) ? parts.filter(record).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n") : ""

export function pluginTool(name: string, value: PluginTool): ExtensionTool {
  const args = record(value.args) ? value.args : {}
  // Donor tool.schema shapes use zod. Plain JSON schemas are accepted for dependency-free modules too.
  const schema = Object.values(args).every((item) => record(item) && "_zod" in item) ? z.object(args as z.ZodRawShape) : undefined
  const parameters = schema ? z.toJSONSchema(schema) : args.type === "object" ? args : { type: "object", properties: args }
  return {
    name,
    description: value.description,
    parameters,
    ...(schema ? { validateArgs(input: Record<string, unknown>) { const parsed = schema.safeParse(input); return parsed.success ? undefined : z.prettifyError(parsed.error) } } : {}),
    permission: value.permission ?? "execute",
    async execute(input, ctx) {
      const parsed = schema ? schema.parse(input) : input
      let metadata: Record<string, unknown> = {}
      const output = await value.execute(parsed, { ...ctx, directory: ctx.cwd, worktree: ctx.cwd, sessionID: ctx.sessionId, abort: ctx.signal, messageID: "", agent: "build", metadata: (value) => { metadata = value }, ask: async () => { throw new Error("nested permission requests are unavailable; declare the tool's permission") } } as Parameters<PluginTool["execute"]>[1])
      const result = typeof output === "string" ? { output } : record(output) && typeof output.output === "string" ? output : undefined
      if (!result) throw new Error("plugin tool must return a string or { output }")
      const facts = record(metadata.metadata) ? metadata.metadata : "metadata" in result && record(result.metadata) ? result.metadata : {}
      return { output: result.output as string, ...(typeof metadata.title === "string" ? { title: metadata.title } : {}), meta: Object.fromEntries(Object.entries(facts).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]))) }
    },
  }
}

function register(api: DaemonExtensionAPI, hooks: PluginHooks) {
  for (const [name, value] of Object.entries(hooks.tool ?? {})) api.registerTool(pluginTool(name, value))
  if (hooks.auth) api.registerAuth(hooks.auth)
  if (hooks.provider) api.registerProvider(hooks.provider)
  const install = <K extends Parameters<DaemonExtensionAPI["on"]>[0]>(name: K, hook: PluginHook | undefined, handler: (event: never, call: PluginHook) => unknown) => {
    if (hook) api.on(name, ((event: never) => handler(event, hook)) as never)
  }
  if (hooks.event) api.on("event", ({ event }) => hooks.event!({ event }))
  install("input", hooks["chat.message"], async (e: { sessionId: string; text: string }, call) => {
    const output = { message: { role: "user", sessionID: e.sessionId }, parts: textParts(e.text) }
    await call({ sessionID: e.sessionId }, output)
    return { text: partsText(output.parts) }
  })
  install("command.before", hooks["command.execute.before"], async (e: { sessionId: string; command: string; args: string; text: string }, call) => {
    const output = { parts: textParts(e.text) }
    await call({ sessionID: e.sessionId, command: e.command, arguments: e.args }, output)
    return partsText(output.parts)
  })
  install("tool.before", hooks["tool.execute.before"], async (e: { sessionId: string; tool: string; callId: string; args: Record<string, unknown> }, call) => {
    const output = { args: structuredClone(e.args) }
    await call({ sessionID: e.sessionId, tool: e.tool, callID: e.callId }, output)
    return { args: output.args }
  })
  install("tool.after", hooks["tool.execute.after"], async (e: { sessionId: string; tool: string; callId: string; args: Record<string, unknown>; output: string; title?: string; meta?: Record<string, unknown> }, call) => {
    const output = { title: e.title ?? e.tool, output: e.output, metadata: e.meta ?? {} }
    await call({ sessionID: e.sessionId, tool: e.tool, callID: e.callId, args: e.args }, output)
    return { output: output.output, title: output.title, meta: output.metadata }
  })
  install("prompt.system", hooks["experimental.chat.system.transform"], async (e: { sessionId: string; system: string }, call) => {
    const output = { system: [e.system] }
    await call({ sessionID: e.sessionId }, output)
    return output.system.join("\n\n")
  })
  install("context", hooks["experimental.chat.messages.transform"], async (e: { messages: Record<string, unknown>[] }, call) => {
    const output = { messages: e.messages.map((message, index) => ({ info: { ...message, id: String(index) } as Record<string, unknown>, parts: textParts(String(message.content ?? message.output ?? "")) })) }
    await call({}, output)
    return output.messages.map(({ info, parts }) => ({ ...info, ...(info.role === "tool" ? { output: partsText(parts) } : { content: partsText(parts) }) }))
  })
  install("chat.params", hooks["chat.params"], async (e: { sessionId: string; provider: string; model: string; role: string; parameters: Record<string, unknown> }, call) => {
    const output = { temperature: e.parameters.temperature, topP: e.parameters.top_p, topK: e.parameters.top_k, maxOutputTokens: e.parameters.maxOutputTokens, options: structuredClone(e.parameters) }
    await call({ sessionID: e.sessionId, agent: e.role, model: { id: e.model, providerID: e.provider }, provider: { info: { id: e.provider }, source: "custom", options: {} }, message: { role: "user" } }, output)
    return { parameters: { ...output.options, ...Object.fromEntries(["temperature", "topP", "topK"].filter((key) => output[key as keyof typeof output] !== undefined).map((key) => [key === "topP" ? "top_p" : key === "topK" ? "top_k" : key, output[key as keyof typeof output]])) }, ...(typeof output.maxOutputTokens === "number" ? { maxOutputTokens: output.maxOutputTokens } : {}) }
  })
  install("chat.headers", hooks["chat.headers"], async (e: { sessionId: string; provider: string; model: string; role: string; headers: Record<string, string> }, call) => {
    const output = { headers: { ...e.headers } }
    await call({ sessionID: e.sessionId, agent: e.role, model: { id: e.model, providerID: e.provider }, provider: { info: { id: e.provider }, source: "custom", options: {} }, message: { role: "user" } }, output)
    return output.headers
  })
  install("permission.ask", hooks["permission.ask"], async (e: { sessionId: string; tool: string; args: Record<string, unknown> }, call) => {
    const output = { status: "ask" }
    await call({ sessionID: e.sessionId, type: e.tool, metadata: e.args }, output)
    return output
  })
  install("shell.env", hooks["shell.env"], async (e: { cwd: string; sessionId: string; env: Record<string, string> }, call) => {
    const output = { env: { ...e.env } }
    await call({ cwd: e.cwd, sessionID: e.sessionId }, output)
    return output.env
  })
  install("tool.definition", hooks["tool.definition"], async (e: { tool: string; description: string; parameters: Record<string, unknown> }, call) => {
    const output = { description: e.description, parameters: structuredClone(e.parameters) }
    await call({ toolID: e.tool }, output)
    return output
  })
  install("text.complete", hooks["experimental.text.complete"], async (e: { sessionId: string; itemId: string; text: string }, call) => {
    const output = { text: e.text }
    await call({ sessionID: e.sessionId, messageID: e.itemId, partID: e.itemId }, output)
    return output.text
  })
  install("compact.prompt", hooks["experimental.session.compacting"], async (e: { sessionId: string; prompt: string }, call) => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    await call({ sessionID: e.sessionId }, output)
    return output.prompt ?? [e.prompt, ...output.context].join("\n\n")
  })
  install("compact.continue", hooks["experimental.compaction.autocontinue"], async (e: { sessionId: string }, call) => {
    const output = { enabled: true }
    await call({ sessionID: e.sessionId, overflow: false }, output)
    return output.enabled
  })
}

export function adaptPluginModule(module: Record<string, unknown>, file: PluginFile, directory: string): Extension & { pluginId: string; abi: "v1-adapter" | "tool-module" } {
  const value = module.default
  const descriptor = record(value) ? value : record(module) ? module : {}
  const servers = [...new Set(Object.values(module))].flatMap((item): Plugin[] => typeof item === "function" ? [item as Plugin] : record(item) && typeof item.server === "function" ? [item.server as Plugin] : [])
  const id = typeof descriptor.id === "string" ? descriptor.id : nameOf(file)
  return {
    name: nameOf(file), pluginId: id, abi: file.plugin.kind === "tool" ? "tool-module" : "v1-adapter",
    ...(typeof descriptor.tui === "function" || typeof descriptor.activate === "function" ? { tui: () => {} } : {}),
    ...(file.plugin.kind === "tool" || servers.length ? { async daemon(api: DaemonExtensionAPI) {
      if (file.plugin.kind === "tool") {
        for (const [key, tool] of Object.entries(module)) if (record(tool) && typeof tool.execute === "function") api.registerTool(pluginTool(`${path.basename(file.file).replace(/\.(ts|js)$/, "")}${key === "default" ? "" : `_${key}`}`, tool as PluginTool))
        return
      }
      if (!servers.length) throw new Error("plugin has no server function")
      for (const server of servers) {
        const hooks = await server({ directory, worktree: directory, project: { id: directory, worktree: directory }, client: api, serverUrl: new URL("http://127.0.0.1") }, file.plugin.options)
        if (!record(hooks)) throw new Error("plugin server must return hooks")
        await hooks.config?.(structuredClone(pluginConfig(file.plugin.root ?? path.join(directory, ".mendcode")).value))
        register(api, hooks)
      }
    } } : {}),
  }
}

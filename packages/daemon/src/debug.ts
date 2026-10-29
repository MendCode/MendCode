import { readdir, realpath, stat, open } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"
import { agentAllows } from "@mendcode/engine-native"
import { matchingRule, permissionName, permissionPatterns, policyRules, toolDisabled, externalPatterns } from "../../engine-native/src/permission-rules"
import type { DebugInput, DebugReport, Settings, SessionId } from "@mendcode/protocol"
import { redactValue } from "./secrets"
import type { Store } from "@mendcode/store"
import type { Tool } from "@mendcode/tools"
import type { AgentRegistry } from "./agents"
import type { DaemonOptions } from "./daemon"
import type { DaemonExtensions } from "./extensions"
import type { CustomToolRegistry } from "@mendcode/tools"
import type { SkillLoader } from "@mendcode/engine-native"
import { readChanges, NotGitError } from "./changes"
import { searchFiles } from "./files-index"
import { queryFiles } from "./files-query"
import { createDebugSnapshots } from "./debug-snapshots"

const MAX_BYTES = 120_000
function filePatch(file: string, diff: string) {
  const hunks = diff.split(/^@@ /m).slice(1).flatMap((chunk) => {
    const match = /^-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n([\s\S]*)$/.exec(chunk)
    return match ? [{ oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), lines: match[5]!.trimEnd().split("\n") }] : []
  })
  return { oldFileName: file, newFileName: file, oldHeader: "old", newHeader: "new", hunks }
}
function safe(value: unknown): unknown {
  return redactValue(value, { keys: /^(apiKey|api_key|token|password|secret|authorization)$/i })
}

async function projectPath(directory: string, target: string) {
  const root = await realpath(directory)
  const full = path.resolve(root, target.startsWith("file:") ? fileURLToPath(target) : target)
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Access denied: path escapes project directory")
  const resolved = await realpath(full).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return full
    throw error
  })
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Access denied: symlink escapes project directory")
  return resolved
}

export function createDebug(input: { options: DaemonOptions; store: Store; agents: AgentRegistry; extensions: DaemonExtensions; customTools: CustomToolRegistry; skills: SkillLoader; id(): SessionId; paths(directory: string): unknown }) {
  const snapshots = createDebugSnapshots(input.options.dir)
  const changed = async (directory: string) => {
    try { return await readChanges(directory) } catch (error) { if (error instanceof NotGitError) return { files: [] }; throw error }
  }
  const toolsFor = async (directory: string, sessionId: SessionId): Promise<Tool[]> => {
    const tools = new Map(input.extensions.builtinTools().map((tool) => [tool.name, tool]))
    for (const tool of [...await input.customTools.tools(directory), ...await input.extensions.tools(directory, sessionId)]) tools.set(tool.name, tool)
    return [...tools.values()]
  }
  async function execute(directory: string, query: DebugInput): Promise<unknown> {
    switch (query.operation) {
      case "config": return { settings: input.store.settings.get(), agents: input.agents.report({ directory }), paths: input.paths(directory) }
      case "paths": return input.paths(directory)
      case "info": return { runtime: "MendCode", engine: input.options.info?.engine ?? "unknown", buildId: input.options.buildId ?? null, os: `${os.type()} ${os.release()} ${os.arch()}`, terminal: [process.env.TERM_PROGRAM, process.env.TERM].filter(Boolean).join(" / ") || "unknown", plugins: (await input.extensions.list(directory)).map((entry) => ({ name: entry.name, source: entry.source, trusted: entry.trusted, errors: entry.errors })) }
      case "startup": return { elapsedMs: performance.now() }
      case "projects": {
        const projects = new Map<string, { id: string; directory: string; sessions: number; updatedAt: number }>()
        let offset = 0
        while (offset < 10000) {
          const sessions = input.store.listSessions({ roots: false, limit: 500, offset })
          for (const session of sessions) {
            const project = projects.get(session.directory) ?? { id: session.directory, directory: session.directory, sessions: 0, updatedAt: 0 }
            project.sessions++
            project.updatedAt = Math.max(project.updatedAt, session.updatedAt)
            projects.set(session.directory, project)
          }
          offset += sessions.length
          if (sessions.length < 500) return { projects: [...projects.values()], truncated: false }
        }
        return { projects: [...projects.values()], truncated: true }
      }
      case "skills": return input.skills.list(directory).map((entry) => ({ ...entry, enabled: input.skills.enabled(directory, entry.name) }))
      case "agent": {
        const agent = input.agents.inspect(directory, query.name)
        if (!agent) throw new Error(`Agent ${query.name} not found or untrusted`)
        const settings: Settings = input.store.settings.get()
        const rules = policyRules(settings, agent.permissionRules)
        const sessionId = "ses_debug" as SessionId
        const available = await toolsFor(directory, sessionId)
        const allowed = (tool: Tool) => agentAllows(agent, tool.name) && !toolDisabled(tool.name, rules) && !(agent.permission === "plan" && tool.permission !== "read")
        if (!query.tool) return { ...agent, tools: Object.fromEntries(available.map((tool) => [tool.name, allowed(tool)])) }
        const tool = available.find((tool) => tool.name === query.tool)
        if (!tool) throw new Error(`Tool ${query.tool} not found for agent ${query.name}`)
        if (!allowed(tool)) throw new Error(`Tool ${query.tool} is disabled for agent ${query.name}`)
        if (!query.approve) throw new Error("Debug tool execution requires --approve")
        const params = tool.args.parse(query.params ?? {})
        const permission = permissionName(tool.name)
        const patterns = permissionPatterns(tool.name, params, directory)
        if (patterns.some((pattern) => matchingRule(permission, pattern, rules)?.action === "deny") || externalPatterns(tool.name, params, directory).some((pattern) => matchingRule("external_directory", pattern, rules)?.action === "deny")) throw new Error("Tool denied by permission rule")
        const id = input.id()
        input.store.createSession({ id, directory, title: `Debug tool run (${query.name})` })
        const scoped = (await toolsFor(directory, id)).find((entry) => entry.name === tool.name)!
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        try {
          const result = await scoped.execute(params, { cwd: directory, signal: controller.signal, ask: async () => ({ answered: false, reason: "debug tool runs cannot answer questions" }) })
          return { tool: tool.name, input: params, result: { output: result.output, title: result.title, truncated: result.truncated, isError: result.isError }, sessionId: id }
        } finally { clearTimeout(timer) }
      }
      case "file.search": return (await searchFiles({ directory, query: query.query, limit: 100 })).files.map((file) => file.path + (file.kind === "dir" ? "/" : ""))
      case "file.status": return (await changed(directory)).files.map((file) => ({ path: file.path, added: file.additions, removed: file.deletions, status: file.status === "untracked" ? "added" : file.status }))
      case "file.tree": {
        const target = await projectPath(directory, query.path)
        return queryFiles({ directory: target, operation: "tree", limit: 200 })
      }
      case "file.list": {
        const target = await projectPath(directory, query.path)
        const entries = (await readdir(target, { withFileTypes: true })).filter((entry) => ![".git", ".DS_Store"].includes(entry.name))
        const nodes = entries.slice(0, 1000).map((entry) => ({ name: entry.name, path: path.relative(directory, path.join(target, entry.name)), absolute: path.join(target, entry.name), type: entry.isDirectory() ? "directory" : "file", ignored: false }))
        // Git owns ignore semantics (including nested rules) rather than a second parser.
        if (nodes.length && Bun.which("git")) {
          const child = Bun.spawn(["git", "check-ignore", "--no-index", "-z", "--stdin"], { cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
          child.stdin.write(nodes.map((node) => node.path + (node.type === "directory" ? "/" : "")).join("\0") + "\0")
          child.stdin.end()
          const output = await new Response(child.stdout).text()
          await child.exited
          const ignored = new Set(output.split("\0").map((file) => file.replace(/\/$/, "")))
          for (const node of nodes) node.ignored = ignored.has(node.path)
        }
        return { nodes: nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1), truncated: entries.length > nodes.length }
      }
      case "file.read": {
        const target = await projectPath(directory, query.path)
        const info = await stat(target).catch(() => undefined)
        if (!info) return { type: "text", content: "" }
        if (!info.isFile()) throw new Error("path is not a file")
        const handle = await open(target, "r")
        let bytes: Buffer
        try { const buffer = Buffer.alloc(Math.min(info.size, 24_000)); const read = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, read.bytesRead) } finally { await handle.close() }
        const truncated = info.size > bytes.length
        const mimeType = Bun.file(target).type
        if (mimeType.startsWith("image/")) return { type: "text", content: bytes.toString("base64"), mimeType, encoding: "base64", truncated }
        if (bytes.subarray(0, 8000).includes(0)) return { type: "binary", content: "", mimeType, truncated }
        const content = bytes.toString("utf8").trim()
        const file = (await changed(directory)).files.find((file) => path.resolve(directory, file.path) === target)
        const diff = file?.diff.slice(0, 10000)
        return { type: "text", content, ...(diff ? { patch: filePatch(file!.path, diff), diff: `--- ${file!.path}\told\n+++ ${file!.path}\tnew\n${diff}` } : {}), truncated: truncated || file?.truncated === true || (file?.diff.length ?? 0) > 10000 }
      }
      case "lsp.diagnostics": {
        if (!input.options.lsp?.diagnostics) throw new Error("LSP diagnostics is not available")
        const result = await input.options.lsp.diagnostics({ path: await projectPath(directory, query.path), cwd: directory })
        if ("unavailable" in result) throw new Error(result.unavailable)
        return { diagnostics: { [result.file]: result.diagnostics }, settled: result.settled }
      }
      case "lsp.document-symbols": {
        if (!input.options.lsp) throw new Error("LSP is not available")
        const report = await input.options.lsp.query({ cwd: directory, operation: "documentSymbol", filePath: await projectPath(directory, query.path), line: 1, character: 1 })
        if (report.unavailable) throw new Error(report.unavailable)
        return report.result
      }
      case "lsp.symbols": {
        if (!input.options.lsp) throw new Error("LSP is not available")
        const files = await queryFiles({ directory, operation: "files", limit: 10000 })
        const seen = new Set<string>(), results: unknown[] = []
        let successful = false
        for (const filePath of files.lines) {
          const extension = path.extname(filePath)
          if (!extension || seen.has(extension)) continue
          seen.add(extension)
          const report = await input.options.lsp.query({ cwd: directory, operation: "workspaceSymbol", filePath, line: 1, character: 1, query: query.query })
          if (!report.unavailable) { successful = true; results.push(...report.result) }
          if (seen.size >= 30) break
        }
        if (!successful) throw new Error("No LSP server available for workspace files")
        return [...new Map(results.map((item) => [JSON.stringify(item), item])).values()]
      }
      case "snapshot.track": return snapshots(directory, query.operation)
      case "snapshot.patch":
      case "snapshot.diff": return snapshots(directory, query.operation, query.hash)
    }
  }
  return async (directory: string, query: DebugInput): Promise<DebugReport> => {
    const data = safe(await execute(directory, query))
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) throw new Error("debug output exceeds 120 KB; narrow the query")
    return { operation: query.operation, data }
  }
}

export * from "./tool"
export * from "./util"
export { canonicalDir, createCustomToolRegistry, CUSTOM_TOOL_PREFIX, DEFAULT_CUSTOM_TIMEOUT_MS, MAX_CUSTOM_TIMEOUT_MS } from "./custom-tools"
export type { CustomTool, CustomToolInfo, CustomToolIssue, CustomToolRegistry, CustomToolSource } from "./custom-tools"
export { compileArgsSchema, SchemaError } from "./json-schema"
export { runManaged } from "./process"
export { defaultShell, isSignalablePid, killProcessTree, shellArgv, shellFamily, shellSpawnOptions, type ShellFamily } from "./platform-shell"
export { agentDataDir, agentLimitPrefix, agentProcesses, agentShellEnvironment, agentShellLaunch, ownerCommandRefusal } from "./agent-origin"
export { applyShellEnvironment, withShellPrefix, type ShellEnvironmentPolicy, type ShellPolicy } from "./shell-policy"
export { domainAllowed, domainRules, type WebPolicy } from "./web-policy"
export type { ManagedResult } from "./process"

import type { Tool, ToolContext, ToolResult } from "./tool"
import applyPatch from "./tools/apply_patch"
import edit from "./tools/edit"
import glob from "./tools/glob"
import grep from "./tools/grep"
import ls from "./tools/ls"
import read from "./tools/read"
import review from "./tools/review"
import screenshot, { createScreenshotTool } from "./tools/screenshot"
import shell from "./tools/shell"
import shellKill from "./tools/shell_kill"
import shellOutput, { describeTask } from "./tools/shell_output"
import shellMonitor from "./tools/shell_monitor"
import shellSession, { describeSession, isBareShell } from "./tools/shell_session"
import notebookEdit from "./tools/notebook_edit"
import sleep from "./tools/sleep"
import taskStatus from "./tools/task_status"
import webfetch from "./tools/webfetch"
import write from "./tools/write"

export { applyPatch, edit, glob, grep, ls, notebookEdit, read, review, screenshot, shell, shellKill, shellMonitor, shellOutput, shellSession, sleep, taskStatus, webfetch, write }
export { describeTask, describeSession, isBareShell }
export * from "./background"
export * from "./interactive"
export * from "./sandbox"
export { loopTool } from "./tools/loop"
export { worktreeTool } from "./tools/worktree"
export { prWatchTool } from "./tools/pr_watch"
export { createScreenshotTool, runCommand } from "./tools/screenshot"
export { createToolDefine } from "./tools/tool_define"
export { bindRenderTemplate, renderTemplateProblems } from "./render-bind"
export type { CommandOutput, CommandRunner } from "./tools/screenshot"
export { htmlToMarkdown, htmlToText } from "./html-to-text"
export { WEBFETCH_ALLOW_PRIVATE_ENV } from "./tools/webfetch"
export { GREP_FALLBACK_ENV } from "./tools/grep"
export { GLOB_MAX_ENTRIES_ENV } from "./tools/glob"
export { exitOneMeaning } from "./exit-meaning"
// Key-gated tools: not in BUILTIN_TOOLS; the host adds them when the factory returns a tool.
export { createWebSearchTool, selectWebSearchProvider, WEBSEARCH_ENV, WEBSEARCH_OPENROUTER_MODEL_ENV } from "./tools/websearch"
export type { SearchResult } from "./tools/websearch"
export { createImageGenTool, selectImageProvider, IMAGE_GEN_ENV, IMAGE_GEN_MODEL_ENV } from "./tools/image_gen"
export type { FetchLike } from "./tools/api_http"
export { readInstructions } from "./read-instructions"
export { createInstructionLoader, instructionChain, instructionFileIn, collectInstructions, readInstructionFile, newInstructionState, INSTRUCTION_FILES, INSTRUCTION_OVERRIDE, MAX_INSTRUCTION_CHARS, MAX_INSTRUCTION_TOTAL_CHARS, MAX_INSTRUCTION_FILES } from "./instructions"
export type { InstructionOptions, InstructionSection, InstructionState } from "./instructions"

/** `shellSession` is not here: the daemon adds it only where a pseudo-terminal exists (see `interactive` in the daemon). */
export const BUILTIN_TOOLS: Tool[] = [read, write, edit, applyPatch, notebookEdit, glob, grep, ls, review, shell, shellOutput, shellKill, shellMonitor, taskStatus, sleep, webfetch, screenshot]

/** Validate raw model arguments against the tool's schema, then execute; validation failures become isError results. */
export async function runTool(tool: Tool, rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
  const parsed = tool.args.safeParse(rawArgs)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ")
    return { output: `invalid arguments: ${issues}`, truncated: false, title: tool.name, isError: true }
  }
  return tool.execute(parsed.data, context)
}

export type { ReviewPort } from "./tool"
export { aiConfigTool } from "./tools/ai_config"
export { imageModelRef } from "./tools/image_api"
export type { ImageApiCredentials } from "./tools/image_api"
export { createComputerTools } from "./tools/computer"
export type { ComputerPort } from "./tools/computer"
export { createComputerSessionTools } from "./tools/computer-session"
export type { ComputerActivation } from "./tools/computer-session"
// Opt-in (MENDCODE_BROWSER=1): the daemon adds it and supplies the headless browser port.
export { default as browserTool } from "./tools/browser"
export * from "./browser"
export { createWebRouting, type WebRoute } from "./web-routing"

import { homedir } from "node:os"
import path from "node:path"
import type { PermissionConfig, PermissionRule, Settings } from "@mendcode/protocol"
import { commandSubstitutions, MAX_SHELL_DEPTH, programName, withoutTransparentWrappers, wrappedScript, xargsCommand } from "./shell-script"
import { asShellCall, insideProject, projectRoot, realOf, splitCommand } from "./smart-permissions"

const EDIT = new Set(["edit", "write", "apply_patch", "patch", "notebook_edit"])
export const permissionName = (tool: string) => EDIT.has(tool) ? "edit" : tool === "shell" || tool === "shell_session" ? "bash" : tool === "todo" ? "todowrite" : tool === "web_search" ? "websearch" : tool

export function permissionMatch(value: string, pattern: string): boolean {
  let regex = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  if (regex.endsWith(" .*")) regex = regex.slice(0, -3) + "( .*)?"
  return new RegExp(`^${regex}$`, process.platform === "win32" ? "si" : "s").test(value.replaceAll("\\", "/"))
}

export function expandPermissionPath(pattern: string): string {
  if (pattern === "~" || pattern === "$HOME") return homedir()
  if (pattern.startsWith("~/")) return homedir() + pattern.slice(1)
  if (pattern.startsWith("$HOME/")) return homedir() + pattern.slice(5)
  return pattern
}

export function configRules(config: PermissionConfig | undefined): PermissionRule[] {
  if (!config) return []
  if (typeof config === "string") return [{ permission: "*", pattern: "*", action: config }]
  return Object.entries(config).flatMap(([permission, value]) => typeof value === "string"
    ? [{ permission: permissionName(permission), pattern: "*", action: value }]
    : Object.entries(value).map(([pattern, action]) => ({ permission: permissionName(permission), pattern: expandPermissionPath(pattern), action })))
}

/** Rules of one session (REST `permission`) come last, so they refine the settings and agent rules for that session only. */
/** The rules saved for one project (`projectConfig[directory].permission`, written by "always allow in this project"). */
export function projectRulesOf(settings: object, directory: string | undefined): PermissionRule[] {
  const projects = (settings as Pick<Settings, "projectConfig">).projectConfig
  if (!directory || !projects) return []
  const absolute = path.resolve(directory)
  const config = projects[realOf(absolute)] ?? projects[absolute]
  return configRules(config?.permission)
}

export function policyRules(settings: Pick<Settings, "tools" | "permission">, agent?: readonly PermissionRule[], session?: readonly PermissionRule[], project?: readonly PermissionRule[]): PermissionRule[] {
  return [
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    ...Object.entries(settings.tools ?? {}).map(([tool, enabled]): PermissionRule => ({ permission: permissionName(tool), pattern: "*", action: enabled ? "allow" : "deny" })),
    ...configRules(settings.permission),
    // Saved project rules refine the user's rules (an "always allow" beats a broader ask) but never a user deny.
    ...(project?.length ? [...project, ...configRules(settings.permission).filter((rule) => rule.action === "deny")] : []),
    ...(agent ?? []).map((rule) => ({ ...rule, permission: permissionName(rule.permission), pattern: expandPermissionPath(rule.pattern) })),
    ...(session ?? []).map((rule) => ({ ...rule, permission: permissionName(rule.permission), pattern: expandPermissionPath(rule.pattern) })),
  ]
}

/**
 * The shell patterns of a call (as `permissionPatterns` returns them) whose real command only exists after expansion:
 * `$(…)`, backticks, `$VAR` and `<(…)` outside single quotes. A wildcard allow rule (`ls *`) cannot vouch for them.
 */
export function expandedShellPatterns(toolName: string, rawArgs: unknown): Set<string> {
  const { tool, args } = asShellCall(toolName, rawArgs)
  const command = ((args ?? {}) as Record<string, unknown>).command
  if (tool !== "shell" || typeof command !== "string") return new Set()
  return new Set(splitCommand(command).filter((segment) => segment.expansion).map((segment) => segment.words.map((word) => word.text).join(" ")))
}

/**
 * The simple commands hidden inside a shell call, as patterns: what `bash -lc '…'`, `eval '…'`, `trap '…'`, `xargs …`, `timeout 5 …`
 * and `$(…)`/backticks run. `permissionPatterns` names only the outer command (`bash -c rm x`), so `rm *` would never match it.
 * Used for `deny` and `ask` rules only; an allow rule on the outer command never vouches for what it wraps (Codex splits
 * `bash -lc` the same way before matching its prefix rules).
 */
export function nestedShellPatterns(toolName: string, rawArgs: unknown): string[] {
  const { tool, args } = asShellCall(toolName, rawArgs)
  const command = ((args ?? {}) as Record<string, unknown>).command
  if (tool !== "shell" || typeof command !== "string") return []
  const found = new Set<string>()
  const visit = (line: string, depth: number) => {
    if (depth > MAX_SHELL_DEPTH) return
    for (const segment of splitCommand(line)) {
      const texts = segment.words.map((word) => word.text)
      const words = withoutTransparentWrappers(texts)
      if (depth > 0 && texts.length) found.add(texts.join(" "))
      if (words.length && words.length < texts.length) found.add(words.join(" "))
      const script = wrappedScript(words)
      if (script !== undefined) visit(script, depth + 1)
      const inner = words[0] !== undefined && programName(words[0]) === "xargs" ? xargsCommand(words) : []
      if (inner.length) {
        found.add(inner.join(" "))
        visit(inner.join(" "), depth + 1)
      }
    }
    for (const substituted of commandSubstitutions(line)) visit(substituted, depth + 1)
  }
  visit(command, 0)
  for (const pattern of permissionPatterns(toolName, rawArgs, "")) found.delete(pattern)
  return [...found]
}

/** `rule`, except that an allow with a wildcard pattern becomes an ask for a pattern that only exists after expansion. */
export function withoutBlindAllow(rule: PermissionRule | undefined, expanded: boolean): PermissionRule | undefined {
  return expanded && rule?.action === "allow" && rule.pattern !== "*" && /[*?]/.test(rule.pattern) ? { ...rule, action: "ask" } : rule
}

export function matchingRule(permission: string, pattern: string, rules: readonly PermissionRule[]): PermissionRule | undefined {
  return rules.findLast((rule) => permissionMatch(permission, rule.permission) && permissionMatch(pattern, rule.pattern))
}

export function toolDisabled(tool: string, rules: readonly PermissionRule[]): boolean {
  const rule = rules.findLast((rule) => permissionMatch(permissionName(tool), rule.permission))
  return rule?.pattern === "*" && rule.action === "deny"
}

export function toolPaths(tool: string, args: unknown): string[] {
  const record = (args ?? {}) as Record<string, unknown>
  if (tool === "apply_patch" && typeof record.patch === "string") return [...record.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]!.trim())
  if (tool === "image_gen") return [record.path, ...(Array.isArray(record.referenced_image_paths) ? record.referenced_image_paths : [])].filter((value): value is string => typeof value === "string")
  // `read` with several paths is judged on every one of them: a rule or an external-directory check on any entry applies to the call.
  const listed = tool === "read" && Array.isArray(record.paths) ? record.paths.map((entry) => (entry as { path?: unknown } | null)?.path) : []
  return [record.path, record.filePath, record.directory, ...listed].filter((value): value is string => typeof value === "string")
}

export function permissionPatterns(toolName: string, rawArgs: unknown, cwd: string): string[] {
  const { tool, args } = asShellCall(toolName, rawArgs)
  const record = (args ?? {}) as Record<string, unknown>
  if (tool === "shell" && typeof record.command === "string") {
    const commands = splitCommand(record.command).map((segment) => segment.words.map((word) => word.text).join(" "))
    return commands.length ? commands : ["*"]
  }
  // Navigation is matched by its URL (`browser: { "http://localhost:*": "allow" }`); the other steps by their action, so
  // an "always" grant for clicking never covers opening an arbitrary page.
  if (tool === "browser" && typeof record.action === "string") return [record.action === "navigate" && typeof record.url === "string" ? record.url : record.action]
  const paths = toolPaths(tool, args)
  if (paths.length) return [...new Set(paths.flatMap((target) => {
    const absolute = path.resolve(cwd, expandPermissionPath(target))
    return [absolute, realOf(absolute)]
  }))]
  // `glob` with several patterns is judged on every one of them, like `read` with several paths.
  if (tool === "glob" && Array.isArray(record.patterns)) {
    const listed = [record.pattern, ...record.patterns].filter((value): value is string => typeof value === "string")
    if (listed.length) return [...new Set(listed)]
  }
  for (const key of ["pattern", "agent", "subagent_type", "name", "url", "query"]) if (typeof record[key] === "string") return [record[key] as string]
  return ["*"]
}

/** Separate from the tool permission: reads and commands can cross the project boundary too. */
export function externalPatterns(toolName: string, rawArgs: unknown, cwd: string): string[] {
  const { tool, args } = asShellCall(toolName, rawArgs)
  const root = projectRoot(cwd)
  const record = (args ?? {}) as Record<string, unknown>
  const targets = toolPaths(tool, args).map((target) => ({ target, base: cwd, directory: ["list", "glob", "grep"].includes(tool) || target === record.directory }))
  if (["list", "glob", "grep"].includes(tool) && typeof record.path !== "string" && typeof record.directory !== "string") targets.push({ target: cwd, base: cwd, directory: true })
  if (tool === "shell") {
    let base = typeof record.workdir === "string" ? path.resolve(cwd, expandPermissionPath(record.workdir)) : cwd
    targets.push({ target: base, base: cwd, directory: true })
    for (const segment of splitCommand(typeof record.command === "string" ? record.command : "")) {
      const words = segment.words
      for (let i = 0; i < words.length; i++) {
        const word = words[i]!
        const target = word.text.startsWith("-") && word.text.includes("=") ? word.text.slice(word.text.indexOf("=") + 1) : word.text
        if (!target || target.startsWith("-") || /\w+:\/\//.test(target)) continue
        const directory = words[0]?.text === "cd" && i === 1
        if (directory || word.redirectTarget || target.includes("/") || target === ".." || target.startsWith("~")) targets.push({ target, base, directory })
      }
      if (words[0]?.text === "cd" && words[1]) base = path.resolve(base, expandPermissionPath(words[1].text))
    }
  }
  return [...new Set(targets.flatMap(({ target, base, directory }) => {
    const absolute = path.resolve(base, expandPermissionPath(target))
    if (["/dev/null", "/dev/stdout", "/dev/stderr"].includes(absolute) || insideProject(absolute, root)) return []
    const resolved = realOf(absolute)
    return [path.join(directory ? resolved : path.dirname(resolved), "*")]
  }))]
}

/** The declared extra workspace directories (`additionalDirectories` setting plus the session's `--add-dir`) as absolute paths; relative and empty entries are dropped. */
export function declaredRoots(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []).map((entry) => expandPermissionPath(entry)).filter((entry) => path.isAbsolute(entry)).map((entry) => path.resolve(entry)).filter((entry) => path.parse(entry).root !== entry))]
}

/** Splits `externalPatterns` output: patterns inside a declared directory (symlinks resolved) no longer ask, but an explicit `external_directory` deny still applies to them. */
export function splitDeclared(patterns: readonly string[], roots: readonly string[]): { external: string[]; declared: string[] } {
  const resolved = roots.map((root) => projectRoot(root))
  const external: string[] = []
  const declared: string[] = []
  for (const pattern of patterns) (resolved.some((root) => insideProject(path.dirname(pattern), root)) ? declared : external).push(pattern)
  return { external, declared }
}

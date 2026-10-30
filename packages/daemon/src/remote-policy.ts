import type { TurnOptions } from "@mendcode/protocol"

export function remoteExecutionCommand(type: string): boolean {
  return ["tools.trust", "packages.install", "packages.capture", "lsp.install", "packages.remove", "packages.restore", "packages.enable", "packages.resource", "packages.preview", "packages.install-catalog", "packages.install-source", "packages.add-source", "packages.remove-source", "packages.refresh", "packages.disable-all", "mcp.decide"].includes(type)
}

const EXECUTION_SETTINGS = ["acpAgents", "tier", "features", "experimental", "tools", "threadMcp", "disabledExtensions", "disabledPackages", "disabledPackageResources", "sandbox", "trustedToolDirs", "allowedHttpHookUrls", "permission", "permissionAllow", "smartSandboxTrust", "engineSafetyPrompts", "engineEnvironment", "ownLogins", "projectConfig"]
/** Proxy, shell and web policy: set on the machine that runs the commands, never by a remote client. */
export const REMOTE_HOST_SETTINGS = ["proxy", "shellEnvironment", "shellCommandPrefix", "loginShell", "web"]
/** Every key `settings.set` refuses to a remote or a peer client, whichever rule refuses it. */
const LOCAL_ONLY_SETTINGS = new Set([...EXECUTION_SETTINGS, ...REMOTE_HOST_SETTINGS, "additionalDirectories", "worktreeGcDays"])

/** Host execution switches cannot be changed by either kind of authenticated peer. */
export function remoteExecutionSettings(patch: object): boolean {
  return EXECUTION_SETTINGS.some((key) => key in patch)
}

/** The keys of `patch` only a local terminal may set. */
export function localOnlySettings(patch: object): string[] {
  return Object.keys(patch).filter((key) => LOCAL_ONLY_SETTINGS.has(key))
}

/** Native turns from a peer must not acquire the new host-local tool surfaces. */
export function remoteTurnOptions(options?: TurnOptions): TurnOptions {
  return { ...options, excludeTools: [...new Set([...(options?.excludeTools ?? []), "threads", "packages", "pr_watch", "session_meta", "graph_*", "webfetch", "memory", "memory_graph", "remember", "workflow_script"])] }
}

export function continuationTurnOptions(options: TurnOptions | undefined, restricted: boolean): TurnOptions | undefined {
  return restricted ? remoteTurnOptions(options) : options
}

import type { TurnOptions } from "@mendcode/protocol"

export function remoteExecutionCommand(type: string): boolean {
  return ["tools.trust", "profiles.install", "profiles.capture", "lsp.install", "profiles.remove", "profiles.restore", "profiles.enable", "profiles.resource", "profiles.preview", "profiles.install-catalog", "profiles.install-source", "profiles.add-source", "profiles.remove-source", "profiles.refresh", "profiles.disable-all", "mcp.decide"].includes(type)
}

const EXECUTION_SETTINGS = ["acpAgents", "remoteEngines", "tier", "features", "experimental", "tools", "threadMcp", "disabledExtensions", "disabledProfiles", "disabledProfileResources", "sandbox", "trustedToolDirs", "allowedHttpHookUrls", "permission", "permissionAllow", "smartSandboxTrust", "engineSafetyPrompts", "engineEnvironment", "ownLogins", "projectConfig"]
/** Proxy, shell and web policy: set on the machine that runs the commands, never by a remote client. */
export const REMOTE_HOST_SETTINGS = ["proxy", "shellEnvironment", "shellCommandPrefix", "loginShell", "web"]
/** Every key `settings.set` refuses to a remote or a peer client, whichever rule refuses it. */
const LOCAL_ONLY_SETTINGS = new Set([...EXECUTION_SETTINGS, ...REMOTE_HOST_SETTINGS, "additionalDirectories", "worktreeGcDays", "prReview"])

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
  return { ...options, excludeTools: [...new Set([...(options?.excludeTools ?? []), "threads", "profiles", "packages", "pr_watch", "review_config", "pr_review", "session_meta", "graph_*", "webfetch", "memory", "memory_graph", "remember", "workflow_script", "today"])] }
}

export function continuationTurnOptions(options: TurnOptions | undefined, restricted: boolean): TurnOptions | undefined {
  return restricted ? remoteTurnOptions(options) : options
}

/** Whether a full-access remote client may run turns on this engine key: the host lists "pi", "acp" (every configured agent) or "acp:<agent>" in the local-only `remoteEngines` setting. Nothing is listed by default. */
export function remoteEngineAllowed(allowed: readonly string[] | undefined, engine: string): boolean {
  if (!allowed?.length) return false
  return allowed.includes(engine) || engine.startsWith("acp:") && allowed.includes("acp")
}

const LOCAL_ONLY_NOTE = "[DAEMON]: this engine runs local tools and is local only"

/** Why a remote client may not run a turn on this model, or undefined. Opencode and Cursor are never remote; pi and ACP agents run only when the host lists them. */
export function remoteEngineRefusal(input: { engine: string | undefined; model: string; allowed: readonly string[] | undefined }): string | undefined {
  const { engine, model, allowed } = input
  if (engine === "opencode" || engine === "cursor") return LOCAL_ONLY_NOTE
  if (engine === "pi") return remoteEngineAllowed(allowed, "pi") ? undefined : `${LOCAL_ONLY_NOTE}; the host lists it in remoteEngines to allow it`
  if (model.startsWith("acp:")) return remoteEngineAllowed(allowed, model.split("/")[0]!) ? undefined : "[DAEMON]: ACP agents run local tools and are local only; the host lists them in remoteEngines to allow them"
  return undefined
}

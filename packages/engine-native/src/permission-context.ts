import { createHash } from "node:crypto"
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { TurnInput } from "@mendcode/kernel"
import type { ActionIdentity, AuthorityEvidence } from "@mendcode/protocol"
import { asShellCall } from "./smart-permissions"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export type AuthorityContext = AuthorityEvidence & { userText: string }
export type AuthorityAnchor = { sourceId: string; text: string; complete?: boolean }

export function authorityContext(input: TurnInput, history: readonly AuthorityAnchor[] = []): AuthorityContext {
  const source = input.authority ?? { sourceId: input.turnId, text: input.text }
  const unknownReasons = source.synthetic ? ["causal_user_message_missing"] : !source.text.trim() ? ["causal_user_text_missing"] : []
  const anchors = [...history.filter((anchor) => anchor.sourceId !== source.sourceId).slice(-11), ...(source.synthetic ? [] : [{ sourceId: source.sourceId, text: source.text }])]
  if (anchors.some((anchor) => anchor.complete === false)) unknownReasons.push("authority_anchor_incomplete")
  const text = anchors.map((anchor) => anchor.text.trim()).filter(Boolean).join("\n")
  if (text.length > 24_000) unknownReasons.push("context_budget_exceeded")
  const userText = text.slice(0, 24_000)
  const base = { sourceUserIds: [...(source.synthetic ? [] : [source.sourceId]), ...anchors.map((anchor) => anchor.sourceId)].filter((id, index, all) => all.indexOf(id) === index), objectiveEpoch: source.sourceId, contextRevision: 0, complete: unknownReasons.length === 0, unknownReasons }
  return { ...base, userText, fingerprint: digest({ ...base, userText }) }
}

const identity = (target: string) => {
  const resolved = realpathSync(target)
  const stat = statSync(resolved)
  return stat.isDirectory() ? `${resolved}:${stat.dev}:${stat.ino}` : `${resolved}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

/** Values stay in this call's memory; only the digest may leave the execution boundary. */
export function freezeAction(callTool: string, callArgs: unknown, project: string, environment: NodeJS.ProcessEnv = process.env, shell = "/bin/sh") {
  // An interactive session start binds its executable like the equivalent shell command; the fingerprint keeps the real call.
  const { tool, args } = asShellCall(callTool, callArgs)
  const env: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...environment, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" })
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {}
  const cwd = path.resolve(project, tool === "shell" && typeof record.workdir === "string" ? record.workdir : ".")
  const targets: string[] = []
  const unknownReasons: string[] = []
  const identities: string[] = []
  const add = (target: string) => {
    try {
      const value = identity(target)
      targets.push(target)
      identities.push(value)
    } catch { unknownReasons.push("execution_identity_missing") }
  }
  add(cwd)
  if (tool === "image_gen" && Array.isArray(record.referenced_image_paths)) for (const file of record.referenced_image_paths) if (typeof file === "string") add(path.resolve(cwd, file))
  if (tool === "shell") {
    add(shell)
    const command = typeof record.command === "string" ? record.command : ""
    // Complex shell evaluation is still reviewed manually; do not claim a complete execution graph.
    if (/[|;&<>$`\n]|\b(?:eval|exec|source)\b/.test(command)) unknownReasons.push("dynamic_execution_identity")
    const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? []
    const name = words[0]
    if (name && /^(?:env|sudo|nohup|timeout|xargs|nice|time)$/.test(path.basename(name))) unknownReasons.push("wrapped_execution_identity")
    if (!name || name.includes("=")) unknownReasons.push("execution_identity_missing")
    else if (!["cd", "echo", "printf", "pwd", "true", "false", "test"].includes(name)) {
      const candidates = name.includes("/") ? [path.resolve(cwd, name)] : (env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(cwd, dir, name))
      const executable = candidates.find((target) => { try { accessSync(target, constants.X_OK); return statSync(target).isFile() } catch { return false } })
      if (executable) add(executable)
      else unknownReasons.push("execution_identity_missing")
    }
    // Bind literal script files passed to common interpreters as well as the executable.
    if (name && /^(?:node|bun|python\d*|ruby|sh|bash|zsh)$/.test(path.basename(name))) {
      const script = words.slice(1).find((word) => !word.startsWith("-"))
      if (script && !["test", "run"].includes(script)) add(path.resolve(cwd, script))
      else unknownReasons.push("script_identity_unknown")
    }
  } else identities.push(`tool:${tool}`)
  const base = { cwd, executableIdentities: identities, complete: unknownReasons.length === 0, unknownReasons: [...new Set(unknownReasons)], ...(tool === "shell" ? { environmentDigest: digest(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) } : {}) }
  const action: ActionIdentity = { ...base, fingerprint: digest({ ...base, tool: callTool, args: callArgs }) }
  return {
    action,
    environment: env,
    unchanged: () => targets.every((target, index) => { try { return identity(target) === identities[index] } catch { return false } }),
  }
}

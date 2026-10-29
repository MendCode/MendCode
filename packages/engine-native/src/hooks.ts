import type { SessionId, TurnId } from "@mendcode/protocol"
import type { ModelMessage } from "./provider"

/** The engine's hook points. Names match the daemon extension hooks of the same name, but this package depends on no extension code. */
export type EngineHookName = "tool.before" | "tool.after" | "prompt.system" | "context" | "request.before" | "compact.before" | "compact.after" | "chat.params" | "chat.headers" | "permission.ask" | "shell.env" | "tool.definition" | "text.complete" | "compact.prompt" | "compact.continue" | "permission.request"

/** Where a hook runs: the session and the project root it works in. */
export type EngineHookRef = { sessionId: SessionId; cwd: string }

/**
 * Optional hook points of the native engine. Every method resolves (implementations isolate their own failures) and
 * `undefined` means "no change". The engine checks `has` (synchronous, a map lookup) before each call, so a daemon
 * without hooks adds no await to a tool call or a model request.
 */
export interface EngineHooks {
  /** Called once when a turn, `!command` or compaction starts, before anything else: loads what the project needs. */
  prepare?(ref: EngineHookRef): Promise<void>
  /** Whether any handler of `hook` is active for the project at `cwd`. */
  has(hook: EngineHookName, cwd: string): boolean
  /** Before a tool runs (after approval): refuse it with `block` (the reason becomes the tool's error) or replace its `args`. */
  toolBefore?(event: EngineHookRef & { turnId: TurnId; tool: string; callId: string; itemId?: string; args: Record<string, unknown> }): Promise<{ block?: string; args?: Record<string, unknown> } | undefined>
  /** After a tool ran: replace what the model sees. */
  toolAfter?(event: EngineHookRef & { turnId: TurnId; tool: string; callId: string; itemId?: string; args: Record<string, unknown>; output: string; isError: boolean; title?: string; meta?: Record<string, unknown> }): Promise<{ output?: string; isError?: boolean; title?: string; meta?: Record<string, string | number | boolean> } | undefined>
  /** The system prompt of the next model call; a string replaces it. `role` is the model role of the call. */
  system?(event: EngineHookRef & { role: string; system: string }): Promise<string | undefined>
  /** The messages of the next model call (a copy); an array replaces them. */
  context?(event: EngineHookRef & { role: string; messages: ModelMessage[] }): Promise<ModelMessage[] | undefined>
  /** The provider request body right before it is sent; an object replaces it. */
  requestBody?(event: EngineHookRef & { provider: string; model: string; body: Record<string, unknown> }): Promise<Record<string, unknown> | undefined>
  /** Before a compaction: `cancel` skips it, `summary` is used instead of asking the model. */
  compactBefore?(event: EngineHookRef & { reason: "auto" | "manual"; tokens: number }): Promise<{ cancel?: true; summary?: string } | undefined>
  compactAfter?(event: EngineHookRef & { summary: string; reason?: "auto" | "manual" }): Promise<void>
  parameters?(event: EngineHookRef & { provider: string; model: string; role: string; parameters: Record<string, unknown> }): Promise<{ parameters?: Record<string, unknown>; maxOutputTokens?: number } | undefined>
  headers?(event: EngineHookRef & { provider: string; model: string; role: string }): Promise<Pick<import("./provider").ModelRequest, "headers" | "fetch"> | undefined>
  permission?(event: EngineHookRef & { tool: string; args: Record<string, unknown> }): Promise<{ status: "ask" | "deny" | "allow" } | undefined>
  /** Right before the user is asked to approve a call (the `PermissionRequest` shell hook): `deny` refuses it without asking. Nothing here can approve. */
  permissionRequest?(event: EngineHookRef & { tool: string; args: Record<string, unknown>; detail: string }): Promise<{ deny: string } | undefined>
  environment?(event: EngineHookRef): Promise<Record<string, string> | undefined>
  definition?(event: EngineHookRef & { tool: string; description: string; parameters: Record<string, unknown> }): Promise<{ description: string; parameters: Record<string, unknown> } | undefined>
  textComplete?(event: EngineHookRef & { itemId: string; text: string }): Promise<string | undefined>
  compactPrompt?(event: EngineHookRef & { prompt: string }): Promise<string | undefined>
  compactContinue?(event: EngineHookRef): Promise<boolean | undefined>
}

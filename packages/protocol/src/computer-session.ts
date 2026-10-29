import { z } from "zod"
import { lazySchema } from "./lazy"

export const ComputerTarget = lazySchema(() => z.strictObject({
  pid: z.number().int().positive(),
  bundleID: z.string().min(1).max(256),
  appName: z.string().max(256),
  windowName: z.string().max(256).optional(),
  windowID: z.string().min(1).max(128).optional(),
}))
export type ComputerTarget = z.infer<typeof ComputerTarget>

export const ComputerNode = lazySchema(() => z.strictObject({
  id: z.string().regex(/^0(?:\.[1-9]\d*){0,12}$/),
  role: z.string().max(256),
  name: z.string().max(256),
  value: z.string().max(256).optional(),
  secure: z.literal(true).optional(),
  states: z.array(z.string().max(64)).max(16),
  actions: z.array(z.enum(["press", "setValue", "click", "typeText", "key", "scroll", "drag"])).max(7),
  bounds: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }).optional(),
}))
export type ComputerNode = z.infer<typeof ComputerNode>

export const ComputerSessionInput = lazySchema(() => z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start"), mode: z.enum(["observe", "control"]), bootstrapCaptureID: z.string().uuid().optional(), bundleID: z.string().min(1).max(256).optional() }).refine((input) => Boolean(input.bootstrapCaptureID) !== Boolean(input.bundleID), "Supply exactly one bootstrapCaptureID or bundleID"),
  z.strictObject({ action: z.literal("stop"), computerSessionID: z.string().uuid() }),
  z.strictObject({ action: z.literal("apps") }),
]))
export type ComputerSessionInput = z.infer<typeof ComputerSessionInput>
export const ComputerObserveInput = lazySchema(() => z.strictObject({ computerSessionID: z.string().uuid(), screenshot: z.boolean().optional() }))
export type ComputerObserveInput = z.infer<typeof ComputerObserveInput>
export const ComputerCodeInput = lazySchema(() => z.strictObject({ computerSessionID: z.string().uuid(), code: z.string().min(1).max(32768).refine((code) => Buffer.byteLength(code, "utf8") <= 32768, "Computer code exceeds 32 KiB") }))
export type ComputerCodeInput = z.infer<typeof ComputerCodeInput>

export const ComputerActionInput = lazySchema(() => z.strictObject({
  revision: z.number().int().positive(),
  nodeID: ComputerNode.shape.id,
  value: z.string().max(32768).optional(),
  key: z.enum(["tab", "escape", "enter", "space", "left", "right", "down", "up", "backspace", "delete", "home", "end", "pageUp", "pageDown", "a", "c", "v", "x", "z", "s", "f", "l", "n", "w"]).optional(),
  modifiers: z.array(z.enum(["command", "shift", "option", "control"])).max(4).optional(),
  button: z.enum(["left", "right"]).optional(),
  count: z.number().int().min(1).max(2).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().int().min(1).max(1000).optional(),
  toNodeID: ComputerNode.shape.id.optional(),
}))
export type ComputerActionInput = z.infer<typeof ComputerActionInput>
export type ComputerWindow = { id: string; name: string; bounds?: ComputerNode["bounds"] }
export type ComputerApp = { bundleID: string; appName: string; pid?: number }

export type ComputerSessionReport = {
  computerSessionID: string
  stopped: boolean
  target: ComputerTarget | null
  mode: "observe" | "control" | null
  expiresAt?: number
  idleExpirySeconds?: number
  apps?: ComputerApp[]
}
export type ComputerObservation = { revision: number; target: ComputerTarget; nodes: ComputerNode[]; truncated: boolean; observedAt: number; screenshotFallback?: string }
export type ComputerCodeReport = { ok: boolean; value?: unknown; error?: { kind: string; message: string }; toolCalls: { name: string }[]; logs?: string[]; truncated?: boolean }

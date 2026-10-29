import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { lazySchema } from "./lazy"

export const PtyId = z.string().regex(/^pty_[a-f0-9]{32}$/)
const text = (max: number) => z.string().max(max).refine((value) => !value.includes("\0"))
export const PtyInfo = lazySchema(() => z.strictObject({
  id: PtyId,
  title: text(200),
  command: text(4096),
  args: z.array(text(4096)).max(64),
  cwd: text(4096),
  status: z.enum(["running", "exited"]),
  pid: z.number().int().positive(),
}))
export type PtyInfo = z.infer<typeof PtyInfo>
export const PtyCreateInput = lazySchema(() => z.strictObject({
  command: text(4096).optional(),
  args: z.array(text(4096)).max(64).optional(),
  cwd: text(4096).optional(),
  title: text(200).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), text(8192)).refine((value) => Object.keys(value).length <= 128).optional(),
}))
export type PtyCreateInput = z.infer<typeof PtyCreateInput>
export const PtyUpdateInput = lazySchema(() => z.strictObject({
  title: text(200).optional(),
  size: z.strictObject({ rows: z.number().int().min(1).max(1000), cols: z.number().int().min(1).max(1000) }).optional(),
}))
export type PtyUpdateInput = z.infer<typeof PtyUpdateInput>
export const PtyShell = lazySchema(() => z.strictObject({ path: z.string(), name: z.string(), acceptable: z.boolean() }))
export type PtyShell = z.infer<typeof PtyShell>
export const PtyConnectToken = lazySchema(() => z.strictObject({ ticket: z.string().min(1).max(128), expires_in: z.number().int().positive() }))
export type PtyConnectToken = z.infer<typeof PtyConnectToken>

const base = { id: CommandId, clientId: ClientId, directory: z.string().min(1).max(4096) }
export const PtyShells = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.shells") }))
export const PtyList = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.list") }))
export const PtyCreate = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.create"), input: PtyCreateInput }))
export const PtyGet = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.get"), ptyId: PtyId }))
export const PtyUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.update"), ptyId: PtyId, input: PtyUpdateInput }))
export const PtyRemove = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.remove"), ptyId: PtyId }))
export const PtyTicket = lazySchema(() => z.strictObject({ ...base, type: z.literal("pty.connect-token"), ptyId: PtyId }))

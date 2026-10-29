import { z } from "zod"
import { ClientId, CommandId, SessionId } from "./ids"
import { MAX_DRAFT_CHARS } from "./constants"
import { lazySchema } from "./lazy"

export const TuiPromptAppend = lazySchema(() => z.strictObject({ text: z.string().max(MAX_DRAFT_CHARS) }))
export const TuiCommandExecute = lazySchema(() => z.strictObject({ command: z.string().min(1).max(200) }))
export const TuiToastShow = lazySchema(() => z.strictObject({
  title: z.string().max(200).optional(),
  message: z.string().max(8000),
  variant: z.enum(["info", "success", "warning", "error"]),
  duration: z.number().int().min(1).max(120_000).default(5000),
}))
export const TuiSessionSelect = lazySchema(() => z.strictObject({ sessionID: SessionId }))
export const TuiPublish = lazySchema(() => z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("tui.prompt.append"), properties: TuiPromptAppend }),
  z.strictObject({ type: z.literal("tui.command.execute"), properties: TuiCommandExecute }),
  z.strictObject({ type: z.literal("tui.toast.show"), properties: TuiToastShow }),
  z.strictObject({ type: z.literal("tui.session.select"), properties: TuiSessionSelect }),
]))
export type TuiPublish = z.infer<typeof TuiPublish>

export const TuiRequestInput = lazySchema(() => z.discriminatedUnion("path", [
  z.strictObject({ path: z.literal("/tui/append-prompt"), body: TuiPromptAppend }),
  z.strictObject({ path: z.literal("/tui/execute-command"), body: TuiCommandExecute }),
  z.strictObject({ path: z.literal("/tui/show-toast"), body: TuiToastShow }),
  z.strictObject({ path: z.literal("/tui/select-session"), body: TuiSessionSelect }),
  z.strictObject({ path: z.literal("/tui/publish"), body: TuiPublish }),
  z.strictObject({ path: z.enum(["/tui/open-help", "/tui/open-sessions", "/tui/open-themes", "/tui/open-models", "/tui/submit-prompt", "/tui/clear-prompt"]), body: z.strictObject({}).default({}) }),
]))
export type TuiRequestInput = z.infer<typeof TuiRequestInput>
export const TuiRequest = lazySchema(() => z.strictObject({ requestID: CommandId, request: TuiRequestInput }))
export type TuiRequest = z.infer<typeof TuiRequest>
export const TuiResponseBody = lazySchema(() => z.union([z.boolean(), z.strictObject({ requestID: CommandId, response: z.boolean() })]))

const base = { id: CommandId, clientId: ClientId, directory: z.string().min(1).max(4096) }
export const TuiControlRegister = lazySchema(() => z.strictObject({ ...base, type: z.literal("tui.control.register"), enabled: z.boolean() }))
export const TuiControlSend = lazySchema(() => z.strictObject({ ...base, type: z.literal("tui.control.send"), request: TuiRequestInput }))
export const TuiControlNext = lazySchema(() => z.strictObject({ ...base, type: z.literal("tui.control.next"), timeoutMs: z.number().int().min(1).max(25_000).default(25_000) }))
export const TuiControlResponse = lazySchema(() => z.strictObject({ ...base, type: z.literal("tui.control.response"), requestID: CommandId.optional(), response: z.boolean() }))

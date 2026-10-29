import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { lazySchema } from "./lazy"

const text = z.string().max(4096)
const count = z.number().int().nonnegative()
export const FindTextQuery = lazySchema(() => z.strictObject({ pattern: text }))
export const FindFileQuery = lazySchema(() => z.strictObject({ query: text, dirs: z.enum(["true", "false"]).optional(), type: z.enum(["file", "directory"]).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }))
export const FindSymbolQuery = lazySchema(() => z.strictObject({ query: text }))
export const FilePathQuery = lazySchema(() => z.strictObject({ path: text }))
export const FileRestInput = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("find.text"), ...FindTextQuery.shape }),
  z.strictObject({ operation: z.literal("find.files"), query: text, dirs: z.boolean().optional(), type: z.enum(["file", "directory"]).optional(), limit: z.number().int().min(1).max(200).optional() }),
  z.strictObject({ operation: z.literal("find.symbols"), ...FindSymbolQuery.shape }),
  z.strictObject({ operation: z.literal("file.list"), ...FilePathQuery.shape }),
  z.strictObject({ operation: z.literal("file.read"), ...FilePathQuery.shape }),
  z.strictObject({ operation: z.literal("file.status") }),
]))
export type FileRestInput = z.infer<typeof FileRestInput>
export const FileRestRead = lazySchema(() => z.strictObject({ id: CommandId, clientId: ClientId, type: z.literal("file.rest.read"), directory: z.string().min(1).max(4096), input: FileRestInput }))

/** Native extension, off unless the HTTP server opts in with `edit`: exact text read and compare-and-swap write for the browser editor. */
export const FileEditInput = lazySchema(() => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read"), path: text.min(1) }),
  z.strictObject({ operation: z.literal("write"), path: text.min(1), content: z.string().max(120_000), expected: z.string().regex(/^[a-f0-9]{64}$/).nullable() }),
]))
export type FileEditInput = z.infer<typeof FileEditInput>
export const FileEdit = lazySchema(() => z.strictObject({ id: CommandId, clientId: ClientId, type: z.literal("file.edit"), directory: z.string().min(1).max(4096), input: FileEditInput }))
/** `sha256` is null when the file does not exist yet; pass it back as `expected` to create it. */
export const FileEditResult = lazySchema(() => z.strictObject({ path: z.string(), content: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bytes: z.number().int().nonnegative() }))
export type FileEditResult = z.infer<typeof FileEditResult>

export const FileSearchMatch = lazySchema(() => z.strictObject({
  path: z.strictObject({ text: z.string() }), lines: z.strictObject({ text: z.string() }),
  line_number: count, absolute_offset: count,
  submatches: z.array(z.strictObject({ match: z.strictObject({ text: z.string() }), start: count, end: count })),
}))
export const FileNode = lazySchema(() => z.strictObject({ name: z.string(), path: z.string(), absolute: z.string(), type: z.enum(["file", "directory"]), ignored: z.boolean() }))
export const FileStatus = lazySchema(() => z.strictObject({ path: z.string(), added: count, removed: count, status: z.enum(["added", "deleted", "modified"]) }))
export const FilePatch = lazySchema(() => z.strictObject({
  oldFileName: z.string(), newFileName: z.string(), oldHeader: z.string().optional(), newHeader: z.string().optional(), index: z.string().optional(),
  hunks: z.array(z.strictObject({ oldStart: count, oldLines: count, newStart: count, newLines: count, lines: z.array(z.string()) })),
}))
export const FileContent = lazySchema(() => z.strictObject({ type: z.enum(["text", "binary"]), content: z.string(), diff: z.string().optional(), patch: FilePatch.optional(), encoding: z.literal("base64").optional(), mimeType: z.string().optional() }))
const position = lazySchema(() => z.strictObject({ line: count, character: count }))
export const FileSymbol = lazySchema(() => z.object({ name: z.string(), kind: count, location: z.strictObject({ uri: z.string(), range: z.strictObject({ start: position, end: position }) }) }))
export type FileSearchMatch = z.infer<typeof FileSearchMatch>
export type FileNode = z.infer<typeof FileNode>
export type FileStatus = z.infer<typeof FileStatus>
export type FileContent = z.infer<typeof FileContent>
export type FileSymbol = z.infer<typeof FileSymbol>
export type FileRestValues = { "find.text": FileSearchMatch[]; "find.files": string[]; "find.symbols": FileSymbol[]; "file.list": FileNode[]; "file.read": FileContent; "file.status": FileStatus[] }

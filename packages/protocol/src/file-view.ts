import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { lazySchema } from "./lazy"
import { FILE_VIEW_MAX_ROWS } from "./file-view-data"

/**
 * One read-only window of a project file for the terminal's file viewer. `directory` is the project (or one of the session's extra
 * directories) and `path` is inside it; a path that leaves it, or a symlink that does, answers `kind: "outside"` and nothing is read.
 * `from` (1-based) and `count` pick the lines, `search` lists the lines that contain it (case-insensitive unless it has a capital),
 * `known` is a `version` from an earlier reply: when it still matches the reply is `{ unchanged: true }` without reading the file.
 * A path that is a folder answers `kind: "directory"` with its `entries`. `lang` asks for `lex`, the highlighter's state at the first row.
 * Not a read-only peer's command: file contents can hold credentials, like a diff. Ack: `FileView`.
 */
export const FileViewCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("file.view"),
  directory: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  from: z.number().int().min(1).max(100_000_000).optional(),
  count: z.number().int().min(1).max(FILE_VIEW_MAX_ROWS).optional(),
  search: z.string().min(1).max(200).optional(),
  known: z.string().max(64).optional(),
  /** The highlighter's language of the file (`ts`, `rust`, `markdown`...): the reply then carries `lex`, the state the window starts in. */
  lang: z.string().min(1).max(32).optional(),
}))

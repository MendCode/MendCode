import { z } from "zod"
import { lazySchema } from "./lazy"

export const IdeEditor = z.enum(["zed", "vscode"])
export const IdeConfiguration = lazySchema(() => z.strictObject({
  enabled: z.boolean(),
  /** Which editor feeds the bridge; absent means Zed (the first adapter). */
  editor: IdeEditor.optional(),
  dbPath: z.string().min(1).max(4096).optional(),
}))

import { z } from "zod"
import { ClientId, CommandId, SessionId } from "./ids"
import { lazySchema } from "./lazy"

/**
 * Makes a Git repository in the project folder of the session (`git init`), locally: refused for every remote client and peer, not a read-only
 * command. `directory` has to be the session's own project folder, and it must not be inside a repository already, the home folder or `/`.
 * With `preview` nothing runs: the ack is the plan or the refusal a real run would give. Ack: `GitInitReport`.
 */
export const GitInitCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("git.init"),
  directory: z.string().min(1).max(4096),
  sessionId: SessionId,
  preview: z.boolean().optional(),
}))

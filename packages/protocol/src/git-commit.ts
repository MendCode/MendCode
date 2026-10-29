import { z } from "zod"
import { ClientId, CommandId } from "./ids"
import { lazySchema } from "./lazy"
import { GIT_COMMIT_MAX_MESSAGE, GIT_COMMIT_MAX_PATHS } from "./git-commit-data"

/**
 * Commits the ticked files of the repository containing `directory`, locally. `paths` are relative to the repository root and must stay
 * inside it (symlinks resolved). With `preview` nothing is run: the ack is the plan (the exact argv, the paths, what is staged elsewhere)
 * or the refusal a real run would give. Not a read-only peer's command and refused for every remote client, like `pr.checkout`.
 * Ack: `GitCommitReport`.
 */
export const GitCommitCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("git.commit"),
  directory: z.string().min(1).max(4096),
  message: z.string().max(GIT_COMMIT_MAX_MESSAGE),
  paths: z.array(z.string().max(4096)).max(GIT_COMMIT_MAX_PATHS),
  preview: z.boolean().optional(),
}))

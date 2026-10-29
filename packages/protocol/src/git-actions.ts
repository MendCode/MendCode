import { z } from "zod"
import { ClientId, CommandId, SessionId } from "./ids"
import { lazySchema } from "./lazy"
import { GIT_PR_MAX_BASE, GIT_PR_MAX_BODY, GIT_PR_MAX_TITLE, GIT_PUBLISH_MAX_DESCRIPTION, GIT_PUBLISH_MAX_NAME, GIT_PUBLISH_MAX_OWNER } from "./git-actions-data"

/**
 * The Git page's actions that leave the machine, all local only (refused for every remote client and peer, not read-only commands) and all
 * refused while `experimental.git_actions` is off. `sessionId` is the session the page belongs to: its permission rules are consulted
 * and, after the action, it gets a passive note in the transcript (never a model turn).
 *
 * `git.push` pushes the current branch of the repository containing `directory`, never forced. With `preview` nothing runs: the ack is the
 * plan or the refusal a real run would give. A protected branch (`main`, `master`, the remote's default) needs `confirm` to be its name.
 * Ack: `GitPushReport`.
 */
export const GitPushCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("git.push"),
  directory: z.string().min(1).max(4096),
  sessionId: SessionId.optional(),
  confirm: z.string().max(300).optional(),
  preview: z.boolean().optional(),
}))

/**
 * Publishes the repository containing `directory` as a new private repository on GitHub: `gh repo create <owner>/<name> --private --source <root>
 * --remote origin`, without pushing (the push is `git.push`, a step of its own). `name`, `owner` and `description` are text for gh, never a shell string;
 * absent, they are the defaults (the folder's name, the gh account, no description). There is no field for visibility: the repository is private.
 * With `preview` nothing is created: the ack is the plan or the refusal a real run would give. Ack: `GitPublishReport`.
 */
export const GitPublishCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("git.publish"),
  directory: z.string().min(1).max(4096),
  sessionId: SessionId.optional(),
  name: z.string().max(GIT_PUBLISH_MAX_NAME).optional(),
  owner: z.string().max(GIT_PUBLISH_MAX_OWNER).optional(),
  description: z.string().max(GIT_PUBLISH_MAX_DESCRIPTION).optional(),
  preview: z.boolean().optional(),
}))

/** Reads the current branch's pull request with `gh pr view`. Ack: `GitPrView`. */
export const GitPrViewCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("git.pr.view"),
  directory: z.string().min(1).max(4096),
  sessionId: SessionId.optional(),
}))

/**
 * Creates a pull request for the current branch with `gh pr create`. `title` and `body` are text, not shell: the title is one argument, the body
 * goes through standard input. Absent, they are the prefill. `base` is the branch the pull request targets (the remote's default when absent).
 * With `preview` nothing runs. Ack: `GitPrCreateReport`.
 */
export const GitPrCreateCommand = lazySchema(() => z.strictObject({
  id: CommandId,
  clientId: ClientId,
  type: z.literal("git.pr.create"),
  directory: z.string().min(1).max(4096),
  sessionId: SessionId.optional(),
  title: z.string().max(GIT_PR_MAX_TITLE).optional(),
  body: z.string().max(GIT_PR_MAX_BODY).optional(),
  base: z.string().max(GIT_PR_MAX_BASE).optional(),
  draft: z.boolean().optional(),
  preview: z.boolean().optional(),
}))

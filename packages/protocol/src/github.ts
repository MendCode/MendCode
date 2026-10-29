import { z } from "zod"
import { GITHUB_EVENTS } from "./github-data"
import { lazySchema } from "./lazy"

const text = z.string().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "control characters are not allowed")
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
const numbered = lazySchema(() => z.object({ number: z.number().int().positive(), title: z.string().max(1000).optional(), pull_request: z.unknown().optional() }).passthrough())
export const GithubContext = lazySchema(() => z.object({
  eventName: z.enum(GITHUB_EVENTS),
  repo: z.strictObject({ owner: name, repo: name }),
  actor: name.optional(),
  payload: z.object({
    issue: numbered.optional(),
    pull_request: numbered.optional(),
    comment: z.object({ id: z.number().int().positive(), body: z.string().max(100_000), path: text.optional(), line: z.number().int().nullable().optional(), diff_hunk: z.string().max(50_000).optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough())
export type GithubContext = z.infer<typeof GithubContext>
export const GithubInstallInput = lazySchema(() => z.strictObject({
  model: text.regex(/^[^/\s]+\/[^\s]+$/),
  write: z.boolean().optional(),
  /** The hosted-runner reviewer (`.github/workflows/mendcode-review.yml`, docs/pr-review.md), pinned to one release and its installer's SHA256. */
  hosted: z.boolean().optional(),
  release: z.string().regex(/^(?:v\d+\.\d+\.\d+(?:-beta\.\d+|-nightly\.\d{8}\.\d+)?|dev-[0-9a-f]{7,40})$/).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}))
export type GithubInstallInput = z.infer<typeof GithubInstallInput>
export const GithubRunInput = lazySchema(() => z.strictObject({
  event: z.string().min(1).max(256_000),
  token: text,
  prompt: z.string().min(1).max(50_000).optional(),
  mentions: z.array(text.max(100)).min(1).max(10).optional(),
  publish: z.boolean().optional(),
  /** Review the event's pull request with the PR reviewer instead of running an agent turn (docs/pr-review.md). */
  review: z.boolean().optional(),
  /** Opt-in: download up to five github.com/user-attachments links into a private temp directory for the run. */
  attachments: z.boolean().optional(),
}))
export type GithubRunInput = z.infer<typeof GithubRunInput>
export * from "./github-data"

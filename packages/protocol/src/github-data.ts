export const GITHUB_EVENTS = ["issue_comment", "pull_request_review_comment", "issues", "pull_request", "schedule", "workflow_dispatch"] as const
export type GithubEventName = (typeof GITHUB_EVENTS)[number]
export type GithubInstallReport = { repository: string; file: string; workflow: string; written: boolean; blocked: string[] }
export type GithubRunReport = {
  runId: string
  sessionId: string
  directory: string
  repository: string
  eventName: GithubEventName
  number?: number
  branch: string
  publish: boolean
  prompt: string
  blocked: string[]
}
export type GithubFinishReport = { runId: string; status: "completed" | "failed" | "stopped"; branch: string; changed: boolean; switched: boolean; published: boolean; pullRequest?: number; blocked: string[] }
export type PrCheckoutReport = { number: number; directory: string; repository: string; branch: string; forkRemote?: string; donorSession: "skipped" | "none" }
/** `github run --review` (docs/pr-review.md): one review of the event's pull request, or why none ran. */
export type GithubReviewReport = {
  repository: string
  number?: number
  /** `answered`: a comment command other than review (pause, resume, explain, fix, learn) got its reply. */
  status: "skipped" | "reviewed" | "published" | "failed" | "answered"
  /** The `@mendcode` command of a comment event. */
  command?: string
  reason?: string
  /** The review's text as the job summary shows it (findings, tokens, what was posted). */
  text: string
  posted: boolean
  comments: number
  tokens?: { input: number; output: number }
}

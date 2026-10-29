import type { GhCall } from "./publish"

/**
 * What the pre-merge checks read (docs/pr-review.md): the pull request's title and description, and the issues its description
 * says it closes with GitHub's closing keywords ("Fixes #12", "closes owner/repo#3" for this repository). At most three issues,
 * each read with one `gh api` call; an issue that cannot be read, or that is a pull request, is left out. All of it is the
 * author's text: the review prompt carries it as untrusted data.
 */

export type LinkedIssue = { number: number; title: string; body: string }
export type PullRequestInfo = { title: string; body: string; issues: LinkedIssue[] }

export const MAX_LINKED_ISSUES = 3
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d{1,9})\b/gi

/** Issue numbers of this repository the description closes, in order, at most `MAX_LINKED_ISSUES`. */
export function linkedIssueNumbers(body: string, repo: string): number[] {
  const numbers: number[] = []
  for (const match of body.matchAll(CLOSING)) {
    if (match[1] && match[1].toLowerCase() !== repo.toLowerCase()) continue
    const number = Number(match[2])
    if (number > 0 && !numbers.includes(number)) numbers.push(number)
    if (numbers.length >= MAX_LINKED_ISSUES) break
  }
  return numbers
}

/** The title, the description and its linked issues, bounded. Never throws: a failed read only leaves an issue out. */
export async function readPullRequestInfo({ gh, repo, title, body }: { gh?: GhCall; repo: string; title: string; body: string }): Promise<PullRequestInfo> {
  const issues: LinkedIssue[] = []
  if (gh) for (const number of linkedIssueNumbers(body, repo)) {
    const read = await gh({ argv: ["api", `repos/${repo}/issues/${number}`] }).catch(() => undefined)
    if (!read || read.code !== 0) continue
    try {
      const issue = JSON.parse(read.out) as { title?: unknown; body?: unknown; pull_request?: unknown }
      if (typeof issue.title === "string" && !issue.pull_request) issues.push({ number, title: issue.title.slice(0, 300), body: typeof issue.body === "string" ? issue.body.slice(0, 1500) : "" })
    } catch { /* an unreadable issue is left out */ }
  }
  return { title: title.slice(0, 300), body: body.slice(0, 4000), issues }
}

/** The pull request's own text inside the review prompt's untrusted block. */
export function pullRequestText(info: PullRequestInfo): string[] {
  return [
    `Title: ${info.title}`,
    "Description:",
    info.body.trim() || "(empty)",
    ...info.issues.flatMap((issue) => [`Linked issue #${issue.number}: ${issue.title}`, issue.body.trim() || "(no description)"]),
    ...(info.issues.length ? [] : ["Linked issues: none"]),
  ]
}

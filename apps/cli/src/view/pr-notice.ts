import type { Span } from "../ui/theme"

/**
 * The PR reviewer's notices as the chat draws them (docs/pr-review.md): `owner/repo#N` is an OSC 8 link to the pull request, a
 * `review <id>` after it links to that review, and a job id is shown by its tail (`/reviews open` matches a job by its end), so a
 * narrow row keeps the meaningful words. Pure and computed with the rows, never per frame; the daemon stores nothing extra.
 * Like the rest of the daemon's PR code (commentUrl), a repository is taken to live on GitHub.
 */

const PR_REF = /(?<![\w./@-])([\w.-]+\/[\w.-]+)#(\d+)/g
const REVIEW_REF = /\breview (\d{4,})\b/g
const JOB_ID = /\bprj_[0-9a-z]{12,}\b/g
/** Characters of a job id that stay visible: `/reviews open` accepts the end of an id from 6 characters. */
export const JOB_TAIL = 8

/** Whether a notice's first line is one of the PR reviewer's (it starts with the pull request or the command). */
export const isPrNotice = (head: string) => /^(?:PR review of |@mendcode (?:review|fix) |Posted the held review of |The held review of |[\w.-]+\/[\w.-]+#\d+[: ])/.test(head)

export const prUrl = (repo: string, number: number | string) => `https://github.com/${repo}/pull/${number}`

/** A job id as its tail with a leading ellipsis: `…874f5686`. */
export const shortJob = (id: string) => `…${id.slice(-JOB_TAIL)}`

/** `text` with every job id replaced by its tail; the full id stays in the notice's later lines. */
export const shortenJobs = (text: string) => text.replace(JOB_ID, shortJob)

/** A PR notice for the one cramped queue row: who asked goes (the transcript says it), so the pull request and what happened to it stay; other text is only job-shortened. */
export const queuedNotice = (text: string) => isPrNotice(text) ? shortenJobs(text).replace(/^(@mendcode (?:review|fix)) from \S+ on /, "$1 ") : text

/** `head` (a notice's first line) as spans in `base`: pull request and review references linked, job ids short, `/reviews open` hinted. */
export function noticeSpans(head: string, base: Pick<Span, "fg" | "dim">): Span[] {
  const jobs = [...head.matchAll(JOB_ID)]
  const text = shortenJobs(head)
  const marks: Array<{ start: number; end: number; link: string }> = []
  for (const ref of text.matchAll(PR_REF)) {
    const start = ref.index!
    const end = start + ref[0].length
    marks.push({ start, end, link: prUrl(ref[1]!, ref[2]!) })
    // A review named after the pull request on the same line points into it.
    REVIEW_REF.lastIndex = end
    const review = REVIEW_REF.exec(text)
    if (review) marks.push({ start: review.index + "review ".length, end: review.index + review[0].length, link: `${prUrl(ref[1]!, ref[2]!)}#pullrequestreview-${review[1]}` })
  }
  marks.sort((a, b) => a.start - b.start)
  const spans: Span[] = []
  let at = 0
  for (const mark of marks) {
    if (mark.start < at) continue
    if (mark.start > at) spans.push({ ...base, text: text.slice(at, mark.start) })
    spans.push({ ...base, text: text.slice(mark.start, mark.end), link: mark.link })
    at = mark.end
  }
  if (at < text.length) spans.push({ ...base, text: text.slice(at) })
  if (jobs.length) spans.push({ ...base, dim: true, text: ` · /reviews open ${jobs[0]![0].slice(-JOB_TAIL)}` })
  return spans.filter((span) => span.text)
}

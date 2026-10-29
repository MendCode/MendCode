import type { TextSection } from "./text-page"

/**
 * `/pr` (docs/pr-watch.md): list, watch, unwatch and check the session's pull requests. The daemon runs `gh`; this module
 * only reads the command and lays the answer out for the shared text page. Pure.
 */
export type PrAction = "list" | "watch" | "unwatch" | "check"
export type PrCommand = { action: PrAction; pr?: string }
export type PrWatchRow = { number: number; title: string; url: string; state: string; summary: string }

export const PR_USAGE = "usage: /pr [list | watch [pr] | unwatch [pr] | check [pr]] · pr is a number, a github.com pull URL or a branch"

const VERBS: Readonly<Record<string, PrAction>> = { list: "list", ls: "list", watch: "watch", unwatch: "unwatch", stop: "unwatch", check: "check", status: "check" }

export function parsePrCommand(args: string): { ok: true; command: PrCommand } | { ok: false; error: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return { ok: true, command: { action: "list" } }
  const verb = VERBS[words[0]!.toLowerCase()]
  const rest = verb ? words.slice(1) : words
  if (rest.length > 1) return { ok: false, error: PR_USAGE }
  const pr = rest[0]
  if (verb === "list" && pr) return { ok: false, error: PR_USAGE }
  return { ok: true, command: { action: verb ?? "watch", ...(pr ? { pr } : {}) } }
}

const stateWord = (state: string) => (state === "watching" ? "watching" : `ended · ${state}`)

/** The answer as sections: the PR's current state first, then every watch of the session. */
export function prSections({ action, text, watches }: { action: PrAction; text: string; watches: readonly PrWatchRow[] }): TextSection[] {
  const sections: TextSection[] = []
  if (action === "watch" || action === "check") sections.push({ heading: action === "watch" ? "Now watching" : "State", lines: text.split("\n").filter((line) => line.trim()) })
  sections.push(watches.length
    ? { heading: "Watched by this session", lines: watches.flatMap((watch) => [`#${watch.number} ${stateWord(watch.state)}`, `  ${watch.title}`, `  ${watch.summary}`, `  ${watch.url}`, ""]).slice(0, -1) }
    : { heading: "Watched by this session", lines: ["Nothing yet. /pr watch NUMBER links a pull request; the daemon then checks it through gh and wakes this session only when something changes."] })
  return sections
}

export const prSummary = (watches: readonly PrWatchRow[]) => {
  const live = watches.filter((watch) => watch.state === "watching").length
  return `${live} watching${watches.length > live ? ` · ${watches.length - live} ended` : ""} · gh is read about every minute · esc closes`
}

/** The PR reviewer's `/pr` verbs (docs/pr-review.md); anything else is the watch's. */
export type PrReviewAction = "watch-repo" | "unwatch-repo" | "review" | "list" | "publish-on" | "publish-off"
export const PR_REVIEW_USAGE = "usage: /pr review [pr] | watch-repo [all|requested] | unwatch-repo | repos | publish on|off"

/** `/pr review 12`, `/pr watch-repo`, `/pr publish on`...; undefined when the words are not the reviewer's. */
export function parsePrReviewCommand(args: string): { ok: true; action: PrReviewAction; pr?: string; role?: "all" | "requested" } | { ok: false; error: string } | undefined {
  const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const word = verb?.toLowerCase()
  if (word === "review") return rest.length > 1 ? { ok: false, error: PR_REVIEW_USAGE } : { ok: true, action: "review", ...(rest[0] ? { pr: rest[0] } : {}) }
  if (word === "watch-repo") return rest.length > 1 || rest[0] && !["all", "requested"].includes(rest[0].toLowerCase()) ? { ok: false, error: PR_REVIEW_USAGE } : { ok: true, action: word, ...(rest[0] ? { role: rest[0].toLowerCase() as "all" | "requested" } : {}) }
  if (word === "unwatch-repo" || word === "repos") return rest.length ? { ok: false, error: PR_REVIEW_USAGE } : { ok: true, action: word === "repos" ? "list" : word }
  if (word === "publish") return rest.length === 1 && (rest[0] === "on" || rest[0] === "off") ? { ok: true, action: rest[0] === "on" ? "publish-on" : "publish-off" } : { ok: false, error: PR_REVIEW_USAGE }
  return undefined
}

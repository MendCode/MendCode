import type { PrWatchInfo } from "./pr-watch"

export const FIELDS = "number,title,url,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName,author,statusCheckRollup,comments,reviews"
const REF_NUMBER =/^#?(\d{1,7})$/
const REF_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,7})(?:[/?#].*)?$/
const REF_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
/** A PR reference as the watch accepts it: a number, a github.com pull URL or a branch; never an option or a shell string. */
export function parseRef(value: string | undefined): { ok: true; arg?: string; number?: number; url?: string } | { ok: false; message: string } {
  const text = value?.trim()
  if (!text) return { ok: true }
  const number = REF_NUMBER.exec(text)
  if (number) return { ok: true, arg: number[1]!, number: Number(number[1]) }
  const url = REF_URL.exec(text)
  if (url) { const canonical = `https://github.com/${url[1]}/${url[2]}/pull/${url[3]}`; return { ok: true, arg: canonical, url: canonical, number: Number(url[3]) } }
  if (REF_BRANCH.test(text) && !text.includes("..")) return { ok: true, arg: text }
  return { ok: false, message: "pr must be a number, #number, a github.com pull request URL or a branch name" }
}

export const noWatch = (pr: string | undefined) => ({ ok: false as const, message: pr?.trim() ? "no watch of this session matches that pull request" : "this session watches no pull request" })
const clip = (text: string) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > 80 ? `${flat.slice(0, 80)}...` : flat }
export const describeWatches = (items: readonly PrWatchInfo[]) => items.length
  ? items.map((item) => `#${item.number} ${JSON.stringify(clip(item.title))} · ${item.state === "watching" ? "watching" : `ended (${item.state})`} · ${item.summary} · ${item.url}`).join("\n")
  : "no pull request is watched by this session"

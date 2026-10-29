import type { ForegroundState } from "@mendcode/protocol"

/** What the agent is doing, in the words a window title carries; empty when it is idle. */
export function titleActivityLabel(state: ForegroundState): string {
  if (state === "waiting_approval") return "needs input"
  if (state === "generating" || state === "tool" || state === "compacting") return "working"
  if (state === "cancelling") return "stopping"
  return ""
}

export type TitleInput = {
  template: string
  product: string
  session: string
  route: string
  path: string
  state: ForegroundState
  /** `titleActivity` setting: lead with the activity label when the template has no `{activity}` of its own. */
  activity: boolean
  model?: string
  branch?: string
}

const TOKEN = /\{(product|session|route|path|dir|activity|model|branch)\}/g

/**
 * The window title from the `titleTemplate` tokens: `{product} {session} {route} {path}` as before, plus `{dir}` (the
 * folder's name), `{activity}` ("working", "needs input", empty when idle), `{model}` and `{branch}`. A template
 * without `{activity}` gets the label in front while the agent works or waits. A trailing separator left by an empty
 * token is dropped.
 */
export function terminalTitle(input: TitleInput): string {
  const activity = titleActivityLabel(input.state)
  const values: Record<string, string> = {
    product: input.product, session: input.session, route: input.route, path: input.path,
    dir: input.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "", activity, model: input.model ?? "", branch: input.branch ?? "",
  }
  const body = input.template.replace(TOKEN, (_, token: string) => values[token] ?? "").replace(/(?:\s+[|·]\s*)$/, "")
  if (input.activity && activity && !input.template.includes("{activity}")) return body ? `${activity} · ${body}` : activity
  return body.trim()
}

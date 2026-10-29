import type { ExtensionDialogs } from "@mendcode/extension-api"

/** One question an extension puts to the user, as the daemon shows it. `undefined` from `ask` means nobody answered: the default applies. */
export type DialogRequest = { sessionId: string; extension: string; title: string; question: string; options: string[]; custom: boolean; timeoutMs: number }
export type ExtensionDialogPort = { ask(request: DialogRequest): Promise<string | undefined> }

export const DIALOG_TIMEOUT = { default: 30_000, min: 1_000, max: 120_000 } as const
const MAX_TITLE = 30
const MAX_QUESTION = 500
const MAX_ANSWER = 4_000
const plain = (text: string, max: number) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
const timeoutOf = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), DIALOG_TIMEOUT.min), DIALOG_TIMEOUT.max) : DIALOG_TIMEOUT.default

/**
 * `api.ui`: confirm, select and input from the daemon side. Every dialog carries the answer it falls back to, so a hook never waits
 * on a person: no terminal that shows dialogs (headless, web, remote) answers the default at once, and an open one answers it when
 * its time runs out or the user dismisses it. A malformed call is recorded and answers its default (or false / the first choice / "").
 */
export function createDialogApi(input: { extension: string; port: ExtensionDialogPort | undefined; owns(sessionId: unknown): string | undefined; fail(message: string): void; waiting?(delta: 1 | -1): void }): ExtensionDialogs {
  async function ask(sessionId: string, request: Omit<DialogRequest, "sessionId" | "extension">) {
    const problem = input.owns(sessionId)
    if (problem) { input.fail(problem); return undefined }
    if (!input.port) return undefined
    input.waiting?.(1)
    try {
      return await input.port.ask({ ...request, sessionId, extension: input.extension })
    } catch {
      return undefined
    } finally {
      input.waiting?.(-1)
    }
  }
  return {
    async confirm(sessionId, title, message, options) {
      const fallback = options?.default
      if (typeof fallback !== "boolean") { input.fail("ui.confirm: options.default (true or false) is required: it answers when nobody does"); return false }
      if (typeof title !== "string" || typeof message !== "string") { input.fail("ui.confirm: title and message are strings"); return fallback }
      const answer = await ask(sessionId, { title: plain(title, MAX_TITLE) || "Confirm", question: plain(message, MAX_QUESTION) || plain(title, MAX_QUESTION) || "Confirm?", options: ["Yes", "No"], custom: false, timeoutMs: timeoutOf(options.timeoutMs) })
      return answer === "Yes" ? true : answer === "No" ? false : fallback
    },
    async select(sessionId, title, choices, options) {
      const valid = Array.isArray(choices) && choices.length > 0 && choices.length <= 9 && choices.every((choice) => typeof choice === "string" && plain(choice, 120) === choice && choice.length > 0)
      const fallback = options?.default
      if (!valid) { input.fail("ui.select: 1 to 9 choices, each one plain line of at most 120 characters"); return typeof fallback === "string" ? fallback : "" }
      if (typeof fallback !== "string" || !choices.includes(fallback)) { input.fail("ui.select: options.default is one of the choices: it answers when nobody does"); return choices[0]! }
      const answer = await ask(sessionId, { title: plain(String(title), MAX_TITLE) || "Choose", question: plain(String(title), MAX_QUESTION) || "Choose one", options: [...choices], custom: false, timeoutMs: timeoutOf(options.timeoutMs) })
      return answer !== undefined && choices.includes(answer) ? answer : fallback
    },
    async input(sessionId, title, options) {
      const fallback = options?.default
      if (typeof fallback !== "string") { input.fail("ui.input: options.default (a string) is required: it answers when nobody does"); return "" }
      const placeholder = typeof options.placeholder === "string" ? plain(options.placeholder, 200) : ""
      const answer = await ask(sessionId, { title: plain(String(title), MAX_TITLE) || "Input", question: `${plain(String(title), MAX_QUESTION - 210) || "Type an answer"}${placeholder ? ` (${placeholder})` : ""}`, options: [], custom: true, timeoutMs: timeoutOf(options.timeoutMs) })
      return answer === undefined ? fallback : answer.slice(0, MAX_ANSWER)
    },
  }
}

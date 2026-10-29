import { secretsRevealed } from "../lazy-pages"
import type { SecretInfo } from "@mendcode/protocol"
import { secretMarkers } from "../../view/secret-markers"
import type { AppContext } from "./context"

export function createSecrets(ctx: AppContext) {
  const { input, state, requestFrame, fail, say } = ctx

  /** Takes the list's tails for drawing markers and redraws the transcript with them. */
  function adoptSecretTails(list: readonly SecretInfo[]) {
    state.secretTails.clear()
    for (const secret of list) state.secretTails.set(secret.n, secret.tail)
    state.transcript.refresh()
  }

  /** Asks the daemon for the tails of the session's secrets (one request at a time; a marker that arrives meanwhile triggers one more). */
  async function loadSecretTails() {
    if (state.secretsLoading) {
      state.secretsAgain = true
      return
    }
    state.secretsLoading = true
    const asked = state.sessionId
    try {
      do {
        state.secretsAgain = false
        const reply = await input.send({ type: "secrets.list", sessionId: asked })
        if (asked !== state.sessionId) return
        if (reply.ok) {
          const list = (reply.result?.secrets as SecretInfo[] | undefined) ?? []
          adoptSecretTails(list)
          for (const marker of secretMarkers(state.transcript.blocks().map((block) => block.text).join("\n"))) if (!state.secretTails.has(marker)) state.secretsMissing.add(marker)
          if (state.page === "secrets") state.secretsList = list
          requestFrame()
        }
      } while (state.secretsAgain)
    } finally {
      state.secretsLoading = false
    }
  }

  /** A transcript event that mentions a marker the terminal has no tail for yet asks for the list. */
  function noteSecretMarkers(event: object) {
    const { text, detail } = event as { text?: unknown; detail?: unknown }
    for (const value of [text, detail]) {
      if (typeof value !== "string") continue
      for (const marker of secretMarkers(value)) {
        if (state.secretTails.has(marker) || state.secretsMissing.has(marker)) continue
        void loadSecretTails()
        return
      }
    }
  }

  async function loadSecrets() {
    const reply = await input.send({ type: "secrets.list", sessionId: state.sessionId })
    if (reply.ok) {
      state.secretsList = (reply.result?.secrets as SecretInfo[] | undefined) ?? []
      state.secretsError = ""
      adoptSecretTails(state.secretsList)
    } else {
      state.secretsList = undefined
      state.secretsError = reply.error.message
    }
    requestFrame()
  }

  /** The page state forgets any revealed value (leaving the page, another session). */
  function dropRevealedSecret() {
    state.secretsVisit++
    if (state.secretsState?.revealed) state.secretsState = { ...state.secretsState, revealed: null }
  }

  /** `secrets.reveal`: the value goes into the page state only, while that row stays selected. It is never logged, toasted or kept anywhere else. */
  async function revealSecret(n: number) {
    const visit = state.secretsVisit
    const reply = await input.send({ type: "secrets.reveal", sessionId: state.sessionId, n })
    if (!reply.ok) return fail(reply.error.code === "target_mismatch" ? "that secret is gone" : "could not reveal the secret")
    const value = (reply.result as { value?: unknown } | undefined)?.value
    if (typeof value !== "string" || state.page !== "secrets" || visit !== state.secretsVisit || !state.secretsList) return
    state.secretsState = secretsRevealed(state.secretsState, state.secretsList, n, value)
    requestFrame()
  }

  async function forgetSecret(n: number) {
    const reply = await input.send({ type: "secrets.forget", sessionId: state.sessionId, n })
    if (reply.ok) say(`forgot ‹secret:${n}›`, "success")
    else fail(reply.error.code === "target_mismatch" ? "that secret is gone" : "could not forget the secret")
    await loadSecrets()
  }

  const secretTail = (n: number) => state.secretTails.get(n)

  return { adoptSecretTails, loadSecretTails, noteSecretMarkers, loadSecrets, dropRevealedSecret, revealSecret, forgetSecret, secretTail }
}

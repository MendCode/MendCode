import type { ModelChoice } from "@mendcode/protocol"
import { catalogId, catalogModel, type ModelCatalog } from "../models"
import type { ReviewSession, ReviewSessionFactory } from "./engine"
import { isOverBudget, isStalled, ReviewTurnError } from "./sessions"

/**
 * `fallback_models` (docs/pr-review.md): models a review may move to when its own model fails with a provider error or is not
 * available. A quota or rate limit never moves it (`budget.on_quota` decides those), and neither does a stall, the token cap or a
 * turn that was stopped. A switch happens only before a session has sent anything, so no conversation changes model half way.
 */

export type FallbackSource = { model: string; factory: ReviewSessionFactory }
export type FallbackPick = { ok: true; model: string } | { ok: false; reason: string }

/**
 * The model for a `fallback_models` entry: in the catalog, on the reviewer's own engine and provider (the same transport the
 * review already runs on), and allowed by the user's model list. Anything else is refused with the reason.
 */
export function chooseFallbackModel({ owner, catalog, requested }: { owner: ModelChoice | undefined; catalog: ModelCatalog; requested: string }): FallbackPick {
  const info = owner ? catalogModel(catalog, owner.model) : undefined
  if (!info) return { ok: false, reason: `the reviewer's model${owner ? ` ${owner.model}` : ""} is not in the catalog, so its provider is not known` }
  const id = catalogId(catalog, requested)
  const peer = id ? catalogModel(catalog, id) : undefined
  if (!id || !peer) return { ok: false, reason: `fallback model ${requested} is not in the model catalog` }
  if (catalog.allows?.(peer.id) === false) return { ok: false, reason: `fallback model ${requested} is not in the allowed model list` }
  if (peer.id.startsWith("acp:") || info.id.startsWith("acp:") || peer.engine !== info.engine || peer.provider !== info.provider) return { ok: false, reason: `fallback model ${requested} is not on the reviewer's own provider` }
  if (peer.id === info.id) return { ok: false, reason: `fallback model ${requested} is the reviewer's own model` }
  return { ok: true, model: peer.id }
}

/** A failure of the model call itself (the provider's error, a model it does not serve): not a quota, a rate limit, a stall or a cap. */
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof ReviewTurnError) || error.kind !== "error" || isStalled(error) || isOverBudget(error)) return false
  return /the review turn failed:/.test(error.message)
}

/** Which model a review runs on: shared by every session of one run, so a model that failed is not tried again by the next one. */
export type FallbackState = { at: number; reason: string | undefined }
export const newFallbackState = (): FallbackState => ({ at: -1, reason: undefined })
/** The fallback in use, or undefined while the reviewer's own model runs. */
export const fallbackUsed = (state: FallbackState, sources: readonly FallbackSource[]) => state.at >= 0 ? sources[state.at]?.model : undefined

/**
 * `primary` with `sources` behind it. The first turn of a session that fails with a provider error moves to the next source (a
 * session that cannot even be created counts the same); the move is kept in `state` for the sessions that follow. When the last
 * source fails too, the error is the last one's.
 */
export function withFallbacks({ primary, sources, state }: { primary: ReviewSessionFactory; sources: readonly FallbackSource[]; state: FallbackState }): ReviewSessionFactory {
  if (!sources.length) return primary
  const factoryAt = (index: number) => index < 0 ? primary : sources[index]!.factory
  return async (input) => {
    let index = state.at
    let session: ReviewSession | undefined
    const open = async () => {
      for (;;) {
        try { session = await factoryAt(index)(input); return } catch (error) {
          if (!isProviderFailure(error) || index + 1 >= sources.length) throw error
          state.reason ??= reasonOf(error); index += 1; state.at = Math.max(state.at, index)
        }
      }
    }
    await open()
    let sent = false
    return {
      ...session!,
      async send(prompt, options) {
        for (;;) {
          try { const turn = await session!.send(prompt, options); sent = true; return turn } catch (error) {
            if (sent || !isProviderFailure(error) || index + 1 >= sources.length) throw error
            state.reason ??= reasonOf(error)
            await session!.close().catch(() => undefined)
            index += 1; state.at = Math.max(state.at, index)
            await open()
          }
        }
      },
      close: () => session!.close(),
    }
  }
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^\[PR_REVIEW\]:\s*(?:the review turn failed:\s*)?/, "").slice(0, 160)

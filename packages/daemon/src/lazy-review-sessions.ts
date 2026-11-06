import type { ReviewSessions } from "./pr-review/sessions"

/** Creating a factory or observing ordinary turns does not load the reviewer. */
export function lazyReviewSessions(create: (module: typeof import("./pr-review/sessions")) => ReviewSessions): ReviewSessions {
  let sessions: ReviewSessions | undefined
  let loading: Promise<ReviewSessions> | undefined
  const load = () => loading ??= import("./pr-review/sessions").then((module) => sessions = create(module))
  return {
    factory: (input) => async (request) => (await load()).factory(input)(request),
    observe: (event) => sessions?.observe(event),
    isReview: (id) => sessions?.isReview(id) ?? false,
    isEditor: (id) => sessions?.isEditor(id) ?? false,
  }
}

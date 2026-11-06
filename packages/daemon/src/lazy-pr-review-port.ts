import type { PrReviewPort, createPrReviewPort } from "./pr-review-tool"

export function lazyPrReviewPort(options: Parameters<typeof createPrReviewPort>[0]): PrReviewPort {
  let loading: Promise<PrReviewPort> | undefined
  const load = () => loading ??= import("./pr-review-tool").then(({ createPrReviewPort }) => createPrReviewPort(options))
  return {
    preview: async (input) => (await load()).preview(input),
    review: async (input) => (await load()).review(input),
    status: async () => (await load()).status(),
  }
}

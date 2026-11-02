import { createTextPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"

/** One scrollable confirmation, reusing the document page rather than a clipped toast. */
export async function setupPage(ctx: AppContext, title: string, text: string, confirm?: () => Promise<void>) {
  await preload("pr")
  ctx.state.textPage = { ...createTextPageState({ title, summary: confirm ? "enter confirms · esc cancels" : "esc back", sections: [{ lines: text.split("\n") }] }), ...(confirm ? { confirm } : {}) }
  ctx.state.page = "text"
  ctx.requestFrame()
}

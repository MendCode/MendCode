import { TIER_BUNDLES, tierDiff, type Tier } from "@mendcode/protocol/wire"
import type { Settings } from "@mendcode/protocol"
import type { TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"

/**
 * Applies a tier: saves it with the chat view of its bundle, sets the project's prompt mode, and sets the terminal profile's
 * density (and hides the right bar for minimalist). Feature modules follow the tier live in the daemon; this only sets the
 * existing switches once, like a setup preset. Returns the saved settings, or undefined when the daemon refused.
 */
export async function applyTierBundle(ctx: AppContext, input: { tier: Tier; changeProfile(patch: Partial<TuiProfile>): void }) {
  const { input: app, state, fail } = ctx
  const bundle = TIER_BUNDLES[input.tier]
  const before = state.settingsNow.tier
  const reply = await app.send({ type: "settings.set", patch: { tier: input.tier, view: bundle.view } } as never)
  if (!reply.ok) { fail(reply.error.message); return undefined }
  const settings = (reply.result?.settings as Settings | undefined) ?? { ...state.settingsNow, tier: input.tier, view: bundle.view }
  state.settingsNow = settings
  const prompt = await app.send({ type: "prompt.set", directory: app.directory ?? ".", mode: bundle.promptMode })
  // Minimalist hosts the daemon in the terminal's process (applies at the next launch); leaving it restores the separate daemon, but a user's own choice under another tier is not touched.
  const processPatch = input.tier === "minimalist" || before === "minimalist" ? { processMode: bundle.processMode } : {}
  input.changeProfile({ density: bundle.density, slashMenu: input.tier === "minimalist" ? "flat" : "tabs", ...processPatch, ...(bundle.hideRightSidebar ? { rightSidebar: false } : {}) })
  const diff = before ? tierDiff(before, input.tier) : undefined
  const change = diff ? [...diff.added.map((id) => `+${id}`), ...diff.removed.map((id) => `-${id}`)].join(" ") : ""
  return { settings, promptOk: prompt.ok, summary: `tier ${input.tier} · view ${bundle.view} · prompt ${bundle.promptMode} · density ${bundle.density}${change ? ` · ${change}` : ""}${prompt.ok ? "" : " · prompt mode unchanged"}` }
}

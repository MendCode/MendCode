import { FEATURES, FEATURE_IDS, TIER_BUNDLES, tierDiff, tierRows, type Tier, type TierSettings } from "@mendcode/protocol/wire"
import type { Settings } from "@mendcode/protocol"
import type { TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"

const TIER_NAME: Readonly<Record<Tier, string>> = { minimalist: "Minimalist", balanced: "Balanced", full: "Full" }
const PROMPT_NAME: Readonly<Record<string, string>> = { minimal: "small prompt", focus: "focused prompt", full: "full prompt" }

/**
 * What `/tier <tier>` says (docs/commands.md#notices): a short line in words (the tier, its prompt and how many features are on), the way
 * back as the hint, and the full detail (view, prompt, density, each feature it turned on or off by name) behind F4.
 */
export function tierNotice(input: { tier: Tier; before?: Tier | undefined; settings: TierSettings; promptOk: boolean; safeMode?: boolean | undefined }): { message: string; hint: string; detail: string } {
  const bundle = TIER_BUNDLES[input.tier]
  // A feature its tier only allows (its own switch must be on too) is not counted as on.
  const on = tierRows(input.settings, { safeMode: input.safeMode }).filter((row) => row.now.on && (row.mode !== "permit" || FEATURES[row.id].optIn)).length
  const prompt = input.promptOk ? PROMPT_NAME[bundle.promptMode] ?? `${bundle.promptMode} prompt` : "prompt unchanged"
  const message = `${TIER_NAME[input.tier]}: ${prompt}, ${on} of ${FEATURE_IDS.length} features on`
  const hint = input.before && input.before !== input.tier ? `/tier ${input.before} to go back` : input.before ? "/tier lists each feature" : "/tier off to go back"
  const diff = input.before ? tierDiff(input.before, input.tier) : undefined
  const names = (ids: readonly string[]) => ids.map((id) => FEATURES[id as keyof typeof FEATURES].label).join(", ")
  const detail = [
    `${TIER_NAME[input.tier]} tier`,
    `Chat view ${bundle.view} · prompt ${bundle.promptMode} · density ${bundle.density}${bundle.hideRightSidebar ? " · right bar hidden" : ""}`,
    ...(input.promptOk ? [] : ["The prompt mode did not change: the daemon refused it."]),
    `${on} of ${FEATURE_IDS.length} features on · /tier lists each one`,
    ...(diff?.removed.length ? [`Turned off: ${names(diff.removed)}`] : []),
    ...(diff?.added.length ? [`Turned on: ${names(diff.added)}`] : []),
  ].join("\n")
  return { message, hint, detail }
}

/**
 * Applies a tier: saves it with the chat view of its bundle, sets the project's prompt mode, and sets the terminal profile's
 * density (and hides the right bar for minimalist; balanced and full turn `showEffort` on). Feature modules follow the tier live in the daemon; this only sets the
 * existing switches once, like a setup preset. Returns the saved settings and the notice to show, or undefined when the daemon refused.
 */
export async function applyTierBundle(ctx: AppContext, input: { tier: Tier; before?: Tier | undefined; changeProfile(patch: Partial<TuiProfile>): void }) {
  const { input: app, state, fail } = ctx
  const bundle = TIER_BUNDLES[input.tier]
  // The caller that just read the settings knows the tier being left; otherwise the last settings this terminal saw.
  const before = input.before ?? state.settingsNow.tier
  const reply = await app.send({ type: "settings.set", patch: { tier: input.tier, view: bundle.view } } as never)
  if (!reply.ok) { fail(reply.error.message); return undefined }
  const settings = (reply.result?.settings as Settings | undefined) ?? { ...state.settingsNow, tier: input.tier, view: bundle.view }
  state.settingsNow = settings
  const prompt = await app.send({ type: "prompt.set", directory: app.directory ?? ".", mode: bundle.promptMode })
  // Minimalist hosts the daemon in the terminal's process (applies at the next launch); leaving it restores the separate daemon, but a user's own choice under another tier is not touched.
  const processPatch = input.tier === "minimalist" || before === "minimalist" ? { processMode: bundle.processMode } : {}
  // Balanced and full name the reasoning effort in the row under the prompt; minimalist has no such row, so nothing is written for it.
  input.changeProfile({ density: bundle.density, slashMenu: input.tier === "minimalist" ? "flat" : "tabs", ...processPatch, ...(bundle.hideRightSidebar ? { rightSidebar: false } : {}), ...(bundle.view !== "minimal" ? { showEffort: true } : {}) })
  const notice = tierNotice({ tier: input.tier, before, settings: settings as TierSettings, promptOk: prompt.ok, safeMode: app.safeMode })
  return { settings, promptOk: prompt.ok, summary: notice.message, notice }
}

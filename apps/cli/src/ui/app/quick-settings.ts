import { EXPERIMENTAL_FLAGS, FEATURES, OUTPUT_STYLES, TIERS, TIER_BUNDLES, effectiveSettings, featureOn, isFeatureId, isTier, tierRows, type ExperimentalFlag, type OutputStyle } from "@mendcode/protocol/wire"
import type { ModelChoice, ModelsReport, Settings } from "@mendcode/protocol"
import type { TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"
import { applyTierBundle } from "./tier"
import { fastReach } from "../../view/fast-mode"
import { modelLabel } from "../../view/model-label"
import { createTextPageState, preload } from "../lazy-pages"

const OUTPUT_STYLE_SUMMARY: Readonly<Record<OutputStyle, string>> = {
  default: "MendCode's usual tone",
  explanatory: "adds short insights on why, as it works",
  learning: "explains each step and leaves small pieces for you to write",
  terse: "as few words as you can act on",
  caveman: "short plain fragments, exact technical details",
}
export const FAST_USAGE = "usage: /fast [on|off|status]"
export const OUTPUT_STYLE_USAGE = `usage: /output-style [${OUTPUT_STYLES.join("|")}]`
export const EXPERIMENTAL_USAGE = "usage: /experimental [flag [on|off]]"
export const GRAPH_USAGE = "usage: /graph [on|off|auto] · /graph default on|off|auto"
const flagIds = new Set<string>(EXPERIMENTAL_FLAGS.map((flag) => flag.id))
type ConfigLayer = { id: string; label: string; source: string; present: boolean; entries: string[]; note?: string }

/**
 * The small settings commands: `/fast` (priority service tier), `/output-style`, `/experimental` (feature flags),
 * `/debug-config` (where each setting comes from) and `/cd` and `/pwd`. Each is a thin front for a daemon setting or
 * command; local-only ones refuse a remote terminal up front.
 */
export function createQuickSettings(ctx: AppContext, actions: { changeProfile(patch: Partial<TuiProfile>): void }) {
  const { input, state, say, fail, requestFrame } = ctx
  const readOnly = () => input.remote?.readOnly === true

  /** The daemon's settings right now, so a toggle never builds on a stale copy. */
  async function currentSettings(): Promise<Settings> {
    const reply = await input.send({ type: "settings.get" })
    return reply.ok && reply.result?.settings ? reply.result.settings as Settings : state.settingsNow
  }
  async function save(patch: Record<string, unknown>) {
    const reply = await input.send({ type: "settings.set", patch } as never)
    if (!reply.ok) { fail(reply.error.message); return undefined }
    const settings = (reply.result?.settings as Settings | undefined) ?? { ...state.settingsNow, ...patch } as Settings
    state.settingsNow = settings
    requestFrame()
    return settings
  }

  async function fastCommand(args: string) {
    const word = args.trim().toLowerCase()
    // This terminal's session first: `/fast` turns it on or off here only; the `serviceTier` setting is the default of sessions that never chose.
    const on = state.modelReport?.session?.fast ?? state.settingsNow.serviceTier === "fast"
    // Whether it reaches the session's model: an on that changes nothing says so, and why.
    const reach = () => {
      const id = state.effectiveModel?.model
      if (!id) return "priority processing for OpenAI and ChatGPT models, billed at a higher rate"
      const { applies, why } = fastReach(id, state.modelReport)
      const name = modelLabel(id, state.modelReport)
      return applies ? `applies to ${name}, billed at a higher rate` : `not applied to ${name} (${why}); it reaches OpenAI and ChatGPT models on the native engine`
    }
    if (word === "status" || word === "") {
      if (word === "status") { say(on ? `fast mode on · ${reach()}` : "fast mode off"); return }
    } else if (word !== "on" && word !== "off") { say(FAST_USAGE, "warning"); return }
    if (readOnly()) { say("settings are read-only for this terminal", "warning"); return }
    const next = word === "" ? !on : word === "on"
    const base: ModelChoice | undefined = state.modelReport?.session ?? state.effectiveModel
    if (state.sessionId && base) {
      const reply = await input.send({ type: "session.model.set", sessionId: state.sessionId, choice: { ...base, fast: next } })
      if (!reply.ok) { say(reply.error.message.replace(/^\[[A-Z]+\]: /, ""), "warning"); return }
      state.modelReport = reply.result as ModelsReport
      state.effectiveModel = state.modelReport.effective
      requestFrame()
    } else if (!await save({ serviceTier: next ? "fast" : null })) return
    say(next ? `fast mode on · ${reach()}` : "fast mode off", next ? "warning" : "success")
  }

  async function outputStyleCommand(args: string) {
    const word = args.trim().toLowerCase()
    const current = state.settingsNow.outputStyle ?? "default"
    if (!word) { say(`output style: ${current} · ${OUTPUT_STYLES.map((style) => `${style} (${OUTPUT_STYLE_SUMMARY[style]})`).join(" · ")}`); return }
    const style = OUTPUT_STYLES.find((candidate) => candidate === word)
    if (!style) { say(OUTPUT_STYLE_USAGE, "warning"); return }
    if (style === "caveman" && !featureOn(state.settingsNow, "caveman")) { say("enable caveman with /tier caveman on (balanced tier)", "warning"); return }
    if (readOnly()) { say("settings are read-only for this terminal", "warning"); return }
    if (!await save({ outputStyle: style === "default" ? null : style })) return
    say(`output style: ${style} · applies from the next message`, "success")
  }

  async function experimentalCommand(args: string) {
    const [name, value, ...extra] = args.trim().split(/\s+/).filter(Boolean)
    if (!name) {
      const settings = await currentSettings()
      const enabled = effectiveSettings(settings, { safeMode: input.safeMode }).experimental as Record<string, unknown> | undefined
      const overrides = Object.entries(settings.features ?? {}).map(([id, on]) => `${id} ${on ? "on" : "off"}`)
      await preload("changelog")
      state.textPage = createTextPageState({
        title: "Experimental features",
        summary: "all off unless listed on · /experimental <flag> on|off · tiers: /tier",
        sections: [
          { heading: "Flags", lines: EXPERIMENTAL_FLAGS.map((flag) => `- ${enabled?.[flag.id] === true ? "on " : "off"}  ${flag.id} · ${flag.summary} (${flag.doc})`) },
          { heading: "Tier", note: settings.tier ?? "none", lines: [overrides.length ? `- overrides: ${overrides.join(" · ")}` : "- no feature overrides", "- /tier lists what each tier includes and /tier <feature> on|off|default changes one"] },
        ],
      })
      state.page = "text"
      requestFrame()
      return
    }
    if (extra.length || value !== undefined && !["on", "off", "toggle"].includes(value.toLowerCase()) || !flagIds.has(name)) {
      say(flagIds.has(name) ? EXPERIMENTAL_USAGE : `unknown flag ${name} · ${[...flagIds].join(" ")}`, "warning")
      return
    }
    const was = flagOn(await currentSettings(), name)
    await setFlags([name as ExperimentalFlag], value === undefined || value.toLowerCase() === "toggle" ? !was : value.toLowerCase() === "on")
  }

  const flagOn = (settings: Settings, name: string) => (effectiveSettings(settings, { safeMode: input.safeMode }).experimental as Record<string, unknown> | undefined)?.[name] === true

  /** Turns experimental flags on or off in one save and says so in one line; also behind `/pr on|off`. */
  async function setFlags(names: readonly ExperimentalFlag[], next: boolean): Promise<boolean> {
    if (readOnly()) { say("settings are read-only for this terminal", "warning"); return false }
    const current = await currentSettings()
    const experimental = { ...(current.experimental ?? {}) } as Record<string, unknown>
    for (const name of names) {
      if (next) experimental[name] = true
      // With a tier set, a flag can be on by default: an explicit false is what keeps it off.
      else if (current.tier !== undefined) experimental[name] = false
      else delete experimental[name]
    }
    const saved = await save({ experimental: Object.keys(experimental).length ? experimental : null })
    if (!saved) return false
    const left = next ? names.filter((name) => !flagOn(saved, name)) : []
    if (left.length) say(`${left.join(", ")} ${left.length > 1 ? "are" : "is"} saved on but the ${saved.tier ?? "safe-mode"} tier leaves ${left.length > 1 ? "them" : "it"} out · ${left.map((name) => `/tier ${Object.entries(FEATURES).find(([, spec]) => spec.flag === name)?.[0] ?? name} on`).join(" · ")}`, "warning")
    else say(`${names.join(", ")} ${next ? "on" : "off"}`, next ? "warning" : "success")
    return left.length === 0
  }

  /** `/tier`: what each tier includes and what is on now. `/tier <tier>` applies a bundle, `/tier <feature> on|off|default` overrides one feature. */
  async function tierCommand(args: string) {
    const [first, second, ...extra] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const settings = await currentSettings()
    const options = { safeMode: input.safeMode }
    if (!first) {
      const rows = tierRows(settings, options)
      const mark = (included: boolean) => included ? "x" : "-"
      await preload("changelog")
      state.textPage = createTextPageState({
        title: "Tiers",
        summary: "/tier minimalist|balanced|full applies a bundle · /tier <feature> on|off|default · /tier off clears the tier",
        sections: [
          { heading: "Now", note: settings.tier ?? "no tier", lines: [
            settings.tier ? `- ${settings.tier}: ${TIER_BUNDLES[settings.tier].summary}` : "- no tier set: every feature keeps its own default",
            ...(input.safeMode ? ["- safe mode: no extensions, packages, hooks, MCP or project tools"] : []),
          ] },
          { heading: "Bundles", lines: TIERS.map((tier) => {
            const bundle = TIER_BUNDLES[tier]
            return `- ${tier}: view ${bundle.view} · prompt ${bundle.promptMode} · density ${bundle.density}${bundle.hideRightSidebar ? " · right bar hidden" : ""} · process ${bundle.processMode}`
          }) },
          { heading: "Features", note: "min bal full", lines: rows.map((row) => `- ${row.now.on ? (row.mode === "permit" && !FEATURES[row.id].optIn ? "allowed" : "on     ") : "off    "} ${row.id} · ${row.label} [${row.perTier.map(mark).join(" ")}]${row.mode === "permit" ? " own switch" : ""}${row.mode === "kernel" ? " kernel" : ""}${row.overridden ? row.now.why === "override" ? " · override" : ` · override ${row.now.why}` :row.now.why === "safe-mode" ? " · safe mode" : ""}`) },
        ],
      })
      state.page = "text"
      requestFrame()
      return
    }
    if (readOnly()) { say("settings are read-only for this terminal", "warning"); return }
    if (input.remote) { say("the tier is set on the machine that runs the commands", "warning"); return }
    if (first === "off" || first === "none" || first === "default") {
      if (!await save({ tier: null })) return
      say("tier cleared · every feature is back at its own default", "success")
      return
    }
    if (isTier(first) && second === undefined) {
      const applied = await applyTierBundle(ctx, { tier: first, changeProfile: actions.changeProfile })
      if (applied) { requestFrame(); say(applied.summary, "success") }
      return
    }
    // The thread bridge's own switch is per engine: `/tier thread_mcp on claude codex acp:<name>` turns the feature on with them.
    if (first === "thread_mcp" && (second === "on" || second === "off") && extra.length) {
      // An ACP agent is named as configured, so its case is kept.
      const engines = args.trim().split(/\s+/).slice(2).map((engine) => (/^acp:/i.test(engine) ? `acp:${engine.slice(4)}` : engine.toLowerCase()))
      const bad = engines.find((engine) => engine !== "claude" && engine !== "codex" && !/^acp:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(engine))
      if (bad) { say(`thread_mcp engines: claude, codex, acp:<name> (not ${bad})`, "warning"); return }
      const on = second === "on"
      const now = settings.threadMcp ?? {}
      const acp = { ...(now.acp ?? {}) }
      for (const engine of engines.filter((engine) => engine.startsWith("acp:"))) acp[engine.slice(4)] = on
      const threadMcp = { ...now, ...(engines.includes("claude") ? { claude: on } : {}), ...(engines.includes("codex") ? { codex: on } : {}), ...(Object.keys(acp).length ? { acp } : {}) }
      const features = { ...(settings.features ?? {}), ...(on ? { thread_mcp: true } : {}) } as Record<string, boolean>
      if (!await save({ threadMcp, ...(on ? { features } : {}) })) return
      say(`thread bridge ${on ? "on" : "off"} for ${engines.join(", ")}${on && settings.tier !== "full" ? " · it needs the full tier (/tier full)" : ""} · new turns get it`, "success")
      return
    }
    if (isFeatureId(first) && second !== undefined && ["on", "off", "default"].includes(second) && extra.length === 0) {
      if (FEATURES[first].mode === "kernel") { say(`${first} changes only with --safe-mode`, "warning"); return }
      const features = { ...(settings.features ?? {}) } as Record<string, boolean>
      if (second === "default") delete features[first]
      else features[first] = second === "on"
      if (!await save({ features: Object.keys(features).length ? features : null })) return
      say(`${first} ${FEATURES[first].optIn ? second === "on" ? "on" : second === "default" ? "off · its default" : "off" : second === "default" ? "follows the tier again" : second === "on" ? "included" : "off"}${second === "on" && FEATURES[first].mode === "permit" && !FEATURES[first].optIn ? ` · still needs its own switch (${FEATURES[first].own})` : ""}`, second === "off" ? "success" : "warning")
      return
    }
    say(`usage: /tier [${TIERS.join("|")}|off] · /tier <feature> on|off|default · features: ${Object.keys(FEATURES).join(" ")}`, "warning")
  }

  async function debugConfigCommand() {
    if (input.remote) { fail("The config view reads local files and is local only"); return }
    await preload("changelog")
    state.textPage = createTextPageState({ title: "Config layers", status: "loading", hint: "reading the layers…" })
    state.page = "text"
    requestFrame()
    const reply = await input.send({ type: "system.query", directory: input.directory ?? ".", operation: "config-layers" })
    if (state.page !== "text" || state.textPage?.title !== "Config layers") return
    if (!reply.ok) state.textPage = createTextPageState({ title: "Config layers", status: "error", error: reply.error.message })
    else {
      const facts = (reply.result?.facts ?? {}) as { layers?: ConfigLayer[]; warnings?: string[] }
      const warnings = facts.warnings ?? []
      state.textPage = createTextPageState({
        title: "Config layers",
        summary: "lowest to highest precedence · secret values are never shown",
        sections: [
          ...(warnings.length ? [{ heading: "Warnings", lines: warnings.map((line) => `- ${line}`) }] : []),
          ...(facts.layers ?? []).map((layer) => ({
            heading: layer.label,
            note: layer.present ? "present" : "not set",
            lines: [layer.source, ...(layer.note ? [layer.note] : []), ...layer.entries.map((entry) => `- ${entry}`)],
          })),
        ],
      })
    }
    requestFrame()
  }

  /**
   * `/graph [on|off|auto]` sets where the code graph indexes for this project (`projectConfig[dir].codegraph_index`); `/graph default
   * on|off|auto|next` sets it for every project (`codegraph_index`, the /customize row); bare `/graph` says what holds here.
   */
  async function graphCommand(args: string) {
    const [first = "", second = ""] = args.trim().toLowerCase().split(/\s+/)
    const modes = ["auto", "on", "off"] as const
    type Mode = (typeof modes)[number]
    const isMode = (word: string): word is Mode => (modes as readonly string[]).includes(word)
    const settings = await currentSettings()
    const directory = input.directory
    const global: Mode = settings.codegraph_index ?? "auto"
    const project = directory ? settings.projectConfig?.[directory]?.codegraph_index : undefined
    if (!featureOn(settings, "codegraph")) { say("code graph is off in this tier · /tier codegraph on", "warning"); return }
    if (first === "" || first === "status") { say(`graph ${project ?? global} here${project ? "" : " (default)"} · default ${global}`); return }
    if (readOnly()) { say("settings are read-only for this terminal", "warning"); return }
    if (first === "default") {
      const next = second === "next" ? modes[(modes.indexOf(global) + 1) % modes.length]! : second
      if (!isMode(next)) { say(GRAPH_USAGE, "warning"); return }
      if (await save({ codegraph_index: next === "auto" ? null : next })) say(`graph default ${next}`, "success")
      return
    }
    if (!isMode(first) || second) { say(GRAPH_USAGE, "warning"); return }
    if (!directory || input.remote) { fail("A project's graph choice is set on the machine that holds the project"); return }
    const { codegraph_index: _previous, ...rest } = settings.projectConfig?.[directory] ?? {}
    const entry = first === "auto" ? rest : { ...rest, codegraph_index: first }
    const { [directory]: _old, ...others } = settings.projectConfig ?? {}
    if (await save({ projectConfig: Object.keys(entry).length ? { ...others, [directory]: entry } : others })) say(first === "auto" ? "graph auto here · indexes a git repo under the size limit" : `graph ${first} here`, "success")
  }

  async function cdCommand(args: string) {
    const target = args.trim()
    if (!target) { say(`in ${input.directory ?? "."} · usage: /cd <directory>`); return }
    if (input.remote) { fail("Changing directory moves local files into scope and is local only"); return }
    const reply = await input.send({ type: "session.cd", sessionId: state.sessionId, path: target })
    if (!reply.ok) { fail(reply.error.message.replace(/^\[DAEMON\]:\s*/, "")); return }
    say(`now in ${String(reply.result?.directory ?? target)}`, "success")
  }

  /** True when the text was one of these commands. */
  async function quickCommand(text: string): Promise<boolean> {
    const match = /^\/(fast|output-style|experimental|tier|debug-config|cd|pwd|graph)(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    const args = match[2] ?? ""
    switch (match[1]) {
      case "fast": await fastCommand(args); break
      case "output-style": await outputStyleCommand(args); break
      case "experimental": await experimentalCommand(args); break
      case "tier": await tierCommand(args); break
      case "debug-config": await debugConfigCommand(); break
      case "cd": await cdCommand(args); break
      case "pwd": say(input.directory ?? "."); break
      case "graph": await graphCommand(args); break
    }
    return true
  }

  return { quickCommand, setFlags }
}

import type { CommandInput } from "@mendcode/client"
import type { PackageAssetsReport, PackageCatalogReport, PackageInfo, PackagePreviewReport, PackageSourceInfo, PackagesReport } from "@mendcode/protocol"
import type { AppContext } from "./context"
import type { MarketplaceAction, MarketplaceState, TakeoverPreview } from "../../view/marketplace-page"
import { preload, createMarketplaceState, createPackagesPageState, marketplaceConfirmFor, marketplaceKey, renderMarketplacePage } from "../lazy-pages"

export type MarketplaceController = ReturnType<typeof createMarketplaceController>

/**
 * /marketplace and /mend-assets: the catalog's data and the daemon calls its keys ask for. The page's keys and drawing live in
 * view/marketplace-page.ts; this file only runs the actions, and every result is one notice. Both load when the page first opens
 * (package-catalog.ts is the start-up stub).
 */
export function createMarketplaceController(ctx: AppContext, deps: { loadPackages(): Promise<void> }) {
  let page = { mode: "catalog", selected: 0, query: "", kind: "all", scope: "user", input: "", draftId: "", scroll: 0 } as MarketplaceState
  let report: PackageCatalogReport | undefined
  let installed: PackageInfo[] | undefined
  let sources: PackageSourceInfo[] = []
  let preview: PackagePreviewReport | undefined
  let takeover: TakeoverPreview | undefined
  let assets: PackageAssetsReport | undefined
  let error = ""
  let epoch = 0
  const directory = ctx.input.directory ?? ""
  const send = (input: CommandInput) => ctx.input.send(input)
  const failed = (message: string) => { error = message; ctx.say(message, "error") }

  async function load() {
    const revision = ++epoch
    const mode = page.mode
    if (mode === "catalog") {
      const [reply, list] = await Promise.all([send({ type: "profiles.search", directory, ...(page.sourceId ? { sourceId: page.sourceId } : {}) }), send({ type: "profiles.list", directory })])
      if (revision !== epoch) return
      error = reply.ok ? "" : reply.error.message
      if (reply.ok) report = reply.result as PackageCatalogReport
      if (list.ok) installed = (list.result as PackagesReport).packages
    } else {
      const reply = await send(mode === "assets" ? { type: "profiles.assets", directory } : { type: "profiles.sources", directory })
      if (revision !== epoch) return
      error = reply.ok ? "" : reply.error.message
      if (reply.ok && mode === "assets") assets = reply.result as PackageAssetsReport
      else if (reply.ok) sources = reply.result?.sources as PackageSourceInfo[] ?? []
    }
    ctx.requestFrame()
  }
  async function open(state: MarketplaceState) {
    await preload("marketplace")
    page = state
    report = undefined
    installed = undefined
    preview = undefined
    takeover = undefined
    error = ""
    ctx.state.page = "marketplace"
    await load()
  }
  const openMarketplace = (sourceId?: string) => open({ ...createMarketplaceState(), ...(sourceId?.trim() ? { sourceId: sourceId.trim() } : {}) })
  const openAssets = () => open({ ...createMarketplaceState(), mode: "assets" })

  /** /profiles, on its list or on one profile's overrides (the "What it takes over" tab). */
  async function openProfiles(overrides?: string) {
    epoch++
    await preload("profiles")
    ctx.state.page = "packages"
    ctx.state.packagesState = { ...createPackagesPageState(), ...(overrides ? { overrides: { key: overrides, selected: 0 } } : {}) }
    ctx.state.packagesReport = undefined
    ctx.state.packagesError = ""
    ctx.requestFrame()
    await deps.loadPackages()
  }

  /** The profile the "What it takes over" tab opens on: the selected one when it is on, else the one that owns the look, else any on. */
  function takeoverKey(): string | undefined {
    const on = (installed ?? []).filter((pkg) => pkg.enabled)
    const name = preview?.entry.name ?? page.selectedId?.split("/")[1]
    const owners = Object.values(ctx.state.activation?.result.owners ?? {})
    return on.find((pkg) => pkg.name === name)?.key ?? on.find((pkg) => owners.includes(pkg.key))?.key ?? on[0]?.key
  }

  async function inspect(entry: { name: string; sourceId: string; remote?: boolean | undefined }) {
    const reply = await send({ type: "profiles.preview", directory, sourceId: entry.sourceId, name: entry.name, scope: page.scope })
    if (!reply.ok) { preview = undefined; return failed(reply.error.message) }
    error = ""
    preview = reply.result as PackagePreviewReport
    page = { ...page, scroll: 0 }
    takeover = undefined
    if (ctx.input.dataDir && !ctx.input.remote) {
      const { takeoverPreview } = await import("./marketplace-takeover")
      takeover = await takeoverPreview({ dataDir: ctx.input.dataDir, directory: ctx.input.directory, entry: preview.entry, scope: preview.scope }).catch((): TakeoverPreview => ({ status: "unknown" }))
    } else takeover = { status: preview.entry.remote ? "remote" : "unknown" }
    if (preview.problems.length) ctx.say(`${preview.entry.name} cannot be installed: ${preview.problems.length === 1 ? "1 audit problem" : `${preview.problems.length} audit problems`}`, "error", { hint: "the preview lists them" })
    else page = { ...page, confirm: marketplaceConfirmFor(preview, installed) }
  }

  /** Runs a mutation; on success the catalog is read again and `done` is the notice. */
  async function mutate(command: CommandInput, done: string, hint?: string) {
    const reply = await send(command)
    if (!reply.ok) return failed(reply.error.message)
    error = ""
    preview = undefined
    takeover = undefined
    ctx.say(done, "success", hint ? { hint } : {})
    await load()
  }

  async function run(action: MarketplaceAction) {
    switch (action.type) {
      case "close": epoch++; ctx.state.page = "chat"; return
      case "reload": preview = undefined; takeover = undefined; return load()
      case "close-preview": preview = undefined; takeover = undefined; return
      case "preview": return inspect(action.entry)
      case "install": {
        const words = action.verb === "install" ? `${action.name} installed ${page.scope === "user" ? "for you" : "in this project"} and on` : action.verb === "update" ? `${action.name} updated to ${preview?.entry.version ?? "the catalog's version"}` : `${action.name} installed again`
        return mutate({ type: "profiles.install-catalog", directory, sourceId: action.sourceId, name: action.name, scope: page.scope, ...(action.replace ? { replace: true } : {}) }, words, "1 shows what it takes over")
      }
      case "remove": return mutate({ type: "profiles.remove", directory, name: action.name, scope: action.scope }, `${action.name} removed from ${action.scope}`, "in the Trash for 30 days: mendcode profile restore")
      case "sources": page = { ...page, mode: "sources", selected: 0, scroll: 0 }; preview = undefined; takeover = undefined; return load()
      case "catalog": page = { ...page, mode: "catalog", selected: 0, scroll: 0 }; delete page.sourceDetail; return load()
      case "tab": return action.tab === 1 ? openProfiles() : openTakeover()
      case "refresh": {
        const reply = await send({ type: "profiles.refresh", directory, sourceId: action.sourceId })
        if (!reply.ok) return failed(reply.error.message)
        error = ""
        sources = reply.result?.sources as PackageSourceInfo[] ?? []
        const count = Number(reply.result?.entries ?? 0)
        ctx.say(`${action.sourceId} fetched · ${count === 1 ? "1 profile" : `${count} profiles`}`, "success")
        return
      }
      case "toggle-source":
      case "add-source": {
        const source = action.type === "toggle-source" ? { sourceId: action.source.id, location: action.source.location, enabled: !action.source.enabled } : { sourceId: action.sourceId, location: action.location, enabled: false }
        const reply = await send({ type: "profiles.add-source", directory, ...source })
        if (!reply.ok) return failed(reply.error.message)
        error = ""
        if (action.type === "add-source") { page = { ...page, input: "", draftId: "" }; delete page.editing }
        sources = reply.result?.sources as PackageSourceInfo[] ?? []
        ctx.say(action.type === "add-source" ? `${action.sourceId} added, off` : `${source.sourceId} ${source.enabled ? "on" : "off"}`, "success", action.type === "add-source" ? { hint: "e turns it on" } : {})
        return
      }
      case "remove-source": {
        const reply = await send({ type: "profiles.remove-source", directory, sourceId: action.sourceId })
        if (!reply.ok) return failed(reply.error.message)
        error = ""
        sources = reply.result?.sources as PackageSourceInfo[] ?? []
        page = { ...page, selected: Math.max(0, Math.min(page.selected, sources.length - 1)) }
        ctx.say(`${action.sourceId} removed`, "success")
        return
      }
      case "none": return
    }
  }
  async function openTakeover() {
    const key = takeoverKey()
    if (!key) ctx.say("no profile is on, so nothing is taken over", "info")
    await openProfiles(key)
  }

  async function catalogKey(key: string) {
    const result = marketplaceKey(page, key, { report, installed, sources, preview })
    page = result.state
    await run(result.action)
    ctx.requestFrame()
  }
  const catalogRows = (width: number, height: number) => renderMarketplacePage({
    state: page, report, installed, sources, preview, assets, takeover, error, width, height,
    live: ctx.state.activation?.result.rows, offline: ctx.state.connection !== "connected", rule: ctx.glyphs.rule,
  })
  return { openMarketplace, openAssets, catalogKey, catalogRows }
}

import type { CommandInput } from "@mendcode/client"
import type { PackageAssetsReport, PackageCatalogReport, PackagePreviewReport, PackageSourceInfo } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { preload, createMarketplaceState, catalogMatches, renderMarketplacePage } from "../lazy-pages"

export function createPackageCatalogPages(ctx: AppContext) {
  let page = { mode: "catalog" as "catalog" | "sources" | "assets", selected: 0, query: "", scope: "user" as "user" | "project", input: "", draftId: "", scroll: 0 } as ReturnType<typeof createMarketplaceState>
  let report: PackageCatalogReport | undefined
  let sources: PackageSourceInfo[] = []
  let preview: PackagePreviewReport | undefined
  let assets: PackageAssetsReport | undefined
  let error = ""
  let epoch = 0
  const directory = ctx.input.directory ?? ""
  const send = (input: CommandInput) => ctx.input.send(input)
  async function load() {
    const revision = ++epoch
    const mode = page.mode
    const reply = await send(mode === "assets" ? { type: "packages.assets", directory } : mode === "sources" ? { type: "packages.sources", directory } : { type: "packages.search", directory, ...(page.sourceId ? { sourceId: page.sourceId } : {}) })
    if (revision !== epoch) return
    error = reply.ok ? "" : reply.error.message
    if (reply.ok) {
      if (mode === "assets") assets = reply.result as PackageAssetsReport
      else if (mode === "sources") sources = reply.result?.sources as PackageSourceInfo[] ?? []
      else report = reply.result as PackageCatalogReport
    }
    ctx.requestFrame()
  }
  async function openMarketplace(sourceId?: string) {
    await preload("marketplace")
    page = { ...createMarketplaceState(), ...(sourceId?.trim() ? { sourceId: sourceId.trim() } : {}) }
    report = undefined
    preview = undefined
    error = ""
    ctx.state.page = "marketplace"
    await load()
  }
  async function openAssets() {
    await preload("marketplace")
    page = { ...createMarketplaceState(), mode: "assets" }
    assets = undefined
    preview = undefined
    error = ""
    ctx.state.page = "marketplace"
    await load()
  }
  async function inspect() {
    const selected = catalogMatches(report, page.query)[page.selected]
    if (!selected) return
    const reply = await send({ type: "packages.preview", directory, sourceId: selected.sourceId, name: selected.name, scope: page.scope })
    error = reply.ok ? "" : reply.error.message
    preview = reply.ok ? reply.result as PackagePreviewReport : undefined
    page.scroll = 0
    ctx.requestFrame()
  }
  async function catalogKey(key: string) {
    if (page.editing) {
      if (key === "\x1b") { if (page.editing === "query") page.query = ""; delete page.editing }
      else if (key === "\r") {
        if (page.editing === "query") delete page.editing
        else if (page.editing === "id") { page.draftId = page.input.trim(); page.input = ""; page.editing = "location" }
        else {
          const reply = await send({ type: "packages.add-source", directory, sourceId: page.draftId, location: page.input.trim(), enabled: false })
          error = reply.ok ? "" : reply.error.message
          if (reply.ok) { delete page.editing; sources = reply.result?.sources as PackageSourceInfo[] ?? [] }
        }
      } else if (key === "\x7f" || key === "\b") page.input = [...page.input].slice(0, -1).join("")
      else if (!/[\x00-\x1f\x7f]/.test(key)) page.input = (page.input + key).slice(0, page.editing === "id" ? 64 : page.editing === "query" ? 500 : 4096)
      if (page.editing === "query") { page.query = page.input; page.selected = 0 }
      return ctx.requestFrame()
    }
    if (page.confirm) {
      const confirmation = page.confirm
      delete page.confirm
      if (key === "y") {
        const target = sources[page.selected]
        const reply = confirmation === "install" && preview && !preview.problems.length
          ? await send({ type: "packages.install-catalog", directory, sourceId: preview.entry.sourceId, name: preview.entry.name, scope: page.scope, ...(preview.action === "replace" ? { replace: true } : {}) })
          : confirmation === "remove-source" && target ? await send({ type: "packages.remove-source", directory, sourceId: target.id }) : undefined
        error = reply && !reply.ok ? reply.error.message : ""
        if (reply?.ok) { preview = undefined; await load() }
      }
      return ctx.requestFrame()
    }
    if (key === "\x1b" || key === "q") {
      if (preview) preview = undefined
      else if (page.sourceDetail) delete page.sourceDetail
      else { epoch++; ctx.state.page = "chat" }
    } else if (key === "r") { preview = undefined; await load() }
    else if (key === "]" || key === "[" || key === "\x1b[6~" || key === "\x1b[5~") page.scroll = Math.max(0, page.scroll + (["]", "\x1b[6~"].includes(key) ? 5 : -5))
    else if (page.mode !== "assets") {
      const length = page.mode === "sources" ? sources.length : catalogMatches(report, page.query).length
      if (["\x1b[A", "k", "\x1b[B", "j"].includes(key)) { page.selected = Math.max(0, Math.min(Math.max(0, length - 1), page.selected + (["k", "\x1b[A"].includes(key) ? -1 : 1))); preview = undefined; delete page.sourceDetail; page.scroll = 0 }
      else if (page.mode === "sources") {
        const source = sources[page.selected]
        if (key === "c") { page.mode = "catalog"; delete page.sourceDetail; page.selected = 0; await load() }
        else if (key === "\r") page.sourceDetail = !page.sourceDetail
        else if (key === "a") { page.editing = "id"; page.input = "" }
        else if (key === "u" && source?.remote) {
          error = ""
          const reply = await send({ type: "packages.refresh", directory, sourceId: source.id })
          error = reply.ok ? "" : reply.error.message
          if (reply.ok) sources = reply.result?.sources as PackageSourceInfo[] ?? []
        }
        else if (key === "e" && source && !source.builtin) {
          const reply = await send({ type: "packages.add-source", directory, sourceId: source.id, location: source.location, enabled: !source.enabled })
          error = reply.ok ? "" : reply.error.message
          if (reply.ok) sources = reply.result?.sources as PackageSourceInfo[] ?? []
        } else if (key === "d" && source && !source.builtin) page.confirm = "remove-source"
      } else if (key === "s") { preview = undefined; page.mode = "sources"; page.selected = 0; await load() }
      else if (key === "/") { preview = undefined; page.editing = "query"; page.input = page.query }
      else if (key === "p") { page.scope = page.scope === "user" ? "project" : "user"; if (preview) await inspect() }
      else if (key === "\r") await inspect()
      else if (key === "i") { await inspect(); if (preview && !preview.problems.length) page.confirm = "install" }
    }
    ctx.requestFrame()
  }
  const catalogRows = (width: number, height: number) => renderMarketplacePage({ state: page, report, sources, preview, assets, error, width, height })
  return { openMarketplace, openAssets, catalogKey, catalogRows }
}

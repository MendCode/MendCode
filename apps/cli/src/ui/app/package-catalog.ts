import type { AppContext } from "./context"
import type { MarketplaceController } from "./marketplace-controller"

/** /marketplace and /mend-assets. Only this stub is loaded at start; the controller and the page load when one first opens. */
export function createPackageCatalogPages(ctx: AppContext, deps: { loadPackages(): Promise<void> }) {
  let controller: MarketplaceController | undefined
  const load = async () => controller ??= (await import("./marketplace-controller")).createMarketplaceController(ctx, deps)
  return {
    openMarketplace: async (sourceId?: string) => (await load()).openMarketplace(sourceId),
    openAssets: async () => (await load()).openAssets(),
    catalogKey: async (key: string) => (await load()).catalogKey(key),
    catalogRows: (width: number, height: number) => controller?.catalogRows(width, height) ?? [],
  }
}

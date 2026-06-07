import type { MendExtensionModule } from "./types"

export function defineExtension(module: MendExtensionModule): MendExtensionModule {
  return module
}

export type { MendExtensionApi, MendExtensionModule } from "./types"

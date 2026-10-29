import { featureOn, type TierSettings } from "@mendcode/protocol/wire"

const PACKAGE_FEATURES = {
  "mendcode-review": "official_packages",
  "mendcode-autoresearch": "autoresearch",
  "mendcode-web-routing": "web_routing",
} as const

/** Installed data stays on disk; tier switches decide whether loaders may use it. */
export function packageTierAllows(settings: TierSettings, name: string) {
  const feature = PACKAGE_FEATURES[name as keyof typeof PACKAGE_FEATURES]
  return !feature || featureOn(settings, "official_packages") && featureOn(settings, feature)
}

export function tierDisabledPackages(settings: TierSettings) {
  return Object.keys(PACKAGE_FEATURES).filter((name) => !packageTierAllows(settings, name)).flatMap((name) => [`user:${name}`, `project:${name}`])
}

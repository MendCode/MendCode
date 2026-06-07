type ProviderLike = {
  id: string
  models: Record<string, { cost?: { input?: number } } | undefined>
}

export function connectedProviders<T extends { id: string }>(all: T[], connected: string[]) {
  const connectedIDs = new Set(connected)
  return all.filter((p) => connectedIDs.has(p.id))
}

export function hasBillableModel(provider: ProviderLike) {
  return provider.id !== "opencode" || Object.values(provider.models).some((m) => m?.cost?.input)
}

export function billableConnectedProviders<T extends ProviderLike>(all: T[], connected: string[]) {
  return connectedProviders(all, connected).filter(hasBillableModel)
}

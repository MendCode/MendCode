const contains = (consoleManagedProviders: string[] | ReadonlySet<string>, providerID: string) =>
  Array.isArray(consoleManagedProviders)
    ? consoleManagedProviders.includes(providerID)
    : consoleManagedProviders.has(providerID)

export const isConsoleManagedProvider = (consoleManagedProviders: string[] | ReadonlySet<string>, providerID: string) =>
  contains(consoleManagedProviders, providerID)

export function providerDisplayName(provider: { id: string; name: string }) {
  if (provider.id === "opencode") return "opencode Zen"
  if (provider.id === "opencode-go") return "opencode Go"
  return provider.name
}

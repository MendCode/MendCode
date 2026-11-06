import type { Command } from "@mendcode/protocol"
import type { PromptMode } from "@mendcode/protocol/wire"
import { claimLook, createPackageRegistry, listPackageResources, listPackages, LookOwnedError, packageAssets, releaseLook, setResourceEnabled, type ExtensionLayer, type PackageFetchers, type PackageHost } from "@mendcode/packages"

type CatalogCommand = Extract<Command, { type: "profiles.search" | "profiles.show" | "profiles.preview" | "profiles.sources" | "profiles.add-source" | "profiles.remove-source" | "profiles.refresh" | "profiles.install-catalog" | "profiles.install-source" | "profiles.disable-all" | "profiles.assets" | "profiles.config" | "profiles.resource" }>

export function createPackageCatalog(input: { capabilities?(): boolean; host?: PackageHost; userDir: string; now: () => number; disabled: () => string[]; runtimeDisabled?(): string[]; setDisabled: (keys: string[]) => void; disabledResources: () => string[]; setDisabledResources: (keys: string[]) => void; fetchers?: PackageFetchers; layers: (directory: string) => ExtensionLayer[]; promptMode: (directory: string) => PromptMode; reload: (directory: string) => Promise<unknown> }) {
  return async (command: CatalogCommand): Promise<Record<string, unknown>> => {
    const disabled = () => input.runtimeDisabled?.() ?? input.disabled()
    const registry = createPackageRegistry({ userDir: input.userDir, directory: command.directory, capabilities: input.capabilities?.() ?? false, ...(input.host ? { host: input.host } : {}), disabled: disabled(), ...(input.fetchers ? { fetchers: input.fetchers } : {}) })
    switch (command.type) {
      case "profiles.search": return registry.search(command.query, command.sourceId)
      case "profiles.show": return { entry: registry.show(command.name, command.sourceId) }
      case "profiles.preview": return registry.preview(command.name, command.sourceId, command.scope)
      case "profiles.sources": return { sources: registry.sources() }
      case "profiles.add-source": return { sources: registry.addSource(command.sourceId, command.location, command.enabled) }
      case "profiles.remove-source": return { sources: registry.removeSource(command.sourceId) }
      case "profiles.refresh": return registry.refresh(command.sourceId)
      case "profiles.assets": return packageAssets(input.layers(command.directory), input.promptMode(command.directory))
      case "profiles.config": return { directory: command.directory, packages: listPackageResources({ userDir: input.userDir, directory: command.directory, disabledResources: input.disabledResources(), key: command.key }) }
      case "profiles.resource": {
        input.setDisabledResources(setResourceEnabled({ userDir: input.userDir, directory: command.directory, disabledResources: input.disabledResources(), key: command.key, resource: command.resource, enabled: command.enabled }))
        await input.reload(command.directory)
        return { directory: command.directory, packages: listPackageResources({ userDir: input.userDir, directory: command.directory, disabledResources: input.disabledResources(), key: command.key }) }
      }
      case "profiles.disable-all": {
        const installed = listPackages({ userDir: input.userDir, directory: command.directory })
        const affected = installed.filter((item) => !command.scope || item.source === command.scope).map((item) => item.key)
        input.setDisabled([...new Set([...input.disabled(), ...affected])])
        for (const key of affected) releaseLook({ userDir: input.userDir, directory: command.directory, key })
        break
      }
      case "profiles.install-catalog":
      case "profiles.install-source": {
        const installed = await registry.install(command.type === "profiles.install-catalog" ? command.name : undefined, command.sourceId, command.scope, command.replace, input.now)
        // v1 install/use selects the installed overlay, including a previously deselected profile.
        const key = `${command.scope}:${installed.name}`
        const before = input.disabled()
        input.setDisabled(before.filter((entry) => entry !== key))
        // Installing enables it, so it claims the look; when another profile owns it this one stays installed but off.
        try { claimLook({ userDir: input.userDir, directory: command.directory, key, disabled: disabled() }) } catch (error) {
          if (error instanceof LookOwnedError) { input.setDisabled([...new Set([...before, key])]); await input.reload(command.directory) }
          throw error
        }
        break
      }
    }
    await input.reload(command.directory)
    return { directory: command.directory, packages: listPackages({ userDir: input.userDir, directory: command.directory, disabled: disabled() }) }
  }
}

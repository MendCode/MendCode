import type { Command } from "@mendcode/protocol"
import type { PromptMode } from "@mendcode/protocol/wire"
import { claimLook, createPackageRegistry, listPackageResources, listPackages, LookOwnedError, packageAssets, releaseLook, setResourceEnabled, type ExtensionLayer, type PackageFetchers, type PackageHost } from "@mendcode/packages"

type CatalogCommand = Extract<Command, { type: "packages.search" | "packages.show" | "packages.preview" | "packages.sources" | "packages.add-source" | "packages.remove-source" | "packages.refresh" | "packages.install-catalog" | "packages.install-source" | "packages.disable-all" | "packages.assets" | "packages.config" | "packages.resource" }>

export function createPackageCatalog(input: { capabilities?(): boolean; host?: PackageHost; userDir: string; now: () => number; disabled: () => string[]; runtimeDisabled?(): string[]; setDisabled: (keys: string[]) => void; disabledResources: () => string[]; setDisabledResources: (keys: string[]) => void; fetchers?: PackageFetchers; layers: (directory: string) => ExtensionLayer[]; promptMode: (directory: string) => PromptMode; reload: (directory: string) => Promise<unknown> }) {
  return async (command: CatalogCommand): Promise<Record<string, unknown>> => {
    const disabled = () => input.runtimeDisabled?.() ?? input.disabled()
    const registry = createPackageRegistry({ userDir: input.userDir, directory: command.directory, capabilities: input.capabilities?.() ?? false, ...(input.host ? { host: input.host } : {}), disabled: disabled(), ...(input.fetchers ? { fetchers: input.fetchers } : {}) })
    switch (command.type) {
      case "packages.search": return registry.search(command.query, command.sourceId)
      case "packages.show": return { entry: registry.show(command.name, command.sourceId) }
      case "packages.preview": return registry.preview(command.name, command.sourceId, command.scope)
      case "packages.sources": return { sources: registry.sources() }
      case "packages.add-source": return { sources: registry.addSource(command.sourceId, command.location, command.enabled) }
      case "packages.remove-source": return { sources: registry.removeSource(command.sourceId) }
      case "packages.refresh": return registry.refresh(command.sourceId)
      case "packages.assets": return packageAssets(input.layers(command.directory), input.promptMode(command.directory))
      case "packages.config": return { directory: command.directory, packages: listPackageResources({ userDir: input.userDir, directory: command.directory, disabledResources: input.disabledResources(), key: command.key }) }
      case "packages.resource": {
        input.setDisabledResources(setResourceEnabled({ userDir: input.userDir, directory: command.directory, disabledResources: input.disabledResources(), key: command.key, resource: command.resource, enabled: command.enabled }))
        await input.reload(command.directory)
        return { directory: command.directory, packages: listPackageResources({ userDir: input.userDir, directory: command.directory, disabledResources: input.disabledResources(), key: command.key }) }
      }
      case "packages.disable-all": {
        const installed = listPackages({ userDir: input.userDir, directory: command.directory })
        const affected = installed.filter((item) => !command.scope || item.source === command.scope).map((item) => item.key)
        input.setDisabled([...new Set([...input.disabled(), ...affected])])
        for (const key of affected) releaseLook({ userDir: input.userDir, directory: command.directory, key })
        break
      }
      case "packages.install-catalog":
      case "packages.install-source": {
        const installed = await registry.install(command.type === "packages.install-catalog" ? command.name : undefined, command.sourceId, command.scope, command.replace, input.now)
        // v1 install/use selects the installed overlay, including a previously deselected package.
        const key = `${command.scope}:${installed.name}`
        const before = input.disabled()
        input.setDisabled(before.filter((entry) => entry !== key))
        // Installing enables it, so it claims the look; when another package owns it this one stays installed but off.
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

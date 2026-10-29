import { loadMcpConfig, type LoadedMcpConfig, type McpServerConfig } from "@mendcode/mcp"
import type { ExtensionLayer } from "@mendcode/packages"
import { canonicalDir } from "@mendcode/tools"

/** Whether `directory` is one of the directories the user trusted for project tools, hooks, extensions and MCP servers. */
export const projectTrusted = ({ trustedToolDirs, directory }: { trustedToolDirs: readonly string[] | undefined; directory: string }) => {
  const canonical = canonicalDir(directory)
  return (trustedToolDirs ?? []).some((trusted) => trusted === canonical || canonicalDir(trusted) === canonical)
}

/**
 * The MCP config the daemon's manager reads for a directory: every layer's `mcp.json`, with the project's own servers (and
 * its packages') held back as `needs trust` until the directory is trusted. Nothing is created, spawned or contacted for them.
 */
export function createMcpConfigLoader({ userDir, layers, allowed, trustedDirs, extensionServers }: {
  userDir: string
  layers: (directory: string) => ExtensionLayer[]
  allowed: () => boolean
  trustedDirs: () => readonly string[] | undefined
  /** Servers extensions register (`api.registerMcpServer`); a name an mcp.json uses (even a held-back one) keeps the file's entry. */
  extensionServers?: (directory: string) => Promise<Record<string, McpServerConfig>>
}) {
  return async (directory: string): Promise<LoadedMcpConfig> => {
    if (!allowed()) return { servers: {}, errors: [] }
    const loaded = await loadMcpConfig({ directory, userDir, layers: layers(directory), trusted: projectTrusted({ trustedToolDirs: trustedDirs(), directory }) })
    const added: Record<string, McpServerConfig> = await extensionServers?.(directory).catch(() => ({})) ?? {}
    const taken = new Set([...Object.keys(loaded.servers), ...(loaded.blocked ?? []).map((server) => server.name)])
    const extra = Object.fromEntries(Object.entries(added).filter(([name]) => !taken.has(name)))
    return Object.keys(extra).length ? { ...loaded, servers: { ...loaded.servers, ...extra } } : loaded
  }
}

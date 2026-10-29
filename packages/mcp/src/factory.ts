import { createStdioMcpClient, type McpClient } from "./client"
import type { McpServerConfig } from "./config"
import type { FetchFn, McpAuth } from "./oauth"
import { createRemoteMcpClient } from "./remote-client"

/** A local server (`command`) runs over stdio; a remote one (`url`) over streamable HTTP or SSE, authorized with `auth` when it answers 401. */
export function createMcpClient({
  name,
  config,
  directory,
  auth,
  fetch,
}: {
  name: string
  config: McpServerConfig
  directory?: string | undefined
  auth?: McpAuth | undefined
  fetch?: FetchFn | undefined
}): McpClient {
  return config.url !== undefined ? createRemoteMcpClient({ name, config, auth, ...(fetch ? { fetch } : {}) }) : createStdioMcpClient({ name, config, directory })
}

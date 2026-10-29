import type { McpServerConfig } from "./config"

/** Names that look like credentials; the same policy filters the environment of project hooks. */
export const CREDENTIAL_ENV = /API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY/i

/**
 * The environment of a stdio server. A user server inherits the daemon's environment. A project server (its own file or a
 * project package's) inherits it without credential-looking names; the ones its config sets in `env` are kept, because it names them.
 */
export function serverEnvironment({ config, base = process.env }: { config: McpServerConfig; base?: Record<string, string | undefined> }): Record<string, string | undefined> {
  if (config.scope !== "project") return { ...base, ...config.env }
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(base)) if (!CREDENTIAL_ENV.test(name)) env[name] = value
  return { ...env, ...config.env }
}

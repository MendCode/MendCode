import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"

export const AUTH_FILE = "mcp-auth.json"

const tokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds; absent when the server gave no lifetime (a 401 then triggers the refresh). */
  expiresAt: z.number().optional(),
  tokenType: z.string(),
  scope: z.string().optional(),
})

const entrySchema = z.object({
  issuer: z.string(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpoint: z.string(),
  authMethod: z.enum(["none", "post", "basic"]),
  resource: z.string().optional(),
  tokens: tokensSchema.optional(),
})

const fileSchema = z.object({ version: z.literal(1), servers: z.record(z.string(), entrySchema) })

export type StoredTokens = z.infer<typeof tokensSchema>
export type StoredAuth = z.infer<typeof entrySchema>

/** The credentials file key of a remote server: its URL without fragment. */
export function authKey(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.hash = ""
  return url.href
}

export interface AuthStore {
  get(serverUrl: string): Promise<StoredAuth | undefined>
  /** Replaces (or, with undefined, removes) one server's entry. Writes are serialized and atomic. */
  set(serverUrl: string, entry: StoredAuth | undefined): Promise<void>
  file: string
}

/**
 * `<dataDir>/mcp-auth.json`, mode 0600: OAuth client registrations and tokens of remote MCP servers. The file is read
 * at each access (it is tiny) so a second daemon or an edit by hand is seen; an unreadable file counts as empty.
 */
export function createAuthStore({ dir }: { dir: string }): AuthStore {
  const file = join(dir, AUTH_FILE)
  let queue: Promise<unknown> = Promise.resolve()

  async function read(): Promise<z.infer<typeof fileSchema>> {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, "utf8")))
      return parsed.success ? parsed.data : { version: 1, servers: {} }
    } catch {
      return { version: 1, servers: {} }
    }
  }

  async function write(data: z.infer<typeof fileSchema>): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  return {
    file,
    async get(serverUrl) {
      await queue.catch(() => undefined)
      return (await read()).servers[authKey(serverUrl)]
    },
    set(serverUrl, entry) {
      const run = queue.catch(() => undefined).then(async () => {
        const data = await read()
        if (entry) data.servers[authKey(serverUrl)] = entry
        else delete data.servers[authKey(serverUrl)]
        await write(data)
      })
      queue = run
      return run
    },
  }
}

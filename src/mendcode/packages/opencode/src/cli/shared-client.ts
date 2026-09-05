import path from "node:path"

export async function withSharedClient<T>(
  directory: string,
  use: (connection: { url: string; headers: Headers; directory: string }) => Promise<T>,
) {
  const { requireLocalSharedServer } = await import("./cmd/tui/thread")
  const resolved = path.resolve(directory)
  const connection = await requireLocalSharedServer({ directory: resolved, runtimeCwd: process.cwd() })
  const headers = new Headers(connection.headers)
  headers.set("x-opencode-directory", encodeURIComponent(resolved))
  try {
    return await use({ url: connection.url, headers, directory: resolved })
  } finally {
    await connection.lease.release()
  }
}

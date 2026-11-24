import { chmodSync, lstatSync, rmSync } from "node:fs"

/**
 * The HTTP adapter on a Unix socket (`serve/web --unix-socket PATH`), for a gateway in front of per-account daemons
 * (docs/gateway.md). A socket left by an earlier run is replaced; any other file at the path is refused, never deleted.
 * The socket gets mode 0660: its folder's group (setgid, the gateway's group) may connect, nobody else. Tokens are still
 * required on every request, as on the loopback port.
 */
export function bindHttpSocket<T>(socket: string, serve: (unix: string) => T): T {
  try {
    if (!lstatSync(socket).isSocket()) throw new Error(`[HTTP]: ${socket} exists and is not a socket`)
    rmSync(socket)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const server = serve(socket)
  chmodSync(socket, 0o660)
  return server
}

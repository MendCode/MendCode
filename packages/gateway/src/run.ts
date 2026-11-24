import { chmodSync, lstatSync, rmSync } from "node:fs"
import { readGatewayConfig } from "./config"
import { MAX_BODY_BYTES, createGateway } from "./server"

/** `gateway run`: the long-running service the systemd unit starts. It listens only on loopback or a Unix socket. */
export async function runGateway(input: { stateDir: string; out: { write(text: string): unknown } }) {
  const config = readGatewayConfig(input.stateDir)
  const gateway = createGateway({ config, stateDir: input.stateDir })
  const common = { fetch: gateway.fetch, websocket: gateway.websocket, maxRequestBodySize: MAX_BODY_BYTES }
  let server: ReturnType<typeof Bun.serve>
  if ("unix" in config.listen) {
    const socket = config.listen.unix
    // A socket left by an earlier run is replaced; any other file at that path is refused, never deleted.
    try { if (lstatSync(socket).isSocket()) rmSync(socket); else throw new Error(`[GATEWAY]: ${socket} exists and is not a socket`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    server = Bun.serve({ ...common, unix: socket })
    // The folder is setgid with the edge proxy's group: group read/write lets only that proxy connect.
    chmodSync(socket, 0o660)
    input.out.write(`MendCode gateway for ${config.origin} on unix:${socket}\n`)
  } else {
    server = Bun.serve({ ...common, hostname: "127.0.0.1", port: config.listen.port, idleTimeout: 60 })
    input.out.write(`MendCode gateway for ${config.origin} on 127.0.0.1:${config.listen.port}\n`)
  }
  const stop = () => { gateway.close(); server.stop(true); process.exit(0) }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  await new Promise(() => {})
}

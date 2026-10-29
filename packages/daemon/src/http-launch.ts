import path from "node:path"
import { realpathSync } from "node:fs"
import { HTTP_WEB } from "./http-web"

/** Invoked lazily by CLI factories; process execution and server runtime stay in the daemon package. */
export async function launchHttpServer(input: { kind: "serve" | "web"; dir: string; cwd?: string; engine?: string; port?: number; hostname?: string; cors: string[]; open: boolean; logLevel?: string; pty?: boolean; edit?: boolean }) {
  const directory = realpathSync(input.cwd ?? process.cwd())
  const http = { enabled: true, ...(input.port !== undefined ? { port: input.port } : {}), ...(input.hostname ? { hostname: input.hostname } : {}), ...(input.cors.length ? { cors: input.cors } : {}) }
  Object.assign(http, input.pty === undefined ? {} : { pty: input.pty }, input.edit === undefined ? {} : { edit: input.edit })
  process.argv = [process.execPath, "__daemon", "--dir", path.resolve(input.dir), "--cwd", directory, "--http-server", JSON.stringify(http), ...(input.kind === "web" ? ["--web"] : []), ...(input.engine ? ["--engine", input.engine] : []), ...(input.logLevel ? ["--log-level", input.logLevel] : [])]
  const { daemon } = await import("./main")
  const url = daemon.httpUrl!
  process.stdout.write(`MendCode server listening on ${url}\n`)
  if (input.open) {
    const args = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
    try { if (await Bun.spawn(args, { stdout: "ignore", stderr: "ignore" }).exited !== 0) process.stderr.write("Browser launch failed; open the server URL\n") } catch { process.stderr.write("Browser launch unavailable; open the server URL\n") }
  }
  return daemon
}

/** The B34 OpenAPI document without starting a daemon, listener or token: `generate --httpapi` prints it. */
export async function generateHttpApi() {
  const { httpOpenApi } = await import("./http")
  return httpOpenApi()
}

export { HTTP_WEB }

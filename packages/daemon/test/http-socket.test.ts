import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { HttpServerConfig } from "@mendcode/protocol"
import { parseServerCommand } from "../../../apps/cli/src/http-cli"
import { bindHttpSocket } from "../src/http-socket"

/** `serve/web --unix-socket`: how a gateway's per-account daemon listens (docs/gateway.md). */
const dir = mkdtempSync("/tmp/mchs-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("the HTTP socket gets mode 0660, replaces a stale socket and never deletes another file", async () => {
  const socket = path.join(dir, "http.sock")
  const serve = (unix: string) => Bun.serve({ unix, fetch: () => new Response("ok") })
  const first = bindHttpSocket(socket, serve)
  expect(statSync(socket).mode & 0o777).toBe(0o660)
  expect(await (await fetch("http://localhost/", { unix: socket } as RequestInit)).text()).toBe("ok")
  first.stop(true)
  const second = bindHttpSocket(socket, serve)
  second.stop(true)
  const plain = path.join(dir, "file")
  writeFileSync(plain, "keep")
  expect(() => bindHttpSocket(plain, serve)).toThrow("not a socket")
  expect(statSync(plain).size).toBe(4)
})

test("the option is an absolute path in the server config and on the command line", () => {
  expect(HttpServerConfig.parse({ socket: "/run/mendcode/x/http.sock" }).socket).toBe("/run/mendcode/x/http.sock")
  expect(HttpServerConfig.safeParse({ socket: "relative.sock" }).success).toBe(false)
  expect(parseServerCommand(["web", "--dir", "/d", "--unix-socket", "/run/x.sock"])).toMatchObject({ kind: "web", socket: "/run/x.sock", open: false })
  expect(() => parseServerCommand(["serve", "--dir", "/d", "--unix-socket", "x.sock"])).toThrow("absolute path")
})

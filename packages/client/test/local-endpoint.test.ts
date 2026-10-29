import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultLocalTransport, localEndpointPath, parseLocalEndpoint, readLocalEndpoint, removeLocalEndpoint, writeLocalEndpoint } from "../src/local-endpoint"

const token = "t".repeat(43)
const endpoint = { transport: "tcp", hostname: "127.0.0.1", port: 43125, token, pid: 4242 } as const

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "endpoint-"))
  try { run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe("local transport choice", () => {
  test("Windows defaults to tcp, others to unix, and the environment overrides both", () => {
    expect(defaultLocalTransport("win32", {})).toBe("tcp")
    expect(defaultLocalTransport("darwin", {})).toBe("unix")
    expect(defaultLocalTransport("linux", { MENDCODE_V2_LOCAL_TRANSPORT: "tcp" })).toBe("tcp")
    expect(defaultLocalTransport("win32", { MENDCODE_V2_LOCAL_TRANSPORT: "unix" })).toBe("unix")
    expect(defaultLocalTransport("win32", { MENDCODE_V2_LOCAL_TRANSPORT: "pipe" })).toBe("tcp")
  })
})

describe("endpoint file", () => {
  test("round-trips, is owner-only, and leaves no temporary file", () => withDir((dir) => {
    writeLocalEndpoint(dir, endpoint)
    expect(readLocalEndpoint(dir)).toEqual(endpoint)
    if (process.platform !== "win32") expect(statSync(localEndpointPath(dir)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(["mendd.endpoint"])
  }))

  test("rejects anything that is not a loopback endpoint with a port, a long secret and a pid", () => {
    for (const bad of [
      "", "not json", "[]", "null",
      JSON.stringify({ ...endpoint, hostname: "0.0.0.0" }),
      JSON.stringify({ ...endpoint, hostname: "example.com" }),
      JSON.stringify({ ...endpoint, transport: "unix" }),
      JSON.stringify({ ...endpoint, port: 0 }),
      JSON.stringify({ ...endpoint, port: 70000 }),
      JSON.stringify({ ...endpoint, port: "80" }),
      JSON.stringify({ ...endpoint, token: "short" }),
      JSON.stringify({ ...endpoint, pid: -1 }),
    ]) expect(parseLocalEndpoint(bad)).toBeUndefined()
  })

  test("a missing or corrupt file reads as no endpoint", () => withDir((dir) => {
    expect(readLocalEndpoint(dir)).toBeUndefined()
    writeFileSync(localEndpointPath(dir), "{")
    expect(readLocalEndpoint(dir)).toBeUndefined()
  }))

  test("removal only deletes the file that holds the caller's secret", () => withDir((dir) => {
    writeLocalEndpoint(dir, endpoint)
    removeLocalEndpoint(dir, "other".repeat(10))
    expect(readLocalEndpoint(dir)).toEqual(endpoint)
    removeLocalEndpoint(dir, token)
    expect(readLocalEndpoint(dir)).toBeUndefined()
  }))
})

import { describe, expect, test } from "bun:test"
import { isMigrateCommand, parseMigrateArgs, parseSince, runMigrateCommand } from "../src"
import { decodeDataUrl } from "../src/map-session"
import { PNG_BASE64, PNG_BYTES, PNG_URL } from "./fixture"

const parse = (...argv: string[]) => parseMigrateArgs(["migrate-v1", ...argv])

describe("parseMigrateArgs", () => {
  test("accepts the full option set", () => {
    const parsed = parse("--from", "/v1", "--dir", "/v2", "--dry-run", "--since", "2026-01-31", "--no-memories", "--json")
    expect(parsed).toEqual({ ok: true, command: { from: "/v1", dir: "/v2", dryRun: true, since: Date.UTC(2026, 0, 31), memories: false, json: true, help: false } })
  })

  test("--dir is required: there is no default", () => {
    const parsed = parse("--from", "/v1")
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.message).toContain("--dir")
  })

  test("--from is required", () => {
    const parsed = parse("--dir", "/v2")
    expect(parsed.ok === false && parsed.message).toContain("--from")
  })

  test("--dir needs a value that is not another flag", () => {
    expect(parse("--from", "/v1", "--dir", "--dry-run").ok).toBe(false)
    expect(parse("--from", "/v1", "--dir").ok).toBe(false)
  })

  test("accepts --flag=value and --format json", () => {
    expect(parse("--from=/v1", "--dir=/v2", "--format", "json")).toMatchObject({ ok: true, command: { from: "/v1", dir: "/v2", json: true } })
  })

  test("rejects unknown flags, extra arguments and bad dates", () => {
    expect(parse("--from", "/a", "--dir", "/b", "--wat").ok).toBe(false)
    expect(parse("extra", "--from", "/a", "--dir", "/b").ok).toBe(false)
    expect(parse("--from", "/a", "--dir", "/b", "--since", "yesterday").ok).toBe(false)
    expect(parse("--from", "/a", "--dir", "/b", "--since", "2026-02-31").ok).toBe(false)
    expect(parseSince("2026-02-28")).toBe(Date.UTC(2026, 1, 28))
  })

  test("--help needs no other option", () => {
    expect(parse("--help")).toMatchObject({ ok: true, command: { help: true } })
  })
})

describe("isMigrateCommand", () => {
  test("is true only when migrate-v1 is the first word, flag values skipped", () => {
    expect(isMigrateCommand(["migrate-v1", "--from", "a", "--dir", "b"])).toBe(true)
    expect(isMigrateCommand(["--dir", "b", "migrate-v1", "--from", "a"])).toBe(true)
    expect(isMigrateCommand(["--dir", "migrate-v1"])).toBe(false)
    expect(isMigrateCommand(["session", "list", "migrate-v1"])).toBe(false)
    expect(isMigrateCommand([])).toBe(false)
  })
})

describe("runMigrateCommand", () => {
  test("help prints the usage and runs nothing", async () => {
    let out = ""
    const code = await runMigrateCommand({ from: "", dir: "", dryRun: false, memories: true, json: false, help: true }, { out: { write: (t) => void (out += t) }, err: { write: () => {} }, home: "/home" })
    expect(code).toBe(0)
    expect(out).toContain("usage: mendcode migrate-v1")
  })

  test("a refusal prints one error line and exits 65", async () => {
    let err = ""
    const code = await runMigrateCommand(
      { from: "/definitely/not/a/v1/dir", dir: "/tmp/never-created", dryRun: true, memories: true, json: false, help: false },
      { out: { write: () => {} }, err: { write: (t) => void (err += t) }, home: "/home" },
    )
    expect(code).toBe(65)
    expect(err).toMatch(/^error: .*mendcode-local\.db/)
  })
})

describe("decodeDataUrl", () => {
  test("decodes base64 payloads with their mime", () => {
    const decoded = decodeDataUrl(PNG_URL)
    expect(decoded.mime).toBe("image/png")
    expect(decoded.bytes.byteLength).toBe(PNG_BYTES)
    expect(Buffer.from(decoded.bytes).toString("base64")).toBe(PNG_BASE64)
  })

  test("decodes percent-encoded text and defaults the mime", () => {
    expect(new TextDecoder().decode(decodeDataUrl("data:text/plain;charset=utf-8,hello%20world").bytes)).toBe("hello world")
    expect(decodeDataUrl("data:;base64,aGk=").mime).toBe("application/octet-stream")
  })

  test("rejects what is not a data URL or has a broken payload", () => {
    expect(() => decodeDataUrl("https://example.test/a.png")).toThrow()
    expect(() => decodeDataUrl("data:image/png;base64,@@@")).toThrow("base64")
    expect(() => decodeDataUrl("data:image/png;base64,abcde")).toThrow("base64")
  })
})

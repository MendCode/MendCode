import { describe, expect, test } from "bun:test"
import { httpHookAllowed } from "../src/shell-hooks"

describe("allowedHttpHookUrls patterns", () => {
  test("a wildcard in the host never reaches into the path, query, fragment or userinfo of another host", () => {
    const patterns = ["https://*.example.com/*"]
    expect(httpHookAllowed("https://hooks.example.com/notify", patterns)).toBe(true)
    expect(httpHookAllowed("https://a.b.example.com/x?y=1", patterns)).toBe(true)
    expect(httpHookAllowed("https://evil.test/x.example.com/y", patterns)).toBe(false)
    expect(httpHookAllowed("https://evil.test?.example.com/y", patterns)).toBe(false)
    expect(httpHookAllowed("https://evil.test#.example.com/y", patterns)).toBe(false)
    expect(httpHookAllowed("https://evil.test\\@hooks.example.com/y", patterns)).toBe(false)
    expect(httpHookAllowed("https://hooks.example.com@evil.test/y", ["https://hooks.example.com*"])).toBe(false)
    expect(httpHookAllowed("https://hooks.example.com:443@evil.test/y", ["https://hooks.example.com:*/*"])).toBe(false)
  })

  test("exact URLs, path wildcards, ports and an empty list keep their meaning", () => {
    expect(httpHookAllowed("https://hooks.example.com/notify", ["https://hooks.example.com/notify"])).toBe(true)
    expect(httpHookAllowed("https://hooks.example.com/notify/2", ["https://hooks.example.com/notify"])).toBe(false)
    expect(httpHookAllowed("https://hooks.example.com/a/b?c=1", ["https://hooks.example.com/*"])).toBe(true)
    expect(httpHookAllowed("http://127.0.0.1:8080/hook", ["http://127.0.0.1:*/hook"])).toBe(true)
    expect(httpHookAllowed("http://127.0.0.1:8080/hook", ["http://localhost:*/hook"])).toBe(false)
    expect(httpHookAllowed("https://hooks.example.com/notify", [])).toBe(false)
    expect(httpHookAllowed("https://hooks.example.com/notify", undefined)).toBe(false)
    expect(httpHookAllowed("https://anything.test/x", ["*"])).toBe(true)
  })
})

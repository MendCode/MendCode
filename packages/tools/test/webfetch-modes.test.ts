import { afterEach, expect, test } from "bun:test"
import { webfetch } from "../src"
import { makeContext, useTempDir } from "./helpers"

const temp = useTempDir()
const original = globalThis.fetch
afterEach(() => { globalThis.fetch = original })

test("PDF mode is explicit, execution-approved and bounded, with an injected local extractor", async () => {
  const ctx = makeContext({ cwd: temp() })
  expect(webfetch.permissionFor?.({ url: "https://8.8.8.8/a.pdf", mode: "pdf" })).toBe("execute")
  let extracts = 0
  ctx.webfetchResources = { pdf: async () => {
    extracts++
    return "Extracted PDF text"
  }, clone: async () => "" }
  globalThis.fetch = (async () => new Response("%PDF-1.7 local fixture", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch
  const output = await webfetch.execute({ url: "https://8.8.8.8/a.pdf", mode: "pdf" }, ctx)
  expect(output.output).toBe("Extracted PDF text")
  expect(extracts).toBe(1)
  globalThis.fetch = (async () => new Response("not PDF", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch
  expect((await webfetch.execute({ url: "https://8.8.8.8/a.pdf", mode: "pdf" }, ctx)).isError).toBe(true)
  expect(extracts).toBe(1)
})

test("clone accepts only owner/repo, honors domain policy and unavailable ports", async () => {
  const ctx = makeContext({ cwd: temp() })
  let clones = 0
  ctx.webfetchResources = { pdf: async () => "", clone: async (repo) => {
    clones++
    expect(repo).toBe("owner/repo")
    return "/scratch/repo"
  } }
  expect((await webfetch.execute({ url: "owner/repo", mode: "github" }, ctx)).output).toContain("/scratch/repo")
  for (const url of ["--config/x", "owner/../repo", "https://github.com/owner/repo"]) expect((await webfetch.execute({ url, mode: "github" }, ctx)).isError).toBe(true)
  expect(clones).toBe(1)
  delete ctx.webfetchResources
  expect((await webfetch.execute({ url: "owner/repo", mode: "github" }, ctx)).isError).toBe(true)
})

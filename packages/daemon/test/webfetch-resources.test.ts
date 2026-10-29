import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createWebfetchResources } from "../src/webfetch-resources"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-resources-"))
  dirs.push(dir)
  return dir
}
test("daemon PDF argv and scratch cleanup, with a fake process and no network", async () => {
  const root = temp()
  let argv: string[] = []
  const resources = createWebfetchResources(root, async (args) => {
    argv = args
    return "PDF text"
  })
  expect(await resources.pdf(new TextEncoder().encode("%PDF-"), new AbortController().signal)).toBe("PDF text")
  expect(argv.slice(0, 6)).toEqual(["pdftotext", "-f", "1", "-l", "100", "-layout"])
  expect(readdirSync(root)).toEqual([])
})
test("clone uses closed HTTPS argv, cleans failure and refuses network-off sandboxes", async () => {
  const root = temp()
  let argv: string[] = []
  const resources = createWebfetchResources(root, async (args) => {
    argv = args
    throw new Error("fake failure")
  })
  await expect(resources.clone("owner/repo", new AbortController().signal)).rejects.toThrow("fake failure")
  expect(argv).toContain("https://github.com/owner/repo.git")
  expect(argv).toContain("credential.helper=")
  expect(argv).toContain("core.hooksPath=/dev/null")
  expect(readdirSync(root)).toEqual([])
  await expect(resources.clone("owner/repo", new AbortController().signal, { mode: "workspace-write", network: false, writable: [], protect: [] })).rejects.toThrow("refused")
})

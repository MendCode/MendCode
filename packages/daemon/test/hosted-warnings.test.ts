import { afterEach, expect, test } from "bun:test"
import { hosting } from "../src/hosting"
import { postStatus } from "../src/pr-review/commit-status"

const saved = { ...hosting }
const write = process.stderr.write.bind(process.stderr)
afterEach(() => {
  Object.assign(hosting, saved)
  delete hosting.log
  process.stderr.write = write
})

const refused = async () => ({ code: 1, out: "", err: "gh: Not Found (HTTP 404)" })

test("a refused commit status in a daemon a terminal hosts goes to the daemon's log, never the terminal's screen", async () => {
  const logged: string[] = []
  const screen: string[] = []
  hosting.active = true
  hosting.log = (level, message) => void logged.push(`${level} ${message}`)
  process.stderr.write = ((chunk: string) => (screen.push(String(chunk)), true)) as typeof process.stderr.write
  const ok = await postStatus({ gh: refused, repo: "owner/hosted-repo", sha: "abc", state: "pending", description: "x", context: "MendCode review", targetUrl: "https://example.test" })
  expect(ok).toBe(false)
  expect(screen).toEqual([])
  expect(logged).toHaveLength(1)
  expect(logged[0]).toStartWith("warn [PR_REVIEW]: GitHub refused the commit status on owner/hosted-repo")
})

test("the same refusal in a daemon of its own (or a CI run) still reaches stderr", async () => {
  const screen: string[] = []
  process.stderr.write = ((chunk: string) => (screen.push(String(chunk)), true)) as typeof process.stderr.write
  await postStatus({ gh: refused, repo: "owner/own-repo", sha: "abc", state: "pending", description: "x", context: "MendCode review", targetUrl: "https://example.test" })
  expect(screen.join("")).toContain("GitHub refused the commit status on owner/own-repo")
})

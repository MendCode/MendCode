import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createUiReload } from "../src/customize-ui"

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ui-reload-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function put(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
/**
 * `again` repeats the action every 250 ms: macOS starts a native watch on another thread, so a write made right after arming can
 * precede it. Slower than the reload debounce (80 ms, restarted by every event), or the repeats would keep postponing the reload.
 */
async function until(check: () => boolean, ms = 3_000, again?: () => void) {
  const end = Date.now() + ms
  let last = Date.now()
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    if (again && Date.now() - last >= 250) { again(); last = Date.now() }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

test("the user data dir reloads for skills, commands, agents and extensions of its own and of its packages, and ignores unrelated files", async () => {
  const dir = temp()
  mkdirSync(path.join(dir, "packages", "kit"), { recursive: true })
  mkdirSync(path.join(dir, "skills"), { recursive: true })
  let changes = 0
  const service = createUiReload({ dir, load: async () => [], emit: () => { changes++ } })
  cleanups.push(service.stop)
  service.start()
  put(path.join(dir, "sessions.db-journal"), "noise")
  put(path.join(dir, "packages", "kit", "notes.txt"), "noise")
  await settle()
  expect(changes).toBe(0)
  put(path.join(dir, "skills", "x", "SKILL.md"), "---\ndescription: x\n---\nbody")
  await until(() => changes > 0)
  const afterSkill = changes
  put(path.join(dir, "packages", "kit", "commands", "ship.md"), "ship")
  await until(() => changes > afterSkill)
  const afterCommand = changes
  put(path.join(dir, "packages", "kit", "extensions", "hello.ts"), "export default { name: 'hello' }")
  await until(() => changes > afterCommand)
  // The data dir's keybindings.json: the terminal reads it again on the same event.
  const afterExtension = changes
  put(path.join(dir, "keybindings.json"), '{ "ctrl+g": "command:git" }')
  await until(() => changes > afterExtension)
})

test("a trusted project's own folders and packages reload; a project that is not offered is never watched", async () => {
  const dir = temp(), trusted = temp(), untrusted = temp()
  mkdirSync(path.join(trusted, ".mendcode", "packages", "kit"), { recursive: true })
  mkdirSync(path.join(untrusted, ".mendcode"), { recursive: true })
  const reloaded: string[] = []
  const service = createUiReload({ dir, load: async (directory) => { reloaded.push(directory); return [] }, emit: () => {}, projects: () => [trusted] })
  cleanups.push(service.stop)
  service.start()
  put(path.join(untrusted, ".mendcode", "skills", "x", "SKILL.md"), "body")
  await settle()
  expect(reloaded).toEqual([])
  put(path.join(trusted, ".mendcode", "commands", "ship.md"), "ship")
  await until(() => reloaded.length > 0)
  expect(reloaded[0]).toBe(trusted)
  const before = reloaded.length
  put(path.join(trusted, ".mendcode", "packages", "kit", "skills", "y", "SKILL.md"), "body")
  await until(() => reloaded.length > before)
})

test("a burst of edits is one debounced reload, and the number of watched project folders is bounded", async () => {
  const dir = temp()
  const projects = Array.from({ length: 40 }, () => temp())
  for (const project of projects) mkdirSync(path.join(project, ".mendcode"), { recursive: true })
  let changes = 0
  const service = createUiReload({ dir, load: async () => [], emit: () => { changes++ }, projects: () => projects })
  cleanups.push(service.stop)
  service.start()
  expect(service.watching()).toBeLessThanOrEqual(1 + 16)
  for (let i = 0; i < 10; i++) put(path.join(projects[0]!, ".mendcode", "commands", `c${i}.md`), `c${i}`)
  // The native watch arms on another thread on macOS, so the burst can precede it: one more write per round until it is seen.
  await until(() => changes > 0, 3_000, () => put(path.join(projects[0]!, ".mendcode", "commands", "late.md"), "late"))
  await settle()
  // Ten writes may reach the watcher in a few batches, never as ten reloads.
  expect(changes).toBeLessThanOrEqual(3)
})

test("sync starts watching a project that became trusted after start", async () => {
  const dir = temp(), project = temp()
  mkdirSync(path.join(project, ".mendcode"), { recursive: true })
  const offered: string[] = []
  let changes = 0
  const service = createUiReload({ dir, load: async () => [], emit: () => { changes++ }, projects: () => offered })
  cleanups.push(service.stop)
  service.start()
  put(path.join(project, ".mendcode", "commands", "a.md"), "a")
  await settle()
  expect(changes).toBe(0)
  offered.push(project)
  service.sync()
  put(path.join(project, ".mendcode", "commands", "b.md"), "b")
  await until(() => changes > 0, 3_000, () => put(path.join(project, ".mendcode", "commands", "b.md"), "b"))
  offered.length = 0
  service.sync()
  expect(service.watching()).toBe(1)
})

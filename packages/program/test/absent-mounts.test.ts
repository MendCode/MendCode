import { beforeEach, expect, test } from "bun:test"
import { ABSENT_MOUNT_TTL_MS, forgetAbsentMounts, underAbsentMount } from "../src/absent-mounts"

beforeEach(() => forgetAbsentMounts())

test("a folder under an automounted /home name that is not here is absent, and the name is asked once while the answer holds", () => {
  const asked: string[] = []
  const exists = (path: string) => { asked.push(path); return path === "/home/here" }
  const at = (now: number) => ({ platform: "darwin", now, exists })
  expect(underAbsentMount("/home/coder/projects/app", at(0))).toBe(true)
  expect(underAbsentMount("/home/coder/projects/app/.git", at(10))).toBe(true)
  expect(underAbsentMount("/home/here/projects/app", at(20))).toBe(false)
  expect(underAbsentMount("/net/host/share", at(30))).toBe(true)
  expect(asked).toEqual(["/home/coder", "/home/here", "/net/host"])
  expect(underAbsentMount("/home/coder/x", at(ABSENT_MOUNT_TTL_MS + 1))).toBe(true)
  expect(asked).toEqual(["/home/coder", "/home/here", "/net/host", "/home/coder"])
})

test("other folders and other systems are never judged absent and never asked", () => {
  const exists = () => { throw new Error("asked") }
  for (const path of ["/Users/someone/code", "/tmp/x", "/home", "/home/", "/homework/x"]) expect(underAbsentMount(path, { platform: "darwin", exists })).toBe(false)
  expect(underAbsentMount("/home/coder/projects", { platform: "linux", exists })).toBe(false)
})

import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ancestorLayers, extensionLayers, listPackages } from "../src"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A home whose `.mendcode` is the data directory, `.mendcode-v2` a link to it, and a plain folder under it. */
function home() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "home-layer-")))
  dirs.push(root)
  const data = path.join(root, ".mendcode")
  mkdirSync(path.join(data, "packages", "demo"), { recursive: true })
  writeFileSync(path.join(data, "packages", "demo", "mendcode-package.json"), JSON.stringify({ name: "demo", version: "1.0.0", description: "demo" }))
  symlinkSync(".mendcode", path.join(root, ".mendcode-v2"))
  const projects = path.join(root, "projects")
  mkdirSync(projects)
  return { root, data, link: path.join(root, ".mendcode-v2"), projects }
}

test("a folder whose .mendcode is the data directory lists each profile once, as a user profile", () => {
  const { root, data, link } = home()
  for (const userDir of [data, link]) {
    expect(listPackages({ userDir, directory: root }).map((item) => item.key)).toEqual(["user:demo"])
    expect(extensionLayers({ userDir, directory: root }).filter((layer) => layer.source === "project")).toEqual([])
  }
})

test("a non-git folder under the home has no project layer and inherits nothing from the home", () => {
  const { root, data, projects } = home()
  expect(listPackages({ userDir: data, directory: projects }).map((item) => item.key)).toEqual(["user:demo"])
  expect(extensionLayers({ userDir: data, directory: projects }).filter((layer) => layer.source === "project").map((layer) => layer.dir)).toEqual([path.join(projects, ".mendcode")])
  expect(ancestorLayers({ directory: projects, home: root, userDir: data })).toEqual([])
})

test("a parent repository whose .mendcode is the data directory is not a project layer", () => {
  const { root, data, projects } = home()
  mkdirSync(path.join(root, ".git"))
  expect(ancestorLayers({ directory: projects, home: path.dirname(root), userDir: data })).toEqual([])
})

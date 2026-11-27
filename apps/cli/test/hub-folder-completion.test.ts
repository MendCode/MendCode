import { expect, test } from "bun:test"
import { pathMatches } from "../src/view/path-arguments"
import { slashSuggestions } from "../src/view/commands"

const hub = (listing: Record<string, string[] | undefined>) => (head: string) => listing[head]

test("/cd completion of a chat that runs on the hub lists the hub's folders, not this machine's disk", () => {
  const names = ["APP-NEXT", "apps", "docs", ".git"]
  const folders = hub({ "": names, "APP-NEXT/": ["src"] })
  // The session folder does not exist here: nothing is read from the disk.
  const base = "/home/coder/projects"
  expect(pathMatches({ command: "cd", args: "APP-", base, hubFolders: folders }).map((match) => match.name)).toEqual(["cd APP-NEXT/"])
  expect(pathMatches({ command: "cd", args: "AP", base, hubFolders: folders }).map((match) => match.name)).toEqual(["cd APP-NEXT/", "cd apps/"])
  expect(pathMatches({ command: "cd", args: "", base, hubFolders: folders }).map((match) => match.name)).toEqual(["cd APP-NEXT/", "cd apps/", "cd docs/"])
  expect(pathMatches({ command: "cd", args: ".", base, hubFolders: folders }).map((match) => match.name)).toEqual(["cd .git/"])
  expect(pathMatches({ command: "cd", args: "APP-NEXT/s", base, hubFolders: folders }).map((match) => match.name)).toEqual(["cd APP-NEXT/src/"])
})

test("while the hub's answer is not here yet the menu offers nothing, and other path commands never use the hub's list", () => {
  const waiting = hub({})
  expect(pathMatches({ command: "cd", args: "AP", base: "/home/coder/projects", hubFolders: waiting })).toEqual([])
  expect(pathMatches({ command: "attach", args: "", base: "/home/coder/projects", hubFolders: hub({ "": ["a"] }) })).toEqual([])
  expect(slashSuggestions("/cd AP", [], undefined, [], "/home/coder/projects", hub({ "": ["APP-NEXT"] })).map((command) => command.name)).toEqual(["cd APP-NEXT/"])
})

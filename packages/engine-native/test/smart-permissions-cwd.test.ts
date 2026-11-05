import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { classifySmart } from "../src"

const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "smart-cwd-")))
afterAll(() => rmSync(parent, { recursive: true, force: true }))
const project = path.join(parent, "worktree")
mkdirSync(path.join(project, "packages", "widgets"), { recursive: true })

const shell = (command: string, workdir?: string) =>
  classifySmart({ tool: { name: "shell", permission: "execute" }, args: { command, ...(workdir ? { workdir } : {}) }, cwd: project, allowCommands: ["bun test"] })

const REPORTED = 'bun scripts/gen-registry.ts; ../../node_modules/.bin/tsc --noEmit -p .; bun test'

describe("smart mode resolves relative paths against the directory the command runs in", () => {
  test("the reported line from packages/widgets reaches the project's node_modules, inside the project", () => {
    expect(shell("cat ../../node_modules/.bin/tsc", "packages/widgets")).toMatchObject({ decision: "allow" })
    expect(shell("../../node_modules/.bin/tsc --noEmit -p .", "packages/widgets")).toMatchObject({ decision: "allow" })
    // `bun scripts/...` is not on the allow list, but the reason is no longer "outside the project".
    expect(shell(REPORTED, "packages/widgets").rule).not.toBe("outside-project")
  })

  test("an absolute workdir inside the project works the same", () => {
    expect(shell("cat ../../node_modules/.bin/tsc", path.join(project, "packages", "widgets"))).toMatchObject({ decision: "allow" })
  })

  test("a relative path that leaves the project from the real directory still asks", () => {
    expect(shell("cat ../../../etc/x", "packages/widgets")).toMatchObject({ decision: "ask", risk: "high", rule: "outside-project" })
    expect(shell("cat ../../../worktree/package.json", "packages/widgets")).toMatchObject({ decision: "allow" })
  })

  test("without a workdir the root is still the base", () => {
    expect(shell("cat ../../node_modules/.bin/tsc")).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("a workdir outside the project asks, and its relative paths are not trusted", () => {
    expect(shell("cat x", parent)).toMatchObject({ decision: "ask", rule: "outside-project" })
    expect(shell("cat ../worktree/x", parent)).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("a leading cd moves the base for the commands after it", () => {
    expect(shell("cd packages/widgets && cat ../../node_modules/.bin/tsc")).toMatchObject({ decision: "allow" })
    expect(shell("cd packages/widgets && cat ../../../etc/x")).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("cd out of the project asks, and so do the paths after it", () => {
    expect(shell("cd .. && ls")).toMatchObject({ decision: "ask", rule: "outside-project" })
    expect(shell("cd .. ; cat worktree/package.json")).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("a cd whose target the text does not give asks", () => {
    expect(shell("cd - && cat a")).toMatchObject({ decision: "ask" })
    expect(shell("cd $DIR && cat a")).toMatchObject({ decision: "ask" })
  })
})

describe("smart mode judges a project node_modules binary as the command it names", () => {
  test("tsc through node_modules/.bin runs like tsc, from the root and from a subdirectory", () => {
    expect(shell("node_modules/.bin/tsc --noEmit -p .")).toMatchObject({ decision: "allow" })
    expect(shell("../../node_modules/.bin/tsc --noEmit -p .", "packages/widgets")).toMatchObject({ decision: "allow" })
  })

  test("a binary with no known command still asks, and one outside the project still asks", () => {
    expect(shell("node_modules/.bin/some-tool --run")).toMatchObject({ decision: "ask", rule: "unlisted-command" })
    expect(shell("../../../node_modules/.bin/tsc -p .", "packages/widgets")).toMatchObject({ decision: "ask", rule: "outside-project" })
  })

  test("the exit status in an echo hides nothing, other expansions still ask", () => {
    expect(shell('echo "GEN_EXIT=$?"')).toMatchObject({ decision: "allow" })
    expect(shell('echo "$HOME"')).toMatchObject({ decision: "ask", rule: "shell-expansion" })
  })

  test("the reported line only asks for the project script it runs", () => {
    const verdict = shell('bun scripts/gen-registry.ts; echo "GEN_EXIT=$?"; ../../node_modules/.bin/tsc --noEmit -p .; echo "TSC_EXIT=$?"; bun test', "packages/widgets")
    expect(verdict).toMatchObject({ decision: "ask", rule: "unlisted-command", reason: "bun is not on the allow list" })
    expect(shell('echo "GEN_EXIT=$?"; ../../node_modules/.bin/tsc --noEmit -p .; echo "TSC_EXIT=$?"; bun test', "packages/widgets")).toMatchObject({ decision: "allow" })
  })
})

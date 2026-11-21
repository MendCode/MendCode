import { describe, expect, test } from "bun:test"
import { patternTerms, searchTerms } from "../src"

describe("the identifiers of a text search", () => {
  test("come from the pattern of grep, rg and git grep, quoted or not", () => {
    expect(searchTerms("grep -rn createIndexer packages")).toEqual(["createIndexer"])
    expect(searchTerms(`grep -rn "createIndexer" packages/`)).toEqual(["createIndexer"])
    expect(searchTerms("rg 'createIndexer' -t ts")).toEqual(["createIndexer"])
    expect(searchTerms("git grep -n createIndexer -- '*.ts'")).toEqual(["createIndexer"])
    expect(searchTerms("git -C /repo grep createIndexer")).toEqual(["createIndexer"])
    expect(searchTerms("/usr/bin/grep -c createIndexer file.ts")).toEqual(["createIndexer"])
  })

  test("an alternation gives each of its names, in -E, in basic syntax and in a group", () => {
    expect(searchTerms(`grep -rniE 'safety_off|SAFETY_OFF|safetyoff' --include='*.h' --include='*.c' .`)).toEqual(["safety_off", "SAFETY_OFF", "safetyoff"])
    expect(searchTerms(`grep -rn "loadCache\\|saveCache" src`)).toEqual(["loadCache", "saveCache"])
    expect(searchTerms(`rg -n "\\b(loadCache|saveCache)\\b"`)).toEqual(["loadCache", "saveCache"])
    expect(searchTerms("grep -rn loadCache\\|saveCache src")).toEqual(["loadCache", "saveCache"])
  })

  test("options and their values are not the pattern: -w, --include, -g, -A, -e, -m", () => {
    expect(searchTerms("grep -rnw --include '*.ts' buildGraph .")).toEqual(["buildGraph"])
    expect(searchTerms("grep -rn --include=*.ts -A 3 buildGraph .")).toEqual(["buildGraph"])
    expect(searchTerms("rg -w -g '*.ts' -A3 buildGraph packages")).toEqual(["buildGraph"])
    expect(searchTerms("grep -rn -e buildGraph -e scanFile src")).toEqual(["buildGraph", "scanFile"])
    expect(searchTerms("rg -m 5 --glob '!dist' buildGraph")).toEqual(["buildGraph"])
    expect(searchTerms("grep -rne buildGraph src")).toEqual(["buildGraph"])
    expect(searchTerms("rg -F 'Service.run' src")).toEqual(["Service.run"])
  })

  test("a search inside a longer command line is found: cd, pipes, xargs, find -exec, an assignment", () => {
    expect(searchTerms("cd packages && grep -rn buildGraph . | head -20")).toEqual(["buildGraph"])
    expect(searchTerms("find . -name '*.ts' | xargs grep -n buildGraph")).toEqual(["buildGraph"])
    expect(searchTerms("find src -name '*.ts' -exec grep -l buildGraph {} +")).toEqual(["buildGraph"])
    expect(searchTerms("LC_ALL=C grep -rn buildGraph src; rg scanFile")).toEqual(["buildGraph", "scanFile"])
  })

  test("how a declaration or a call is searched still names the symbol", () => {
    expect(searchTerms(`grep -rn "function buildGraph" src`)).toEqual(["buildGraph"])
    expect(searchTerms(`rg "class\\s+Service\\b"`)).toEqual(["Service"])
    expect(searchTerms(`rg "buildGraph\\("`)).toEqual(["buildGraph"])
    expect(searchTerms(`grep -rn "^export const helper" src`)).toEqual(["helper"])
    expect(patternTerms("Service\\.run")).toEqual(["Service.run"])
  })

  test("text that is not one plain name gives nothing", () => {
    for (const command of [
      "ls -la", "cat src/a.ts", "git status", "echo grep", "grep -rn 'TODO' src", "grep -rn 'foo.*bar' src", "rg 'user [a-z]+' .", "grep -rn 'two words here' src",
      "grep -c '' file", "rg --files", "grep -rn \"it's broken", "rg 'ab'", "grep -rn error logs/", "rg -n '\\d+ms'",
    ]) expect(searchTerms(command)).toEqual([])
    expect(patternTerms("a".repeat(500))).toEqual([])
  })

  test("at most six candidate names leave one search", () => {
    expect(searchTerms("rg 'aaa1|aaa2|aaa3|aaa4|aaa5|aaa6|aaa7|aaa8'")).toHaveLength(6)
  })
})

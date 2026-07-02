import { describe, expect, test } from "bun:test"

describe("session route initialization", () => {
  test("declares followSessionOutput before effects and memos read it", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const declaration = "const [followSessionOutput, setFollowSessionOutput] = createSignal(true)"
    const firstDeclarationIndex = source.indexOf(declaration)

    expect(firstDeclarationIndex).toBeGreaterThan(-1)
    expect(source.indexOf(declaration, firstDeclarationIndex + declaration.length)).toBe(-1)
    expect(firstDeclarationIndex).toBeLessThan(source.indexOf("setFollowSessionOutput(false)"))
    expect(firstDeclarationIndex).toBeLessThan(source.indexOf("followOutput: followSessionOutput()"))
    expect(firstDeclarationIndex).toBeLessThan(source.indexOf("stickyScroll={followSessionOutput()}"))
  })

  test("resets and guards scroll paging state across session changes", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain("let scrollPagingToken = 0")
    expect(source).toContain("scrollPagingToken += 1")
    expect(source).toContain("scrollPagingInFlight = false")
    expect(source).toContain("suppressedPagingBoundary = undefined")
    expect(source).toContain("setFollowSessionOutput(true)")
    expect(source).toContain("if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return")
  })
})

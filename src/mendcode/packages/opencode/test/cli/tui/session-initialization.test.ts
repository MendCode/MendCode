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
    expect(source).toContain("shouldDeferSessionFollowSync(sync.session.history(route.sessionID))")
  })

  test("settles submit with one post-render scroll and no stale editor spacer", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain("const scheduleSubmitBottomScroll = (sessionID: string) =>")
    expect(source).toContain("scheduleSubmitBottomScroll(options.submitSessionID)")
    expect(source).toContain("if (submitBottomScrollSessionID === route.sessionID) return")
    expect(source).not.toContain("scheduleSubmitBottomScrollPasses")
    expect(source).not.toContain("submitViewportHold")
    expect(source).not.toContain("submittedPromptViewportHold")
  })

  test("offers a reversible compacted tool-call command with a RAM warning", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('value: "session.toggle.compacted_tool_calls"')
    expect(source).toContain("can substantially increase RAM usage")
    expect(source).toContain("setShowCompactedToolCalls(() => enable)")
    expect(source).toContain("await sync.session.reloadMessages(route.sessionID)")
  })

  test("keeps queued prompt actions on the header row", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('if (mode === "after-tools") return "Waiting for the current tool iteration to finish"')
    expect(source).toContain('return "Waiting for the current response to finish"')
    expect(source).toContain("· {queuedPromptWaitLabel(sync.data.config.queue?.mode)}")
    expect(source).toContain("bg: sendNowBackground()")
    expect(source).toContain('" ↗ SEND "')
    expect(source).not.toContain("<Show when={queued() && props.onSendNow}>")
  })
})

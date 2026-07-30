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

  test("keeps loop card clicks scoped and restores each session scroll position", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const sessionV2 = await Bun.file(
      new URL("../../../src/cli/cmd/tui/feature-plugins/system/session-v2.tsx", import.meta.url),
    ).text()

     expect(source).toContain("const sessionScrollStates = new Map<string, SessionScrollState>()")
     expect(source).toContain("const scheduleSessionScrollRestore = (sessionID: string, state?: SessionScrollState) =>")
     expect(source).toContain("const navigate = (...args: Parameters<typeof navigateRoute>) =>")
     expect(source).toContain("return navigateRoute(...args)")
     expect(source).toContain("if (activeSessionID !== sessionID) rememberSessionScroll(activeSessionID)")


    expect(source).toContain("onMouseUp={handleOpenTarget}")
    expect(sessionV2).toContain("const handleOpenFirstLoop = () =>")
    expect(sessionV2).toContain("onMouseUp={handleOpenFirstLoop}")
  })

  test("captures an outgoing anchor and restores it after transcript growth", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const scroll = await Bun.file(new URL("../../../src/cli/cmd/tui/util/scroll.ts", import.meta.url)).text()

    expect(source).toContain("persistSessionScroll(currentSessionID)")
    expect(source).toContain("anchor = captureScrollAnchor()")
    expect(source).not.toContain("rememberSessionScroll(currentSessionID)\n    setSessionScrollTop(scrollTop)")
    expect(source).toContain("anchor,")
    expect(source).toContain("scrollAnchor = remembered?.anchor")
    expect(source).toContain("const restored = state?.anchor ? restoreScrollAnchor({ preserveMissing: true }) : false")
    expect(source).toContain("const delays = [0, 16, 50, 120, 240, 480, 960]")
    expect(scroll).toContain("anchor?: {")
    expect(scroll).toContain("id: string")
    expect(scroll).toContain("offset: number")
  })

  test("settles submit with one post-render scroll and no stale editor spacer", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain("const scheduleSubmitBottomScroll = (sessionID: string) =>")
    expect(source).toContain("scheduleSubmitBottomScroll(options.submitSessionID)")
    expect(source).toContain("if (options?.sync !== false) void sync.session.sync(route.sessionID, { force: true })")
    expect(source).toContain("toBottom({\n      sync: false,\n      submitSessionID:")
    expect(source).toContain("if (submitBottomScrollSessionID === route.sessionID) return")
    expect(source).not.toContain("scheduleSubmitBottomScrollPasses")
    expect(source).not.toContain("submitViewportHold")
    expect(source).not.toContain("submittedPromptViewportHold")
  })

  test("offers a reversible compacted tool-call command with a bounded-loading warning", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('value: "session.toggle.compacted_tool_calls"')
    expect(source).toContain("progressively so long sessions stay responsive")
    expect(source).toContain("setShowCompactedToolCalls(() => enable)")
    expect(source).toContain("await sync.session.reloadMessages(route.sessionID)")
  })

  test("keeps queued prompts in the transcript flow above the editor", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('if (mode === "after-tools") return "Waiting for the current tool iteration to finish"')
    expect(source).toContain('return "Waiting for the current response to finish"')
    expect(source).toContain("const transcriptRows = createMemo")
    expect(source).toContain("total: transcriptRows().length")
    expect(source).toContain(
      "sessionTranscriptRows(messages(), queuedMessageIDs(), { boundaryIDs: compactionBoundaryIDs })",
    )
    expect(source).toContain("<For each={visibleMessageIDs()}>")
    expect(source).toContain("messageByID().get(messageID)")
    expect(source).toContain("queuedMessageIDs().has(message().id)")
    expect(source).not.toContain("queuedMessageRenderIDs")
    expect(source).toMatch(/queued\s+sticky/)
    expect(source).toContain("bg: sendNowBackground()")
    expect(source).toContain('" ↗ SEND "')
    expect(source).not.toContain("paddingTop={1} paddingBottom={1}")
    expect(source).not.toContain("pending={pending()}")
  })
})

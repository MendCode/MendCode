import { describe, expect, test } from "bun:test"

describe("session route initialization", () => {
  test("declares keybind before top navigation memos read it", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const declaration = "const keybind = useKeybind()"
    const firstDeclarationIndex = source.indexOf(declaration)

    expect(firstDeclarationIndex).toBeGreaterThan(-1)
    expect(source.indexOf(declaration, firstDeclarationIndex + declaration.length)).toBeGreaterThan(firstDeclarationIndex)
    expect(firstDeclarationIndex).toBeLessThan(source.indexOf('keybind.print("session_parent")'))
  })

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

    expect(source).toContain("const SESSION_OLDER_HISTORY_PAGING_ENABLED = false")
    expect(source).toContain("let scrollPagingToken = 0")
    expect(source).toContain("scrollPagingToken += 1")
    expect(source).toContain("scrollPagingInFlight = false")
    expect(source).toContain("suppressedPagingBoundary = undefined")
    expect(source).toContain("shouldClearSessionPagingBoundarySuppression({")
    expect(source).toContain('direction: delta < 0 ? "up" : "down"')
    expect(source).toContain("setFollowSessionOutput(true)")
    expect(source).toContain("if (pagingToken !== scrollPagingToken || route.sessionID !== currentSessionID) return")
    expect(source).toContain("shouldDeferSessionFollowSync(sync.session.history(route.sessionID))")
  })

  test("does not load older history when the viewport reaches the top", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const syncStart = source.indexOf("const syncScrollFollowMode")
    const bottomStart = source.indexOf("if (atBottom)", syncStart)
    const sync = source.slice(syncStart, bottomStart)

    expect(sync).toContain("SESSION_OLDER_HISTORY_PAGING_ENABLED &&")
    expect(sync).toContain(".loadOlder(currentSessionID)")
  })

  test("cancels delayed paging restoration when the viewport moves", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const restoreStart = source.indexOf("const restoreScrollAfterPaging")
    const restoreEnd = source.indexOf("const cancelBottomScrollTimers", restoreStart)
    const restore = source.slice(restoreStart, restoreEnd)

    expect(source).toContain("let scrollPagingRestoreToken = 0")
    expect(source).toContain("const cancelScrollPagingRestore = () =>")
    expect(restore).toContain("const delays = [0, 16, 50, 120, 240, 480]")
    expect(restore).toContain("restoreToken !== scrollPagingRestoreToken")
    expect(restore).toContain('boundary === "top" ? !isScrollboxAtTop(scroll, 1) : !isScrollboxAtBottom(scroll, 1)')
    expect(restore).toContain("armVirtualScrollAnchor(anchor?.id, anchor ? boundary : undefined)")
    expect(restore).toContain("restoreScrollAnchor({ preserveMissing: true })")
    expect(source).toContain("const pagingRestoreToken = scrollPagingRestoreToken")
    expect(source).toContain("pagingRestoreToken !== scrollPagingRestoreToken")
    expect(source).toContain("bottomFollowMode === \"follow\" && pagingRestoreToken === scrollPagingRestoreToken")
    expect(source).toContain("cancelScrollPagingRestore()\n    suppressedPagingBoundary = undefined")
  })

  test("uses the stable transcript tail for prompt activity while paging older history", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/component/prompt/index.tsx", import.meta.url)).text()

    expect(source).toContain("const messagesForActivity = createMemo")
    expect(source).toContain("latestAssistant: sync.data.session_latest_assistant[sessionID]")
    expect(source).toContain("const messages = messagesForActivity()")
  })

  test("publishes prompt delivery handoff state without a navigation timer", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/component/prompt/index.tsx", import.meta.url)).text()

    const begin = source.slice(source.indexOf("function beginPendingPromptDelivery"), source.indexOf("function endPendingPromptDelivery"))
    const end = source.slice(source.indexOf("function endPendingPromptDelivery"), source.indexOf("function cancelPendingPromptDeliveryForInterrupt"))
    expect(begin).toContain("notifyPendingPromptDeliveryListeners()")
    expect(end).toContain("if (removed) notifyPendingPromptDeliveryListeners()")
    expect(source.match(/pendingPromptDeliveryRevision\(\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(source).toContain("const queuedBehindActiveTurn = workingStatusActive()")
    expect(source.indexOf("const queuedBehindActiveTurn = workingStatusActive()")).toBeLessThan(
      source.indexOf("setSubmitPreflightActive(true)"),
    )
    expect(source).toContain("route.navigate({\n        type: \"session\",")
    expect(source).not.toContain("setTimeout(() => {\n        route.navigate({")
  })

  test("keeps stop acknowledgements in backend control without rendering frontend status copy", async () => {
    const frontend = await Bun.file(new URL("../../../src/cli/cmd/tui/component/prompt/index.tsx", import.meta.url)).text()
    const backend = await Bun.file(new URL("../../../src/session/prompt.ts", import.meta.url)).text()

    expect(frontend).not.toContain('return "stop requested"')
    expect(frontend).not.toContain('return "stop confirmed"')
    expect(frontend).not.toContain('return "turn already finished"')
    expect(frontend).not.toContain('return "stop reconciled;')
    expect(frontend).toContain("const control = sessionControl.status(sessionID)")
    expect(frontend).toContain('control.state === "stop_confirmed" && control.result !== "cancelled"')
    expect(backend).toContain('const cancelTurn = Effect.fn("SessionPrompt.cancelTurn")')
    expect(backend).toContain('yield* elog.info("cancel-turn", { ...input, important: true })')
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

  test("renders workflow tasks in the phase-ordered monitor rows", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/workflows/index.tsx", import.meta.url)).text()

    expect(source).toContain("const taskRows = createMemo")
    expect(source).toContain("<For each={taskRows().slice(0, 40)}>")
    expect(source).not.toContain("<For each={item().tasks.slice(0, 40)}>")
  })

  test("retries failed workflow work when resume is requested", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/workflows/index.tsx", import.meta.url)).text()

    expect(source).toContain("const target = workflowMonitorResumeTarget(receipt(item))")
    expect(source).toContain('if (target.kind === "retry-task")')
    expect(source).toContain('if (target.kind === "retry-phase")')
  })

  test("offers workflow sessions the same permission modes and global default controls", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/workflows/index.tsx", import.meta.url)).text()

    expect(source).toContain('title: "Require approval"')
    expect(source).toContain('title: "Smart Approval"')
    expect(source).toContain('title: "Full Access"')
    expect(source).toContain('title: "Use global default"')
    expect(source).toContain('title: "Set global default"')
    expect(source).toContain('title: "View permission details"')
    expect(source).toContain('sessionMode: mode ?? "global_default"')
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

  test("holds the submitted turn by message identity across relayouts", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain("const [submitScrollIntent, setSubmitScrollIntent] = createSignal")
    expect(source).toContain("const activateSubmitScrollIntent =")
    expect(source).toContain("const reconcileSubmitScrollIntent =")
    expect(source).toContain("const delta = child.y - scroll.y - intent.offset")
    expect(source).toContain("anchorIndex: virtualScrollAnchorIndex()")
    expect(source).toContain("if (!info.queuedBehindActiveTurn)")
    expect(source).toContain("submittedTurnIDs.has(pinnedID)")
    expect(source).toContain('<box id={message().id} width="100%" flexDirection="column" flexShrink={0}>')
    expect(source).not.toContain("scheduleSubmitBottomScroll")
    expect(source).not.toContain("submitBottomScrollSessionID")
  })

  test("mounts a bounded measured transcript window and keeps sticky lookup over logical history", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain("const measuredMessageHeights = new Map<string, number>()")
    expect(source).toContain("const updateMountedMessageHeights = () =>")
    expect(source).toContain("itemHeights: rows.map((message) => measuredMessageHeights.get(message.id))")
    expect(source).toContain("const visibleMessages = createMemo")
    expect(source).toContain("transcriptRows().slice(window.start, window.end)")
    expect(source).toContain("<For each={visibleMessageIDs()}>")
    expect(source).toContain("<box height={virtualWindow().topSpacer} flexShrink={0} />")
    expect(source).toContain("sessionTranscriptBottomSpacer(virtualWindow().bottomSpacer)")
    expect(source).toContain("stickyUserIDFromVirtualWindow({")
    expect(source).toContain("messages: transcriptRows()")
  })

  test("synchronizes the live scroll position before detaching follow mode", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
    const markStart = source.indexOf("const markScrollDetached = () =>")
    const markEnd = source.indexOf("const scrollToBottomIfAllowed", markStart)
    const mark = source.slice(markStart, markEnd)

    expect(mark).toContain("setSessionScrollTop(scroll.scrollTop)")
    expect(mark.indexOf("setSessionScrollTop(scroll.scrollTop)")).toBeLessThan(
      mark.indexOf("setFollowSessionOutput(false)"),
    )
    expect(source).toContain("onMouseScroll={() => queueMicrotask(markScrollDetached)}")
  })

  test("offers a reversible compacted tool-call command with a bounded-loading warning", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('value: "session.toggle.compacted_tool_calls"')
    expect(source).toContain("progressively so long sessions stay responsive")
    expect(source).toContain("setShowCompactedToolCalls(() => enable)")
    expect(source).toContain("await sync.session.reloadMessages(route.sessionID)")
  })

  test("keeps queued prompts in the measured transcript window", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('if (mode === "after-tools") return "Waiting for the current tool iteration to finish"')
    expect(source).toContain('return "Waiting for the current response to finish"')
    expect(source).toContain("const transcriptRows = createMemo")
    expect(source).toContain("return sessionTranscriptRows(messages(), queuedMessageIDs(), {")
    expect(source).toContain("return messages().filter((message): message is UserMessage => message.role === \"user\"")
    expect(source).toContain("tailIDs: pendingDeliveryTailIDs()")
    expect(source).toContain("const pendingDeliveryQueuedIDs = createMemo")
    expect(source).toContain("pendingPromptDeliveryMessageIDs(route.sessionID)")
    expect(source).toContain("!assistantParentIDs.has(messageID)")
    expect(source).toContain("<For each={visibleMessageIDs()}>")
    expect(source).toContain("messageByID().get(messageID)")
    expect(source).toContain("queuedMessageIDs().has(message().id)")
    expect(source).toContain('anchorID={`queued-${message().id}`}')
    expect(source).not.toContain("sessionTranscriptRowsForRender")
    expect(source).not.toContain('<Show when={queuedMessages().length > 0}>')
    expect(source).not.toContain('anchorID={`queued-dock-${message.id}`}')
    expect(source).not.toContain("queuedMessageRenderIDs")
    expect(source).toMatch(/queued\s+sticky/)
    expect(source).toContain("bg: sendNowBackground()")
    expect(source).toContain('" ↗ SEND "')
    expect(source).not.toContain("paddingTop={1} paddingBottom={1}")
    expect(source).not.toContain("pending={pending()}")
  })

  test("treats workflow task chats as children of the workflow monitor", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(source).toContain('mode={currentWorkflowTask() ? "workflow-task"')
    expect(source).toContain('return `↑ Workflow ${keybind.print("session_parent")}${cycle}`')
    expect(source).toContain('return `${workflowTask.workflowName} · Task ${workflowTask.taskIndex + 1}/${workflowTask.taskCount} · ${workflowTask.taskName}`')
    expect(source).toContain('type: "workflows"')
    expect(source).toContain("selectedID: workflowTask.runID")
    expect(source).toContain("navigateWorkflowTask(1, dialog)")
    expect(source).toContain("navigateWorkflowTask(-1, dialog)")
  })
})

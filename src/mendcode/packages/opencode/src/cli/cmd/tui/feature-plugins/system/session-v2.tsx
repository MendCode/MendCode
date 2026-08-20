import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mendcode/plugin/tui"
import { useSyncV2 } from "@tui/context/sync-v2"
import { useSync } from "@tui/context/sync"
import { latestTerminalOutputPreview, renderTerminalOutput, selectShellOutput } from "@tui/context/shell-output"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useTheme } from "@tui/context/theme"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { RGBA, TextAttributes, type BoxRenderable, type ScrollBoxRenderable, type SyntaxStyle } from "@opentui/core"
import { Locale } from "@/util/locale"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import path from "path"
import open from "open"
import * as Clipboard from "@tui/util/clipboard"
import { errorMessage } from "@/util/error"
import { useToast } from "@tui/ui/toast"
import {
  imageGenerationCanvasSize,
  imageGenerationWaitFrame,
  imageGenerationWaitFrameCount,
} from "@/mend/tui/image-generation-wait"
import type {
  SessionMessage,
  SessionMessageAgentSwitched,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageCompaction,
  SessionMessageModelSwitched,
  SessionMessageShell,
  SessionMessageSynthetic,
  SessionMessageUser,
  ToolFileContent,
  ToolTextContent,
} from "@mendcode/sdk/v2"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useMendTuiProfile } from "@tui/context/mend"
import { useCommandDialog } from "@tui/component/dialog-command"
import {
  memoryToolPresentation,
  normalizeToolEvent,
  shouldRenderCompactTool,
  shouldRenderImageGenerationTool,
  toolPresentationIcon,
  toolPresentationIconForProfile,
  webSearchUrlLines,
  wrapTimelineLine,
} from "@/mend/tui/timeline/normalize"
import { TimelineCode, TimelineDiff } from "@/cli/cmd/tui/routes/session/renderers/diff"
import { diffStatsFromPatch, formatDiffStats, patchFileTitle } from "@/cli/cmd/tui/routes/session/renderers/diff-label"
import { formatDuration } from "@/util/format"
import {
  compactPreviewLine,
  compactionSummaryPreview,
  rawReasoningDisplay,
  reasoningSummary,
  reasoningViewportMaxHeight,
  shouldDisplayReasoning,
  unavailableReasoningLabel,
} from "@/mend/tui/presentation"
import {
  sessionContentWidth,
  shouldRenderSessionLoopCard,
  shouldRenderSessionWorkflowCard,
} from "@/cli/cmd/tui/util/session-layout"
import { isScrollboxAtBottom } from "@/cli/cmd/tui/util/scroll"
import {
  hasMermaidFence,
  renderPlanMarkdown,
  renderPlanMarkdownStatic,
  renderStreamingMarkdownTail,
} from "@/cli/cmd/tui/util/markdown-render"
import { StyledPlanMarkdown } from "@/cli/cmd/tui/component/styled-plan-markdown"
import { CompactionPanel } from "@/cli/cmd/tui/component/compaction-panel"
import { visibleUserMessageText } from "@/cli/cmd/tui/routes/session/user-message-display"
import { MemoryGraphCanvasRows, memoryGraphMiniMap } from "@/cli/cmd/tui/routes/memory"
import { compactMemoryGraphRows, compactMemoryGraphSnapshot } from "@/cli/cmd/tui/util/memory-graph"
import { isToolActivityActive } from "@/cli/cmd/tui/util/session-working"
import {
  workflowReceiptFallbackPhases,
  workflowReceiptPhaseDiagram,
  workflowReceiptStateIsAnimated,
  workflowReceiptStateIsTerminal,
  workflowReceiptStateLabel,
  workflowReceiptStateMarker,
  type WorkflowReceiptPhaseInput,
} from "@/cli/cmd/tui/util/workflow-receipt"

const id = "internal:session-v2-debug"
const route = "session.v2.messages"

function currentSessionID(api: TuiPluginApi) {
  const current = api.route.current
  if (current.name !== "session") return
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function useSessionStatusType() {
  const route = useRoute()
  const sync = useSync()
  return createMemo(() => {
    const current = route.data
    if (current.type !== "session") return undefined
    return sync.data.session_status[current.sessionID]?.type
  })
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSyncV2()
  const command = useCommandDialog()
  const sessionStatusType = useSessionStatusType()
  const dimensions = useTerminalDimensions()
  const { theme, syntax, subtleSyntax } = useTheme()
  const contentWidth = createMemo(() => sessionContentWidth(dimensions().width, false))
  const messages = createMemo(() => sync.data.messages[props.sessionID] ?? [])
  const renderedMessages = createMemo(() => messages().toReversed())
  const lastAssistant = createMemo(() => renderedMessages().findLast((message) => message.type === "assistant"))
  const activeTool = createMemo(() =>
    messages().some(
      (message) =>
        message.type === "assistant" &&
        message.content.some(
          (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
        ),
    ),
  )
  const activeTurn = createMemo(() => {
    const status = sessionStatusType()
    return status === "busy" || status === "retry" || activeTool()
  })
  let scroll: ScrollBoxRenderable | undefined
  const [followSessionOutput, setFollowSessionOutput] = createSignal(true)
  let scrollAnchor: { id: string; offset: number } | undefined
  let lastObservedScrollTop = 0
  let lastObservedScrollHeight = 0
  let followBottomScrollToken = 0
  let followBottomScrollScheduled = false

  const scheduleFollowBottomScroll = () => {
    if (!followSessionOutput() || followBottomScrollScheduled) return
    followBottomScrollScheduled = true
    const token = ++followBottomScrollToken
    ;[0, 16, 50, 120, 240, 480, 960, 1_600, 2_400, 3_600, 5_200].forEach((delay, index, delays) => {
      setTimeout(() => {
        if (token !== followBottomScrollToken || !followSessionOutput() || !scroll || scroll.isDestroyed) {
          if (token === followBottomScrollToken) followBottomScrollScheduled = false
          return
        }
        scroll.scrollTo(scroll.scrollHeight)
        lastObservedScrollTop = scroll.scrollTop
        lastObservedScrollHeight = scroll.scrollHeight
        if (index === delays.length - 1 || isScrollboxAtBottom(scroll, 1)) followBottomScrollScheduled = false
      }, delay)
    })
  }

  const captureScrollAnchor = () => {
    if (!scroll || scroll.isDestroyed) {
      scrollAnchor = undefined
      return
    }

    const top = scroll.y
    const child = scroll
      .getChildren()
      .filter((item) => item.id && item.y >= top)
      .sort((a, b) => a.y - b.y)[0]
    scrollAnchor = child?.id ? { id: child.id, offset: child.y - top } : undefined
  }

  const restoreScrollAnchor = () => {
    if (!scroll || scroll.isDestroyed || !scrollAnchor) return
    const child = scroll.getChildren().find((item) => item.id === scrollAnchor?.id)
    if (!child) {
      captureScrollAnchor()
      return
    }

    const delta = child.y - scroll.y - scrollAnchor.offset
    if (delta !== 0) scroll.scrollBy(delta)
  }

  const syncScrollFollowMode = () => {
    if (!scroll || scroll.isDestroyed) return
    const scrollTop = scroll.scrollTop
    const scrollHeight = scroll.scrollHeight
    const wasFollowing = followSessionOutput()
    const contentHeightChanged = Math.abs(scrollHeight - lastObservedScrollHeight) > 1

    if (isScrollboxAtBottom(scroll)) {
      setFollowSessionOutput(true)
      scrollAnchor = undefined
      lastObservedScrollTop = scrollTop
      lastObservedScrollHeight = scrollHeight
      return
    }

    const userMovedViewport = Math.abs(scrollTop - lastObservedScrollTop) > 1 && !contentHeightChanged
    if (wasFollowing && !userMovedViewport && contentHeightChanged) {
      setFollowSessionOutput(true)
      scheduleFollowBottomScroll()
      lastObservedScrollTop = scrollTop
      lastObservedScrollHeight = scrollHeight
      return
    }

    setFollowSessionOutput(false)

    if (userMovedViewport || !scrollAnchor) {
      captureScrollAnchor()
    } else {
      restoreScrollAnchor()
      captureScrollAnchor()
    }

    lastObservedScrollTop = scroll.scrollTop
    lastObservedScrollHeight = scroll.scrollHeight
  }
  const lastUserCreated = (index: number) =>
    renderedMessages()
      .slice(0, index)
      .findLast((message) => message.type === "user")?.time.created

  createEffect(() => {
    void sync.session.message.sync(props.sessionID)
  })

  createEffect(() => {
    renderedMessages()
    if (followSessionOutput()) queueMicrotask(scheduleFollowBottomScroll)
  })

  onMount(() => {
    const timer = setInterval(syncScrollFollowMode, 80)
    queueMicrotask(scheduleFollowBottomScroll)
    onCleanup(() => clearInterval(timer))
    onCleanup(() => {
      followBottomScrollToken += 1
      followBottomScrollScheduled = false
    })
  })

  useKeyboard((event) => {
    if (event.name !== "escape") return
    if (activeTurn()) {
      event.preventDefault()
      event.stopPropagation()
      command.trigger("session.interrupt")
      return
    }
    event.preventDefault()
    event.stopPropagation()
    props.api.route.navigate("session", { sessionID: props.sessionID })
  })

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background}>
      <box flexDirection="row">
        <box width={contentWidth()} flexGrow={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
          <scrollbox
            ref={(value: ScrollBoxRenderable) => (scroll = value)}
            viewportOptions={{ paddingRight: 0 }}
            scrollX
            horizontalScrollbarOptions={{
              paddingTop: 1,
              trackOptions: {
                backgroundColor: theme.backgroundElement,
                foregroundColor: theme.border,
              },
            }}
            verticalScrollbarOptions={{ visible: false }}
            stickyScroll={followSessionOutput()}
            stickyStart="bottom"
            flexGrow={1}
          >
            <box height={1} />
            <Show when={messages().length === 0}>
              <MissingData label="Messages" detail="No v2 messages loaded from useSyncV2 yet." />
            </Show>
            <For each={renderedMessages()}>
              {(message, index) => (
                <Switch>
                  <Match when={message.type === "user"}>
                    <UserMessage message={message as SessionMessageUser} index={index()} />
                  </Match>
                  <Match when={message.type === "assistant"}>
                    <AssistantMessage
                      sessionID={props.sessionID}
                      message={message as SessionMessageAssistant}
                      last={lastAssistant()?.id === message.id}
                      syntax={syntax()}
                      subtleSyntax={subtleSyntax()}
                      start={lastUserCreated(index())}
                    />
                  </Match>
                  <Match when={message.type === "synthetic"}>
                    <></>
                  </Match>
                  <Match when={message.type === "shell"}>
                    <ShellMessage message={message as SessionMessageShell} />
                  </Match>
                  <Match when={message.type === "compaction"}>
                    <CompactionMessage message={message as SessionMessageCompaction} />
                  </Match>
                  <Match when={message.type === "agent-switched"}>
                    <AgentSwitchedMessage message={message as SessionMessageAgentSwitched} />
                  </Match>
                  <Match when={message.type === "model-switched"}>
                    <ModelSwitchedMessage message={message as SessionMessageModelSwitched} />
                  </Match>
                  <Match when={true}>
                    <UnknownMessage message={message} />
                  </Match>
                </Switch>
              )}
            </For>
          </scrollbox>
          <MissingData
            label="Session prompt, permission prompt, question prompt"
            detail="The v2 message endpoint only exposes messages, so these session UI regions cannot be rendered here. Press Esc to return to the live session."
          />
        </box>
      </box>
    </box>
  )
}

function MissingData(props: { label: string; detail: string }) {
  const { theme } = useTheme()
  return (
    <box
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.warning}
      backgroundColor={theme.backgroundPanel}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={theme.text}>
        <span style={{ bg: theme.warning, fg: theme.background, bold: true }}> MISSING DATA </span> {props.label}
      </text>
      <text fg={theme.textMuted}>{props.detail}</text>
    </box>
  )
}

function UserMessage(props: { message: SessionMessageUser; index: number }) {
  const { theme } = useTheme()
  const attachments = createMemo(() => [...(props.message.files ?? []), ...(props.message.agents ?? [])])
  const text = createMemo(() => visibleUserMessageText(props.message.text))
  return (
    <box
      id={props.message.id}
      border={["left"]}
      borderColor={theme.secondary}
      customBorderChars={SplitBorder.customBorderChars}
      marginTop={props.index === 0 ? 0 : 1}
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.text}>{text()}</text>
      <Show when={attachments().length}>
        <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
          <For each={props.message.files ?? []}>
            {(file) => (
              <text fg={theme.text}>
                <span style={{ bg: theme.secondary, fg: theme.background }}> {file.mime} </span>
                <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.name ?? file.uri} </span>
              </text>
            )}
          </For>
          <For each={props.message.agents ?? []}>
            {(agent) => (
              <text fg={theme.text}>
                <span style={{ bg: theme.accent, fg: theme.background }}> agent </span>
                <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {agent.name} </span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function ShellMessage(props: { message: SessionMessageShell }) {
  const { theme } = useTheme()
  const [now, setNow] = createSignal(Date.now())
  const output = createMemo(() => renderTerminalOutput(props.message.output))
  const isRunning = createMemo(() => !props.message.time.completed)
  const [expanded, setExpanded] = createSignal(false)
  const preview = createMemo(() => latestTerminalOutputPreview(output(), 10))
  const overflow = createMemo(() => preview().overflow)
  const limited = createMemo(() => (expanded() || !overflow() ? output() : preview().text))
  const elapsed = createMemo(() => {
    if (!isRunning()) return
    return formatDuration(Math.max(0, Math.round((now() - props.message.time.created) / 1000)))
  })
  const interval = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(interval))
  return (
    <BlockTool
      title="# Shell"
      spinner={!props.message.time.completed}
      titleColor={theme.primary}
      titleAttributes={TextAttributes.BOLD}
      contentGap={0}
      onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
    >
      <CommandOutput
        command={props.message.command}
        output={output() ? limited() : undefined}
        empty={<text fg={theme.textMuted}>No output emitted yet · running {elapsed()}</text>}
        overflow={overflow()}
        expanded={expanded()}
        running={isRunning()}
      />
    </BlockTool>
  )
}

function compactionMetadataValue(metadata: unknown, key: string) {
  if (typeof metadata !== "object" || metadata === null) return
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function compactionMetadataFlag(metadata: unknown, key: string) {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === "boolean" ? value : undefined
}

function CompactionMessage(props: { message: SessionMessageCompaction }) {
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()
  const messageWidth = createMemo(() => sessionContentWidth(dimensions().width, false))
  const contentWidth = createMemo(() => Math.max(1, messageWidth() - 3))
  const renderWidth = createMemo(() => Math.min(contentWidth(), 100))
  const resume = createMemo(() => compactionMetadataFlag(props.message.metadata, "resume"))
  const overflow = createMemo(() => compactionMetadataFlag(props.message.metadata, "overflow"))
  const tailStartID = createMemo(() => compactionMetadataValue(props.message.metadata, "tail_start_id"))
  const postPrompt = createMemo(() => compactionMetadataValue(props.message.metadata, "post_prompt"))
  const summaryPreview = createMemo(() => compactionSummaryPreview(props.message.summary, 112))
  const transcriptPreview = createMemo(() => compactPreviewLine(props.message.include, 112))
  const summaryContent = createMemo(() => {
    const summary = props.message.summary?.trim()
    if (!summary) return ""
    return renderPlanMarkdownStatic(summary, renderWidth(), { tableMode: "grid", markdownMode: "tables-only" })
  })
  return (
    <CompactionPanel
      reason={props.message.reason}
      overflow={overflow()}
      resume={resume()}
      include={props.message.include}
      tailStartID={tailStartID()}
      postPrompt={postPrompt()}
      hasSummaryBody={Boolean(props.message.summary?.trim())}
      summaryPreview={summaryPreview()}
      transcriptPreview={transcriptPreview()}
      summaryContent={summaryContent() ? (
        <box paddingTop={1}>
          <StyledPlanMarkdown
            syntaxStyle={syntax()}
            width={contentWidth()}
            content={summaryContent()}
            tableOptions={{ style: "grid", widthMode: "full", columnFitter: "balanced", wrapMode: "char" }}
            conceal={true}
            fg={theme.text}
            bg={theme.background}
            stableTextMode={false}
            colorizeHex={true}
          />
        </box>
      ) : undefined}
    />
  )
}

function AgentSwitchedMessage(props: { message: SessionMessageAgentSwitched }) {
  const { theme } = useTheme()
  const local = useLocal()
  const mend = useMendTuiProfile()
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text>
        <span style={{ fg: local.agent.color(props.message.agent) }}>
          {mend.profile.presentation.symbols.assistantDone}{" "}
        </span>
        <span style={{ fg: theme.textMuted }}>Switched agent to </span>
        <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.agent)}</span>
      </text>
    </box>
  )
}

function ModelSwitchedMessage(props: { message: SessionMessageModelSwitched }) {
  const { theme } = useTheme()
  const model = createMemo(() => {
    const variant = props.message.model.variant ? `/${props.message.model.variant}` : ""
    return `${props.message.model.providerID}/${props.message.model.id}${variant}`
  })
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text>
        <span style={{ fg: theme.secondary }}>◇ </span>
        <span style={{ fg: theme.textMuted }}>Switched model to </span>
        <span style={{ fg: theme.text }}>{model()}</span>
      </text>
    </box>
  )
}

function UnknownMessage(props: { message: SessionMessage }) {
  return <MissingData label="Unknown message type" detail={JSON.stringify(props.message)} />
}

function AssistantMessage(props: {
  sessionID: string
  message: SessionMessageAssistant
  last: boolean
  syntax: SyntaxStyle
  subtleSyntax: SyntaxStyle
  start?: number
}) {
  const { theme } = useTheme()
  const local = useLocal()
  const mend = useMendTuiProfile()
  const duration = createMemo(() => {
    if (!props.message.time.completed) return 0
    return props.message.time.completed - (props.start ?? props.message.time.created)
  })
  const model = createMemo(() => {
    const variant = props.message.model.variant ? `/${props.message.model.variant}` : ""
    return `${props.message.model.providerID}/${props.message.model.id}${variant}`
  })
  const final = createMemo(() => props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish))
  return (
    <>
      <For each={props.message.content}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text"}>
              <AssistantText
                messageID={props.message.id}
                part={part as SessionMessageAssistantText}
                syntax={props.syntax}
                completed={!!props.message.time.completed}
              />
            </Match>
            <Match when={part.type === "reasoning"}>
              <AssistantReasoning
                messageID={props.message.id}
                part={part as SessionMessageAssistantReasoning}
                subtleSyntax={props.subtleSyntax}
                completed={!!props.message.time.completed}
              />
            </Match>
            <Match when={part.type === "tool"}>
              <AssistantTool
                sessionID={props.sessionID}
                messageID={props.message.id}
                part={part as SessionMessageAssistantTool}
              />
            </Match>
          </Switch>
        )}
      </For>
      <Show when={props.message.content.length === 0}>
        <MissingData label="Assistant content" detail={`Assistant message ${props.message.id} has no content items.`} />
      </Show>
      <Show when={props.message.error}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
          flexShrink={0}
        >
          <text fg={theme.textMuted}>{props.message.error}</text>
        </box>
      </Show>
      <Show when={props.last || final() || props.message.error}>
        <box paddingLeft={3} flexShrink={0}>
          <text marginTop={1}>
            <span style={{ fg: local.agent.color(props.message.agent) }}>
              {mend.profile.presentation.symbols.assistantDone}{" "}
            </span>
            <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.agent)}</span>
            <span style={{ fg: theme.textMuted }}> · {model()}</span>
            <Show when={duration()}>
              <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
            </Show>
          </text>
        </box>
      </Show>
    </>
  )
}

function AssistantText(props: { messageID: string; part: SessionMessageAssistantText; syntax: SyntaxStyle; completed: boolean }) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const textID = createMemo(() => props.part.text.slice(0, 32).replace(/\W+/g, "-"))
  const textPaddingLeft = 3
  const renderer = createMemo(() => mend.profile.presentation.message.renderer)
  const streaming = createMemo(() => !props.completed)
  const source = createMemo(() => {
    const text = streaming() ? props.part.text.trimStart() : props.part.text.trim()
    return text
  })
  const messageWidth = createMemo(() => sessionContentWidth(dimensions().width, false))
  const markdownWidth = createMemo(() => Math.max(1, messageWidth() - textPaddingLeft))
  const richRenderWidth = createMemo(() => markdownWidth())
  const hasMermaid = createMemo(() => hasMermaidFence(source()))
  const richStaticContent = createMemo(() => {
    if (renderer() !== "markdown" && renderer() !== "rich") return
    if (streaming()) return
    return renderPlanMarkdownStatic(source(), richRenderWidth(), { tableMode: "grid", markdownMode: "tables-only" })
  })
  const richInput = createMemo(() => {
    if (renderer() !== "rich" || !hasMermaid()) return
    if (streaming()) return
    return { text: source(), width: richRenderWidth() }
  })
  const [richContent] = createResource(richInput, async (input) =>
    renderPlanMarkdown(input.text, input.width, { tableMode: "grid", markdownMode: "tables-only" }),
  )
  const streamingContent = createMemo(() => {
    if (!streaming()) return ""
    if (renderer() !== "markdown" && renderer() !== "rich") return ""
    return renderStreamingMarkdownTail(source(), richRenderWidth(), { tableMode: "grid", markdownMode: "tables-only" }, {
      finalized: false,
      output: "text",
    })
  })
  const markdownContent = createMemo(() => (renderer() === "markdown" || renderer() === "rich" ? (richStaticContent() ?? richContent() ?? source()) : source()))
  return (
    <Show when={source().trim().length > 0}>
      <box
        width={messageWidth()}
        paddingLeft={textPaddingLeft}
        marginTop={1}
        flexShrink={0}
        id={`text-${props.messageID}-${textID()}`}
      >
        <Switch>
          <Match when={renderer() === "plain"}>
            <box flexDirection="column">
              <For each={source().split("\n")}>{(line) => <text fg={theme.text}>{line || " "}</text>}</For>
            </box>
          </Match>
          <Match when={true}>
            <StyledPlanMarkdown
              syntaxStyle={props.syntax}
              width={markdownWidth()}
              source={source()}
              content={streaming() ? streamingContent() : markdownContent()}
              tableOptions={{ style: "grid", widthMode: "full", columnFitter: "balanced", wrapMode: "char" }}
              conceal={true}
              fg={theme.markdownText}
              bg={theme.background}
              streaming={streaming()}
              stableTextMode={renderer() !== "markdown" && renderer() !== "rich"}
              colorizeHex={renderer() === "rich"}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

function AssistantReasoning(props: {
  messageID: string
  part: SessionMessageAssistantReasoning
  subtleSyntax: SyntaxStyle
  completed: boolean
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const content = createMemo(() => props.part.text.replace("[REDACTED]", "").trim())
  const raw = createMemo(() => mend.profile.presentation.profile === "raw")
  const full = createMemo(() => mend.profile.presentation.profile === "mendcode")
  const encryptedReasoning = createMemo(() =>
    Boolean((props.part as unknown as { metadata?: Record<string, any> }).metadata?.openai?.reasoningEncryptedContent),
  )
  const hasReasoningEvidence = createMemo(() => Boolean(content() || (raw() && encryptedReasoning())))
  const display = createMemo(() =>
    rawReasoningDisplay(content(), {
      fallbackTitle: unavailableReasoningLabel({
        hasReadableContent: Boolean(content()),
        encrypted: encryptedReasoning(),
      }),
    }),
  )
  const streaming = createMemo(() => !props.completed)
  const fullReasoningTitle = createMemo(() => {
    const summary = reasoningSummary(content())
    const line = (summary.title ?? summary.body.split(/\r?\n/).find((item) => item.trim()) ?? "").trim()
    if (!line) return display().title
    return Locale.truncate(line.replace(/^#+\s*/, "").replace(/^\*\*([^*]+)\*\*$/, "$1"), 120)
  })
  const fullReasoningMaxHeight = createMemo(() => reasoningViewportMaxHeight(dimensions().height))
  return (
    <Show when={hasReasoningEvidence() && shouldDisplayReasoning(mend.profile, { completed: props.completed })}>
      <Switch>
        <Match when={raw()}>
          <box
            paddingLeft={3}
            marginTop={1}
            flexDirection="column"
            flexShrink={0}
            id={`reasoning-${props.messageID}-${props.part.id}`}
          >
            <ReasoningHeader done={props.completed} title={display().title} />
            <Show when={display().body}>
              <box>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={true}
                  syntaxStyle={props.subtleSyntax}
                  content={display().body}
                  conceal={true}
                  fg={theme.textMuted}
                />
              </box>
            </Show>
          </box>
        </Match>
        <Match when={full()}>
          <box
            id={`reasoning-${props.messageID}-${props.part.id}`}
            paddingLeft={2}
            marginTop={streaming() ? 0 : 1}
            flexDirection="column"
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.backgroundElement}
            flexShrink={0}
          >
            <ReasoningHeader done={props.completed} title={fullReasoningTitle()} />
            <Show when={content()}>
              {(body) => (
                <scrollbox
                  height={fullReasoningMaxHeight()}
                  maxHeight={fullReasoningMaxHeight()}
                  stickyScroll={streaming()}
                  stickyStart="bottom"
                  verticalScrollbarOptions={{ visible: false }}
                  viewportOptions={{ paddingRight: 0 }}
                >
                  <code
                    filetype="markdown"
                    drawUnstyledText={false}
                    streaming={streaming()}
                    syntaxStyle={props.subtleSyntax}
                    content={body()}
                    conceal={true}
                    fg={theme.textMuted}
                  />
                </scrollbox>
              )}
            </Show>
          </box>
        </Match>
        <Match when={true}>
          <box
            id={`reasoning-${props.messageID}-${props.part.id}`}
            paddingLeft={2}
            marginTop={1}
            flexDirection="column"
            border={["left"]}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.backgroundElement}
            flexShrink={0}
          >
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={props.subtleSyntax}
              content={"_Thinking:_ " + content()}
              conceal={true}
              fg={theme.textMuted}
            />
          </box>
        </Match>
      </Switch>
    </Show>
  )
}

function ReasoningHeader(props: { done: boolean; title: string | null }) {
  const { theme } = useTheme()
  const fg = () => RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)

  return (
    <Switch>
      <Match when={!props.done}>
        <text fg={fg()} wrapMode="none">
          <span>Thinking</span>
          <Show when={props.title}>
            <span>: </span>
            <span>{props.title}</span>
          </Show>
        </text>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          <span>Thought</span>
          <Show when={props.title}>
            <span>: </span>
            <span>{props.title}</span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}

function AssistantTool(props: { sessionID: string; messageID: string; part: SessionMessageAssistantTool }) {
  const mend = useMendTuiProfile()
  const input = createMemo(() => toolInputRecord(props.part.state.input))
  const rowOnly = createMemo(() => {
    const profile = mend.profile.presentation.profile
    if (shouldRenderImageGenerationTool(props.part.name)) return false
    if (props.part.name === "bash" || props.part.name === "shell") return false
    if (props.part.name === "loop") return false
    if (props.part.name === "workflow" && shouldRenderSessionWorkflowCard(profile)) return false
    if (props.part.name === "memory_graph") return false
    return shouldRenderCompactTool(profile, props.part.name)
  })
  const toolprops = {
    get input() {
      return input()
    },
    get metadata() {
      const structured = props.part.state.status === "pending" ? undefined : props.part.state.structured
      return isRecord(structured) ? structured : (fullToolMetadata(props.part) ?? props.part.provider?.metadata ?? {})
    },
    get output() {
      return props.part.state.status === "pending" ? undefined : toolOutput(props.part.state.content)
    },
    sessionID: props.sessionID,
    messageID: props.messageID,
    part: props.part,
  }
  return (
    <Switch>
      <Match when={rowOnly()}>
        <PresentationToolRow
          tool={props.part.name}
          state={props.part.state.status}
          input={input()}
          metadata={toolprops.metadata}
          output={toolprops.output}
        />
      </Match>
      <Match when={shouldRenderImageGenerationTool(props.part.name)}>
        <ImageGen {...toolprops} />
      </Match>
      <Match when={props.part.name === "bash"}>
        <Bash {...toolprops} />
      </Match>
      <Match when={props.part.name === "glob"}>
        <Glob {...toolprops} />
      </Match>
      <Match when={props.part.name === "read"}>
        <Read {...toolprops} />
      </Match>
      <Match when={props.part.name === "grep"}>
        <Grep {...toolprops} />
      </Match>
      <Match when={props.part.name === "webfetch"}>
        <WebFetch {...toolprops} />
      </Match>
      <Match when={props.part.name === "codesearch"}>
        <CodeSearch {...toolprops} />
      </Match>
      <Match when={props.part.name === "websearch"}>
        <WebSearch {...toolprops} />
      </Match>
      <Match when={props.part.name === "write"}>
        <Write {...toolprops} />
      </Match>
      <Match when={props.part.name === "edit"}>
        <Edit {...toolprops} />
      </Match>
      <Match when={props.part.name === "apply_patch"}>
        <ApplyPatch {...toolprops} />
      </Match>
      <Match when={props.part.name === "todowrite"}>
        <TodoWrite {...toolprops} />
      </Match>
      <Match when={props.part.name === "question"}>
        <Question {...toolprops} />
      </Match>
      <Match when={props.part.name === "skill"}>
        <Skill {...toolprops} />
      </Match>
      <Match
        when={
          props.part.name === "loop" &&
          shouldRenderSessionLoopCard({
            toolStatus: props.part.state.status,
            workflowID: toolprops.metadata.workflowID,
            workflows: toolprops.metadata.workflows,
          })
        }
      >
        <Loop {...toolprops} />
      </Match>
      <Match when={props.part.name === "memory_graph"}>
        <MemoryGraph {...toolprops} />
      </Match>
      <Match when={props.part.name === "workflow" && shouldRenderSessionWorkflowCard(mend.profile.presentation.profile)}>
        <Workflow {...toolprops} />
      </Match>
      <Match when={props.part.name === "task"}>
        <Task {...toolprops} />
      </Match>
      <Match when={true}>
        <GenericTool {...toolprops} />
      </Match>
    </Switch>
  )
}

function PresentationToolRow(props: {
  tool: string
  state: string
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: unknown
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const pending = createMemo(() => props.state === "pending" || props.state === "running")
  const errored = createMemo(() => props.state === "error")
  const event = createMemo(() =>
    normalizeToolEvent({ tool: props.tool, state: props.state, input: props.input, metadata: props.metadata, output: props.output }),
  )
  const wrappedLines = createMemo(() => {
    const width = Math.max(16, sessionContentWidth(dimensions().width, false) - 12)
    return event().lines.flatMap((line) => wrapTimelineLine("", line, width))
  })
  const icon = createMemo(() => toolPresentationIconForProfile(mend.profile.presentation.profile, props.tool, errored() ? "failure" : event().class))
  const title = createMemo(() => event().title)
  const cleanDetail = createMemo(
    () => (props.tool === "webfetch" || props.tool === "websearch") && wrappedLines().length > 0,
  )
  const plainTool = createMemo(() => event().class === "simple-read" || event().class === "artifact")
  const rowColor = createMemo(() => {
    if (errored()) return theme.error
    if (props.tool === "memory" || props.tool === "memory_graph") {
      const tone = memoryToolPresentation({
        tool: props.tool,
        state: props.state,
        input: props.input,
        metadata: props.metadata,
      }).tone
      if (tone === "success") return theme.success
      if (tone === "active") return theme.primary
    }
    if (pending() || plainTool()) return theme.text
    return theme.textMuted
  })
  const detail = createMemo(() => {
    if (mend.profile.presentation.profile === "minimal") return title()
    return title()
  })
  return (
    <Show
      when={shouldRenderSessionWorkflowCard(mend.profile.presentation.profile)}
      fallback={
        <Show
          when={wrappedLines().length > 0}
          fallback={
            <box paddingLeft={3} marginTop={0} flexShrink={0}>
              <text fg={rowColor()}>
                <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
                {detail()}
              </text>
            </box>
          }
        >
          <box paddingLeft={3} marginTop={0} flexShrink={0} flexDirection="column">
            <text fg={rowColor()}>
              <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
              {detail()}
            </text>
            <For each={wrappedLines()}>
              {(line) => (
                <text fg={theme.textMuted} wrapMode="char">
                  {line}
                </text>
              )}
            </For>
            <Show when={event().result}>{(result) => <text fg={theme.textMuted}>{result()}</text>}</Show>
          </box>
        </Show>
      }
    >
      <Show
        when={wrappedLines().length > 0}
        fallback={
          <box paddingLeft={3} marginTop={0} flexShrink={0}>
            <text fg={rowColor()}>
              <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
              {title()}
            </text>
          </box>
        }
      >
        <box paddingLeft={3} marginTop={0} flexShrink={0} flexDirection="column">
          <Show
            when={cleanDetail()}
            fallback={
              <>
                <text fg={rowColor()}>
                  ╭─ <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
                  {title()}
                </text>
                <For each={wrappedLines()}>{(line) => <text fg={theme.textMuted} wrapMode="none">│ {line}</text>}</For>
                <Show when={event().result}>{(result) => <text fg={theme.textMuted}>╰─ {result()}</text>}</Show>
              </>
            }
          >
            <text fg={rowColor()}>
              <Show when={icon()}>{(value) => <span>{value()} </span>}</Show>
              {title()}
              <Show when={event().result}>{(result) => <span style={{ fg: theme.textMuted }}> · {result()}</span>}</Show>
            </text>
            <For each={wrappedLines()}>{(line) => <text fg={theme.textMuted} wrapMode="none">  {line}</text>}</For>
          </Show>
        </box>
      </Show>
    </Show>
  )
}

type ToolProps = {
  sessionID: string
  messageID: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  part: SessionMessageAssistantTool
}

function fullToolMetadata(part: unknown) {
  if (!isRecord(part) || !isRecord(part.state) || !isRecord(part.state.metadata)) return undefined
  return part.state.metadata
}

function fullToolMetadataString(part: unknown, key: string) {
  const value = fullToolMetadata(part)?.[key]
  return typeof value === "string" ? value : undefined
}

function fullToolInputString(part: unknown, key: string) {
  if (!isRecord(part) || !isRecord(part.state) || !isRecord(part.state.input)) return undefined
  const value = part.state.input[key]
  return typeof value === "string" ? value : undefined
}

function fullToolMetadataPatch(part: unknown, filePath: string) {
  const files = fullToolMetadata(part)?.files
  if (!Array.isArray(files)) return undefined
  const file = files.find((item) => {
    if (!isRecord(item)) return false
    return [item.filePath, item.movePath, item.relativePath].some((value) => value === filePath)
  })
  return isRecord(file) && typeof file.patch === "string" ? file.patch : undefined
}

function imageGenMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function imageGenMetadataNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function formatImageArtifactBytes(value: number | undefined) {
  if (value === undefined) return
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`
  return `${Math.round(value / (1024 * 102.4)) / 10} MB`
}

function ImageGenToolAction(props: { label: string; onPress: () => void }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onPress()
      }}
    >
      <text fg={hover() ? theme.text : theme.primary}>[{props.label}]</text>
    </box>
  )
}

function ImageGen(props: ToolProps) {
  const { theme } = useTheme()
  const sessionStatusType = useSessionStatusType()
  const mend = useMendTuiProfile()
  const dimensions = useTerminalDimensions()
  const toast = useToast()
  const [frame, setFrame] = createSignal(0)
  const running = createMemo(() =>
    isToolActivityActive({
      toolStatus: props.part.state.status,
      sessionStatusType: sessionStatusType(),
    }),
  )
  const completed = createMemo(() => props.part.state.status === "completed")
  const metadata = createMemo(() => props.metadata)
  const artifactPath = createMemo(() => imageGenMetadataString(metadata(), "path"))
  const generationModel = createMemo(() => {
    const provider = imageGenMetadataString(metadata(), "provider")
    const model = imageGenMetadataString(metadata(), "model")
    return provider && model ? `${provider}/${model}` : model
  })
  const visualCaption = createMemo(() => {
    const caption = metadata().caption
    if (!caption || typeof caption !== "object") return undefined
    const record = caption as Record<string, unknown>
    return record.status === "completed" && typeof record.caption === "string" ? record.caption : undefined
  })
  const captionError = createMemo(() => {
    const caption = metadata().caption
    if (!caption || typeof caption !== "object") return undefined
    const record = caption as Record<string, unknown>
    return record.status === "error" && typeof record.error === "string" ? record.error : undefined
  })
  const imageWait = createMemo(() => mend.profile.imageGeneration.wait)
  const canvas = createMemo(() => imageGenerationCanvasSize(sessionContentWidth(dimensions().width, false), imageWait()))
  const fieldWidth = createMemo(() => Math.max(8, canvas().width - 2 - imageWait().canvas.paddingX * 2))
  const fieldHeight = createMemo(() =>
    Math.max(4, canvas().height - 2 - imageWait().canvas.paddingY * 2 - (imageWait().showMetadata ? 2 : 0)),
  )
  const frameCount = createMemo(() => imageGenerationWaitFrameCount(imageWait()))
  const lines = createMemo(() => imageGenerationWaitFrame(imageWait(), frame(), fieldWidth(), fieldHeight()))
  const summary = createMemo(() =>
    [
      imageGenMetadataString(metadata(), "format") ?? "PNG",
      imageGenMetadataString(metadata(), "size"),
      formatImageArtifactBytes(imageGenMetadataNumber(metadata(), "bytes")),
      imageGenMetadataString(metadata(), "quality"),
      generationModel(),
      typeof metadata().cost === "number" ? `$${(metadata().cost as number).toFixed(4)}` : "cost unknown",
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
  )

  createEffect(() => {
    const wait = imageWait()
    const count = frameCount()
    setFrame((value) => value % count)
    if (!running() || mend.profile.workingIndicator.visible === false || wait.mode === "static" || count <= 1) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % count), wait.intervalMs)
    onCleanup(() => clearInterval(timer))
  })

  const activityLineColor = (line: string) => {
    const color = imageWait().textColor
    if (color === "accent") return theme.primary
    if (color === "muted") return theme.textMuted
    return line.includes("*") || line.includes("+") || line.includes("@") || line.includes("#") || line.includes("o")
      ? theme.primary
      : theme.textMuted
  }

  const openArtifact = async (target: string, label: string) => {
    try {
      await open(target)
      toast.show({ message: `${label}: ${target}`, variant: "success", duration: 2500 })
    } catch (error) {
      toast.show({ message: `${label} failed: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    }
  }

  const copyArtifactPath = async (target: string) => {
    try {
      await Clipboard.copy(target)
      toast.show({ message: "Image path copied", variant: "success", duration: 2500 })
    } catch (error) {
      toast.show({ message: `Copy failed: ${errorMessage(error)}`, variant: "error", duration: 5000 })
    }
  }

  return (
    <Switch>
      <Match when={props.part.state.status === "error"}>
        <InlineTool icon={toolPresentationIcon("image_gen")} pending="Generating image..." complete={true} part={props.part}>
          Image generation failed
        </InlineTool>
      </Match>
      <Match when={running()}>
        <BlockTool title="Generating image..." titleColor={theme.text} part={props.part} paddingBottom={1}>
          <box width="100%" alignItems="center">
            <box
              border={["top", "bottom", "left", "right"]}
              borderColor={theme.border}
              paddingLeft={imageWait().canvas.paddingX}
              paddingRight={imageWait().canvas.paddingX}
              paddingTop={imageWait().canvas.paddingY}
              paddingBottom={imageWait().canvas.paddingY}
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
              width={canvas().width}
              height={canvas().height}
              flexShrink={0}
            >
              <For each={lines()}>{(line) => <text fg={activityLineColor(line)}>{line}</text>}</For>
              <Show when={imageWait().showMetadata}>
                <text fg={theme.textMuted}>{generationModel() ?? "configured image model"}</text>
                <text fg={theme.textMuted}>
                  size {imageGenMetadataString(metadata(), "requestedSize") ?? "auto"}
                </text>
              </Show>
            </box>
          </box>
        </BlockTool>
      </Match>
      <Match when={completed()}>
        <BlockTool title="Generated image" part={props.part} paddingBottom={1}>
          <box
            border={["top", "bottom", "left", "right"]}
            borderColor={theme.border}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            flexDirection="column"
            gap={1}
          >
            <text fg={theme.text}>{summary()}</text>
            <Show when={visualCaption()}>{(value) => <text fg={theme.textMuted}>Caption: {value()}</text>}</Show>
            <Show when={captionError()}>{(value) => <text fg={theme.warning}>Caption unavailable: {value()}</text>}</Show>
            <Show when={artifactPath()}>
              {(value) => (
                <>
                  <text fg={theme.textMuted} wrapMode="char">{value()}</text>
                  <box flexDirection="row" gap={2}>
                    <ImageGenToolAction label="Open Preview" onPress={() => void openArtifact(value(), "Opened preview")} />
                    <ImageGenToolAction
                      label="Reveal Folder"
                      onPress={() => void openArtifact(path.dirname(value()), "Opened folder")}
                    />
                    <ImageGenToolAction label="Copy Path" onPress={() => void copyArtifactPath(value())} />
                  </box>
                </>
              )}
            </Show>
          </box>
        </BlockTool>
      </Match>
    </Switch>
  )
}

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const output = createMemo(() => renderTerminalOutput(props.output ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 8
  const preview = createMemo(() => latestTerminalOutputPreview(output(), maxLines))
  const overflow = createMemo(() => preview().overflow)
  const limited = createMemo(() => (expanded() || !overflow() ? output() : preview().text))
  return (
    <Show
      when={output()}
      fallback={
        <InlineTool icon={toolPresentationIcon(props.part.name)} pending="Writing command..." complete={toolComplete(props.part)} part={props.part}>
          {props.part.name} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.part.name} ${input(props.input)}`}
        part={props.part}
        onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  complete: unknown
  pending: string
  spinner?: boolean
  onClick?: () => void
  children: JSX.Element
  part: SessionMessageAssistantTool
}) {
  const { theme } = useTheme()
  const sessionStatusType = useSessionStatusType()
  const mend = useMendTuiProfile()
  const renderer = useRenderer()
  const [margin, setMargin] = createSignal(0)
  const [hover, setHover] = createSignal(false)
  const [showError, setShowError] = createSignal(false)
  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error.message : undefined))
  const complete = createMemo(() => !!props.complete)
  const denied = createMemo(() => {
    const message = error()
    if (!message) return false
    return (
      message.includes("QuestionRejectedError") ||
      message.includes("rejected permission") ||
      message.includes("specified a rule") ||
      message.includes("user dismissed")
    )
  })
  const fg = createMemo(() => {
    if (error()) return theme.error
    if (complete()) return theme.textMuted
    return theme.text
  })
  const attributes = createMemo(() => (denied() ? TextAttributes.STRIKETHROUGH : undefined))
  const shouldRender = createMemo(() => Boolean(complete() || error()))
  const showIcon = createMemo(() => mend.profile.presentation.profile !== "minimal")
  const spinner = createMemo(
    () =>
      props.spinner === true &&
      isToolActivityActive({
        toolStatus: props.part.state.status,
        sessionStatusType: sessionStatusType(),
      }),
  )
  return (
    <Show when={shouldRender()}>
      <box
        marginTop={margin()}
        paddingLeft={3}
        flexShrink={0}
        flexDirection="row"
        gap={1}
        backgroundColor={hover() && error() ? theme.backgroundMenu : undefined}
        onMouseOver={() => error() && setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          if (!error() && props.onClick) {
            props.onClick()
            return
          }
          if (!error()) return
          setShowError((prev) => !prev)
        }}
        renderBefore={function () {
          const el = this as BoxRenderable
          const parent = el.parent
          if (!parent) return
          const previous = parent.getChildren()[parent.getChildren().indexOf(el) - 1]
          if (!previous) {
            setMargin(0)
            return
          }
          if (previous.id.startsWith("text")) setMargin(1)
        }}
      >
        <Show when={showIcon()}>
          <box flexShrink={0}>
            <Switch>
              <Match when={spinner()}>
                <Spinner color={theme.text} />
              </Match>
              <Match when={complete()}>
                <text fg={fg()} attributes={attributes()}>
                  {props.icon}
                </text>
              </Match>
              <Match when={true}>
                <text fg={fg()} attributes={attributes()}>
                  ~
                </text>
              </Match>
            </Switch>
          </box>
        </Show>
        <box flexGrow={1}>
          <box>
            <Switch>
              <Match when={complete()}>
                <text fg={fg()} attributes={attributes()}>
                  {props.children}
                </text>
              </Match>
              <Match when={true}>
                <text fg={fg()} attributes={attributes()}>
                  {props.pending}
                </text>
              </Match>
            </Switch>
          </box>
          <Show when={showError() && error()}>
            {(message) => <ToolErrorText message={message()} />}
          </Show>
        </box>
      </box>
    </Show>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  part?: SessionMessageAssistantTool
  onClick?: () => void
  spinner?: boolean
  titleColor?: RGBA
  titleAttributes?: typeof TextAttributes.BOLD
  contentGap?: number
  marginTop?: number
  paddingBottom?: number
}) {
  const { theme } = useTheme()
  const sessionStatusType = useSessionStatusType()
  const renderer = useRenderer()
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error.message : undefined))
  const spinner = createMemo(() => {
    if (props.spinner !== true) return false
    if (!props.part) return true
    return isToolActivityActive({
      toolStatus: props.part.state.status,
      sessionStatusType: sessionStatusType(),
    })
  })
  return (
    <box
      paddingBottom={props.paddingBottom ?? 1}
      paddingLeft={3}
      gap={props.contentGap ?? 1}
      marginTop={props.marginTop ?? 0}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      flexShrink={0}
    >
      <Show
        when={spinner()}
        fallback={
          <text fg={props.titleColor ?? theme.textMuted} attributes={props.titleAttributes}>
            {props.title}
          </text>
        }
      >
        <Spinner color={props.titleColor ?? theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        {(message) => <ToolErrorText message={message()} />}
      </Show>
    </box>
  )
}

function ToolErrorText(props: { message: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" width="100%" overflow="hidden">
      <For each={props.message.split("\n")}>
        {(line) => (
          <text fg={theme.error} wrapMode="word" width="100%">
            {line || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function CommandOutput(props: {
  command: string
  output?: string
  empty?: JSX.Element
  overflow?: boolean
  expanded?: boolean
  running?: boolean
}) {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>$</text>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {props.command}
        </text>
      </box>
      <Show when={props.output}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="word" width="100%">{props.output}</text>
        </box>
      </Show>
      <Show when={!props.output}>{props.empty}</Show>
      <Show when={props.overflow}>
        <text fg={theme.textMuted}>
          {props.expanded ? "Click to collapse" : props.running ? "Showing latest output" : "Click to expand"}
        </text>
      </Show>
    </box>
  )
}

function Bash(props: ToolProps) {
  const { theme } = useTheme()
  const sessionStatusType = useSessionStatusType()
  const isRunning = createMemo(() =>
    isToolActivityActive({
      toolStatus: props.part.state.status,
      sessionStatusType: sessionStatusType(),
    }),
  )
  const liveOutput = createMemo(() => stringValue(props.metadata.output))
  const output = createMemo(() =>
    renderTerminalOutput(selectShellOutput({ running: isRunning(), live: liveOutput(), final: props.output })),
  )
  const command = createMemo(() => stringValue(props.input.command) ?? pendingInput(props.part))
  const title = createMemo(() => `# ${stringValue(props.input.description) ?? "Shell"}`)
  const [expanded, setExpanded] = createSignal(false)
  const preview = createMemo(() => latestTerminalOutputPreview(output(), 10))
  const overflow = createMemo(() => preview().overflow)
  const limited = createMemo(() => (expanded() || !overflow() ? output() : preview().text))
  return (
    <Switch>
      <Match when={output()}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          titleColor={theme.primary}
          titleAttributes={TextAttributes.BOLD}
          contentGap={0}
          paddingBottom={0}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <CommandOutput
            command={command()}
            output={limited()}
            overflow={overflow()}
            expanded={expanded()}
            running={isRunning()}
          />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon={toolPresentationIcon("bash")} pending="Writing command..." complete={command()} part={props.part}>
          {command()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  return (
    <InlineTool icon={toolPresentationIcon("glob")} pending="Finding files..." complete={toolComplete(props.part)} part={props.part}>
      Glob "{stringValue(props.input.pattern) ?? pendingInput(props.part)}"{" "}
      <Show when={stringValue(props.input.path)}>in {normalizePath(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        {(count) => (
          <>
            ({count()} {count() === 1 ? "match" : "matches"})
          </>
        )}
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const loaded = createMemo(() =>
    arrayValue(props.metadata.loaded).filter((item): item is string => typeof item === "string"),
  )
  return (
    <>
      <InlineTool
        icon={toolPresentationIcon("read")}
        pending="Reading file..."
        complete={stringValue(props.input.filePath) ?? pendingInput(props.part)}
        spinner={props.part.state.status === "running"}
        part={props.part}
      >
        Read {normalizePath(stringValue(props.input.filePath) ?? pendingInput(props.part))}{" "}
        {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3} flexShrink={0}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  return (
    <InlineTool icon={toolPresentationIcon("grep")} pending="Searching content..." complete={toolComplete(props.part)} part={props.part}>
      Grep "{stringValue(props.input.pattern) ?? pendingInput(props.part)}"{" "}
      <Show when={stringValue(props.input.path)}>in {normalizePath(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        {(matches) => (
          <>
            ({matches()} {matches() === 1 ? "match" : "matches"})
          </>
        )}
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const detailLines = createMemo(() => [stringValue(props.input.url)].filter((line): line is string => Boolean(line?.trim())))
  const wrappedLines = createMemo(() => {
    const width = Math.max(16, sessionContentWidth(dimensions().width, false) - 8)
    return detailLines().flatMap((line) => wrapTimelineLine("", line, width))
  })
  return (
    <>
      <InlineTool icon={toolPresentationIcon("webfetch")} pending="Fetching from the web..." complete={toolComplete(props.part)} part={props.part}>
        WebFetch
      </InlineTool>
      <For each={wrappedLines()}>
        {(line) => (
          <box paddingLeft={6} flexShrink={0}>
            <text fg={theme.textMuted} wrapMode="char">
              {line}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function CodeSearch(props: ToolProps) {
  return (
    <InlineTool icon={toolPresentationIcon("codesearch")} pending="Searching code..." complete={toolComplete(props.part)} part={props.part}>
      Exa Code Search "{stringValue(props.input.query) ?? pendingInput(props.part)}"{" "}
      <Show when={numberValue(props.metadata.results)}>{(results) => <>({results()} results)</>}</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const urls = createMemo(() => webSearchUrlLines(props.metadata, props.output))
  const wrappedUrls = createMemo(() => {
    const width = Math.max(16, sessionContentWidth(dimensions().width, false) - 8)
    return urls().flatMap((url) => wrapTimelineLine("", url, width))
  })
  return (
    <>
      <InlineTool icon={toolPresentationIcon("websearch")} pending="Searching web..." complete={toolComplete(props.part)} part={props.part}>
        Exa Web Search "{stringValue(props.input.query) ?? pendingInput(props.part)}"{" "}
        <Show when={numberValue(props.metadata.numResults)}>{(results) => <>({results()} results)</>}</Show>
      </InlineTool>
      <For each={wrappedUrls()}>
        {(url) => (
          <box paddingLeft={6} flexShrink={0}>
            <text fg={theme.textMuted} wrapMode="char">
              {url}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const sync = useSync()
  const filePath = createMemo(() => stringValue(props.input.filePath) ?? "")
  const content = createMemo(() => stringValue(props.input.content) ?? "")
  const loadFullContent = () =>
    sync.session
      .loadFullToolPart(props.sessionID, props.messageID, props.part.id)
      .then((part) => fullToolInputString(part, "content"))
  return (
    <Switch>
      <Match when={content() && props.part.state.status === "completed"}>
        <BlockTool
          title={"Added " + normalizePath(filePath())}
          titleColor={theme.diffHighlightAdded}
          part={props.part}
          contentGap={0}
          paddingBottom={0}
        >
          <TimelineCode
            content={content()}
            filetype={filetype(filePath())}
            syntaxStyle={syntax()}
            foregroundColor={theme.text}
            lineNumberColor={theme.diffHighlightAdded}
            backgroundColor={theme.diffAddedBg}
            loadFull={loadFullContent}
          />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon={toolPresentationIcon("write")} pending="Preparing write..." complete={filePath()} part={props.part}>
          Write {normalizePath(filePath())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps) {
  const { syntax } = useTheme()
  const sync = useSync()
  const filePath = createMemo(() => stringValue(props.input.filePath) ?? "")
  const diff = createMemo(() => stringValue(props.metadata.diff))
  const title = createMemo(() => `Edited ${normalizePath(filePath())} ${formatDiffStats(diffStatsFromPatch(diff() ?? ""))}`.trim())
  const loadFullDiff = () =>
    sync.session
      .loadFullToolPart(props.sessionID, props.messageID, props.part.id)
      .then((part) => fullToolMetadataString(part, "diff"))
  return (
    <Switch>
      <Match when={diff()}>
        {(diff) => (
          <BlockTool title={title()} part={props.part} contentGap={0} paddingBottom={0}>
            <box>
              <TimelineDiff
                diff={diff()}
                filetype={filetype(filePath())}
                syntaxStyle={syntax()}
                loadFull={loadFullDiff}
              />
            </box>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
          </BlockTool>
        )}
      </Match>
      <Match when={true}>
        <InlineTool icon={toolPresentationIcon("edit")} pending="Preparing edit..." complete={filePath()} part={props.part}>
          Edit {normalizePath(filePath())} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const { syntax, theme } = useTheme()
  const sync = useSync()
  const files = createMemo(() => arrayValue(props.metadata.files).flatMap((item) => (isRecord(item) ? [item] : [])))
  const fullDiff = createMemo(() => stringValue(props.metadata.diff))
  const fileTitle = (file: Record<string, unknown>) => {
    return patchFileTitle(file, patchForFile(file) ?? "")
  }
  const fileTitleColor = (file: Record<string, unknown>) => {
    const type = stringValue(file.type)
    if (type === "delete") return theme.diffHighlightRemoved
    if (type === "add") return theme.diffHighlightAdded
    return undefined
  }
  const patchForFile = (file: Record<string, unknown>) => stringValue(file.patch) ?? fullDiff()
  const loadFullPatch = (filePath: string) =>
    sync.session
      .loadFullToolPart(props.sessionID, props.messageID, props.part.id)
      .then((part) => fullToolMetadataPatch(part, filePath))
  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool
              title={fileTitle(file)}
              titleColor={fileTitleColor(file)}
              part={props.part}
              contentGap={0}
              paddingBottom={0}
            >
              <box>
                <TimelineDiff
                  diff={patchForFile(file) ?? ""}
                  view="unified"
                  filetype={filetype(stringValue(file.filePath) ?? stringValue(file.relativePath))}
                  syntaxStyle={syntax()}
                  loadFull={() => loadFullPatch(stringValue(file.filePath) ?? stringValue(file.relativePath) ?? "")}
                />
              </box>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon={toolPresentationIcon("apply_patch")} pending="Preparing patch..." complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function MarkdownChecklist(props: { content: string }) {
  const { theme, syntax } = useTheme()
  return (
    <markdown
      syntaxStyle={syntax()}
      streaming={false}
      content={props.content}
      fg={theme.markdownText}
      bg={theme.background}
    />
  )
}

function todoMarkdown(status: string | undefined, content: string | undefined) {
  return `- [${status === "completed" ? "x" : " "}] ${(content ?? "").replace(/\s+/g, " ").trim()}`
}

function parseTodoOutput(output?: string): Record<string, unknown>[] {
  if (!output) return []
  try {
    const parsed = JSON.parse(output) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => (isRecord(item) ? [item] : []))
  } catch {
    return []
  }
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => {
    const inputTodos = arrayValue(props.input.todos).flatMap((item) => (isRecord(item) ? [item] : []))
    if (inputTodos.length) return inputTodos
    const metadataTodos = arrayValue(props.metadata.todos).flatMap((item) => (isRecord(item) ? [item] : []))
    if (metadataTodos.length) return metadataTodos
    return parseTodoOutput(props.output)
  })
  const content = createMemo(() =>
    todos()
      .map((todo) => todoMarkdown(stringValue(todo.status), stringValue(todo.content)))
      .join("\n"),
  )
  return (
    <Switch>
      <Match when={todos().length > 0 && props.part.state.status === "completed"}>
        <BlockTool title="# Todos" part={props.part} marginTop={1}>
          <MarkdownChecklist content={content()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon={toolPresentationIcon("todowrite")} pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const questions = createMemo(() =>
    arrayValue(props.input.questions).flatMap((item) => (isRecord(item) ? [item] : [])),
  )
  const answers = createMemo(() => arrayValue(props.metadata.answers))
  const content = createMemo(() =>
    questions()
      .map((question, index) => {
        const answer = formatAnswer(answers()[index])
        return `- [${answer === "(no answer)" ? " " : "x"}] ${(stringValue(question.question) ?? "").replace(/\s+/g, " ").trim()}\n  ${answer}`
      })
      .join("\n"),
  )
  return (
    <Switch>
      <Match when={answers().length > 0}>
        <BlockTool title="# Questions" part={props.part} marginTop={1}>
          <MarkdownChecklist content={content()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon={toolPresentationIcon("question")} pending="Asking questions..." complete={questions().length} part={props.part}>
          Asked {questions().length} question{questions().length === 1 ? "" : "s"}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon={toolPresentationIcon("skill")} pending="Loading skill..." complete={toolComplete(props.part)} part={props.part}>
      Skill "{stringValue(props.input.name) ?? pendingInput(props.part)}"
    </InlineTool>
  )
}

function MemoryGraph(props: ToolProps) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const route = useRoute()
  const snapshot = createMemo(() => compactMemoryGraphSnapshot(props.metadata.graphSnapshot))
  const panelWidth = createMemo(() => Math.max(40, Math.min(72, dimensions().width - 12)))
  const mapWidth = createMemo(() => Math.max(24, panelWidth() - 4))
  const graph = createMemo(() => {
    const data = snapshot()
    if (!data) return
    return memoryGraphMiniMap({
      facts: data.facts,
      links: data.links,
      categories: data.categories,
      width: mapWidth(),
      height: panelWidth() < 54 ? 5 : 6,
      connectedOnly: false,
    })
  })
  const title = createMemo(() => {
    const data = snapshot()
    const action = data?.action ? data.action.replace(/_/g, " ") : typeof props.input.action === "string" ? props.input.action.replace(/_/g, " ") : "graph"
    const query = data?.query || (typeof props.input.query === "string" ? props.input.query : "")
    return query ? `Memory graph · ${action} · ${Locale.truncateMiddle(query, 32)}` : `Memory graph · ${action}`
  })
  const healthTone = createMemo(() => {
    const state = snapshot()?.health?.graphHealth
    if (state === "connected") return theme.success
    if (state === "empty") return theme.textMuted
    return theme.warning
  })
  const short = (value: string, width = mapWidth()) => Locale.truncate(value, Math.max(8, width))
  const footer = createMemo(() => {
    const data = snapshot()
    const frame = graph()
    if (!data || !frame) return ""
    const state = data.health?.graphHealth ?? (frame.scene.edges.length ? "connected" : "disconnected")
    return `${state} · ${frame.stats} · ${frame.scene.edges.length} links`
  })
  const detailRows = createMemo(() => {
    const data = snapshot()
    return data ? compactMemoryGraphRows(data, panelWidth() - 2) : []
  })
  const openGraph = () => route.navigate({
    type: "memory",
    view: "graph",
    returnTo: route.data.type === "session" ? { type: "session", sessionID: route.data.sessionID } : { type: "home" },
  })

  return (
    <Show when={snapshot()} fallback={<GenericTool {...props} />}>
      <BlockTool
        title={`${toolPresentationIcon("memory_graph")} ${title()}`}
        titleColor={healthTone()}
        titleAttributes={TextAttributes.BOLD}
        contentGap={0}
        part={props.part}
        spinner={props.part.state.status === "running"}
        onClick={openGraph}
      >
        <box flexDirection="column" width={panelWidth()} paddingLeft={1} overflow="hidden">
          <Show when={graph()?.rows.length}>
            <box flexDirection="column" overflow="hidden">
              <MemoryGraphCanvasRows cells={graph()!.cells} categories={snapshot()!.categories} />
            </box>
          </Show>
          <text fg={healthTone()} wrapMode="none">{short(footer(), panelWidth() - 2)}</text>
          <For each={detailRows()}>
            {(row) => <text fg={theme.textMuted} wrapMode="none">{row}</text>}
          </For>
          <text fg={theme.primary} wrapMode="none">Open /memory-graph for the full view</text>
        </box>
      </BlockTool>
    </Show>
  )
}

function workflowPhaseInputList(value: unknown): WorkflowReceiptPhaseInput[] {
  return arrayValue(value).flatMap((item, index) => {
    if (!isRecord(item)) return []
    const taskIDs = arrayValue(item.taskIDs).filter((taskID): taskID is string => typeof taskID === "string")
    const counts = isRecord(item.counts)
      ? {
          total: numberValue(item.counts.total) ?? taskIDs.length,
          queued: numberValue(item.counts.queued) ?? 0,
          working: numberValue(item.counts.working) ?? 0,
          completed: numberValue(item.counts.completed) ?? 0,
          failed: numberValue(item.counts.failed) ?? 0,
          blocked: numberValue(item.counts.blocked) ?? 0,
        }
      : undefined
    return [{
      id: stringValue(item.id),
      ordinal: numberValue(item.ordinal) ?? index + 1,
      name: stringValue(item.name),
      state: stringValue(item.state),
      taskIDs,
      counts,
    }]
  })
}

function Workflow(props: ToolProps) {
  const sdk = useSDK()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const [refresh, setRefresh] = createSignal(0)
  const [activityFrame, setActivityFrame] = createSignal(0)
  const [hover, setHover] = createSignal(false)
  const action = createMemo(() => stringValue(props.input.action) ?? stringValue(props.metadata.action) ?? "workflow")
  const runID = createMemo(() => stringValue(props.metadata.runID) ?? stringValue(props.input.runID))
  const inputPlan = createMemo(() => isRecord(props.input.plan) ? props.input.plan : undefined)
  const [snapshot] = createResource(
    () => `${runID() ?? ""}:${refresh()}`,
    async () => {
      const id = runID()
      if (!id) return undefined
      const headers = new Headers(sdk.headers)
      headers.set("accept", "application/json")
      if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
      try {
        const response = await sdk.fetch(`${sdk.url}/workflow/${id}`, { headers })
        if (!response.ok) return undefined
        return response.json().catch(() => undefined) as Promise<unknown>
      } catch {
        return undefined
      }
    },
  )
  const record = (value: unknown) => isRecord(value) ? value : undefined
  const live = createMemo<Record<string, unknown> | undefined>(() => record(snapshot.latest))
  const liveRun = createMemo<Record<string, unknown> | undefined>(() => record(live()?.run))
  const liveDefinition = createMemo<Record<string, unknown> | undefined>(() => record(live()?.definition))
  const liveRevision = createMemo<Record<string, unknown> | undefined>(() => record(live()?.revision))
  const livePlan = createMemo<Record<string, unknown> | undefined>(() => record(liveRevision()?.plan))
  const phases = createMemo(() =>
    workflowReceiptFallbackPhases({
      live: workflowPhaseInputList(live()?.phases),
      metadata: workflowPhaseInputList(props.metadata.phases),
      plan: workflowPhaseInputList(inputPlan()?.phases),
    }),
  )
  const state = createMemo(() =>
    stringValue(liveRun()?.state)
      ?? stringValue(props.metadata.state)
      ?? (props.part.state.status === "running" ? "working" : action() === "preview" ? "ready" : props.part.state.status),
  )
  const title = createMemo(() =>
    stringValue(liveDefinition()?.name)
      ?? stringValue(inputPlan()?.name)
      ?? stringValue(props.input.name)
      ?? "Workflow",
  )
  const objective = createMemo(() =>
    stringValue(livePlan()?.objective)
      ?? stringValue(props.metadata.objective)
      ?? stringValue(inputPlan()?.objective),
  )
  const phaseDiagram = createMemo(() => workflowReceiptPhaseDiagram({ phases: phases() }, activityFrame(), 8))
  const panelWidth = createMemo(() => Math.max(52, Math.min(92, dimensions().width - 12)))
  const completedPhases = createMemo(() => phases().filter((phase) => phase.state === "completed").length)
  const stateColor = createMemo(() => {
    if (state() === "completed") return theme.success
    if (state() === "failed" || state() === "blocked") return theme.error
    if (state() === "stopped" || state() === "paused" || state() === "needs_input") return theme.warning
    return theme.secondary
  })

  onMount(() => {
    const animation = setInterval(() => {
      if (workflowReceiptStateIsAnimated(state())) setActivityFrame((value) => value + 1)
    }, 180)
    const fallback = setInterval(() => {
      if (runID() && !workflowReceiptStateIsTerminal(state())) setRefresh((value) => value + 1)
    }, 5_000)
    const unsubscribe = sdk.event.on("event", (event) => {
      const type = event.payload?.type as string | undefined
      if (type?.startsWith("workflow.")) setRefresh((value) => value + 1)
    })
    onCleanup(() => {
      clearInterval(animation)
      clearInterval(fallback)
      unsubscribe()
    })
  })

  const openWorkflow = () => {
    const id = runID()
    if (!id || renderer.getSelection()?.getSelectedText()) return
    navigate({ type: "workflows", selectedID: id, returnTo: { type: "session", sessionID: props.sessionID } })
  }

  return (
    <BlockTool
      title="# ◇ Workflow"
      titleColor={stateColor()}
      contentGap={0}
      part={props.part}
      spinner={props.part.state.status === "running" && phases().length === 0}
    >
      <box width="100%" alignItems="center">
        <box
          flexDirection="column"
          width={panelWidth()}
          onMouseUp={openWorkflow}
          flexShrink={0}
          borderStyle="single"
          borderColor={hover() ? stateColor() : theme.border}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={0}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          <box flexDirection="row">
            <text fg={stateColor()} attributes={TextAttributes.BOLD}>◇ {Locale.truncateMiddle(title(), Math.max(18, panelWidth() - 34))}</text>
            <box flexGrow={1} />
            <text fg={stateColor()}>{workflowReceiptStateMarker(state(), activityFrame())} {workflowReceiptStateLabel(state())}</text>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
            <text fg={theme.textMuted}>action     <span style={{ fg: theme.text }}>{action()}</span></text>
            <text fg={theme.textMuted}>run        <span style={{ fg: runID() ? theme.text : theme.textMuted }}>{Locale.truncateMiddle(runID() ?? "not started", Math.max(18, panelWidth() - 20))}</span></text>
            <text fg={theme.textMuted}>phases     <span style={{ fg: theme.text }}>{completedPhases()}/{phases().length} complete</span></text>
            <Show when={objective()}>{(value) => <text fg={theme.textMuted} wrapMode="word">{Locale.truncate(value(), Math.max(24, panelWidth() - 6))}</text>}</Show>
          </box>
          <Show when={phaseDiagram().length > 0}>
            <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>PHASE FLOW</text>
              <For each={phaseDiagram()}>
                {(row) => (
                  <text
                    fg={
                      row.kind !== "phase"
                        ? theme.border
                        : row.state === "completed"
                          ? theme.success
                          : row.state === "failed" || row.state === "blocked"
                            ? theme.error
                            : row.state === "working"
                              ? theme.secondary
                              : theme.textMuted
                    }
                    wrapMode="none"
                  >
                    {Locale.truncateMiddle(row.text, Math.max(24, panelWidth() - 6))}
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={runID()}>
            <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1}>
              <text fg={hover() ? stateColor() : theme.textMuted}>open workflow monitor</text>
            </box>
          </Show>
        </box>
      </box>
    </BlockTool>
  )
}

function Loop(props: ToolProps) {
  const { navigate } = useRoute()
  const sdk = useSDK()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [tick, setTick] = createSignal(Date.now())
  const [refresh, setRefresh] = createSignal(0)
  const action = createMemo(() => stringValue(props.input.action) ?? "loop")
  const workflowID = createMemo(() => stringValue(props.metadata.workflowID))
  const rootSessionID = createMemo(() => stringValue(props.metadata.rootSessionID ?? props.metadata.sessionId))
  const state = createMemo(() => stringValue(props.metadata.state))
  const phase = createMemo(() => stringValue(props.metadata.phase))
  const workflowList = createMemo(() =>
    arrayValue(props.metadata.workflows).flatMap((item) =>
      isRecord(item) && stringValue(item.workflowID)
        ? [
            {
              workflowID: stringValue(item.workflowID)!,
              rootSessionID: stringValue(item.rootSessionID),
              state: stringValue(item.state) ?? "unknown",
              phase: stringValue(item.phase) ?? "ready",
              name: stringValue(item.name),
              turns: typeof item.turns === "number" ? item.turns : undefined,
              maxTurns: typeof item.maxTurns === "number" ? item.maxTurns : undefined,
            },
          ]
        : [],
    ),
  )

  async function fetchLoopSnapshot() {
    const id = workflowID()
    if (!id) return undefined
    const headers = new Headers(sdk.headers)
    headers.set("accept", "application/json")
    if (sdk.directory) headers.set("x-mendcode-directory", encodeURIComponent(sdk.directory))
    try {
      const response = await sdk.fetch(`${sdk.url}/loop/${id}`, { headers })
      if (!response.ok) return undefined
      return response.json().catch(() => undefined) as Promise<
        | {

          workflow?: {
            id?: string
            name?: string
            objective?: string
            state?: string
            phase?: string
            rootSessionID?: string
            nextWakeup?: number
            policy?: { maxTurns?: number }
            metrics?: { turns?: number; failures?: number }
            time?: { created?: number; updated?: number; activated?: number }
          }
          runs?: unknown[]
          events?: unknown[]
        }
        | undefined
      >
    } catch {
      return undefined
    }
  }

  const [snapshot] = createResource(
    () => `${workflowID() || ""}:${refresh()}`,
    fetchLoopSnapshot,
  )

  onMount(() => {
    const clock = setInterval(() => setTick(Date.now()), 1_000)
    const poll = setInterval(() => setRefresh((value) => value + 1), 2_000)
    const unsubscribe = sdk.event.on("event", (evt) => {
      const type = evt.payload?.type as string | undefined
      const id = ((evt.payload as { properties?: Record<string, unknown> } | undefined)?.properties)?.workflowID
      if (type?.startsWith("loop.") && (!workflowID() || id === workflowID())) setRefresh((value) => value + 1)
    })
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(poll)
      unsubscribe()
    })
  })

  const workflow = createMemo(() => snapshot.latest?.workflow)
  const liveState = createMemo(() => workflow()?.state ?? state() ?? (props.part.state.status === "running" ? "working" : "unknown"))
  const livePhase = createMemo(() => workflow()?.phase ?? phase() ?? action())
  const liveRootSessionID = createMemo(() => workflow()?.rootSessionID ?? rootSessionID())
  const liveCreatedAt = createMemo(() => workflow()?.time?.activated ?? workflow()?.time?.created)
  const liveAge = createMemo(() => {
    const started = liveCreatedAt()
    if (!started) return "unknown"
    return formatDuration(Math.max(0, Math.round((tick() - started) / 1000)))
  })
  const liveProgress = createMemo(() => {
    const turns = workflow()?.metrics?.turns ?? 0
    const maxTurns = workflow()?.policy?.maxTurns
    return maxTurns ? `${turns}/${maxTurns}` : `${turns}/unlimited`
  })
  const liveNextWakeup = createMemo(() => {
    const next = workflow()?.nextWakeup
    if (!next) return "manual/self-paced"
    const seconds = Math.max(0, Math.round((next - tick()) / 1000))
    return `${formatDuration(seconds)} (${new Date(next).toLocaleTimeString()})`
  })
  const [hover, setHover] = createSignal(false)
  const panelWidth = createMemo(() => Math.max(52, Math.min(88, dimensions().width - 12)))
  const valueWidth = createMemo(() => Math.max(18, panelWidth() - 20))
  const compact = (value: string, width = valueWidth()) => Locale.truncateMiddle(value.replace(/\s+/g, " ").trim(), width)
  const stateColor = createMemo(() => {
    const state = liveState()
    if (state === "working" || state === "active" || state === "sleeping") return theme.primary
    if (state === "completed") return theme.success
    if (state === "failed") return theme.error
    if (state === "stopped" || state === "paused") return theme.warning
    return theme.textMuted
  })
  const progressBar = createMemo(() => {
    const turns = workflow()?.metrics?.turns ?? 0
    const maxTurns = workflow()?.policy?.maxTurns
    if (!maxTurns) return "unbounded"
    const width = 14
    const filled = Math.max(0, Math.min(width, Math.round((turns / Math.max(1, maxTurns)) * width)))
    return `${"■".repeat(filled)}${"·".repeat(width - filled)} ${turns}/${maxTurns}`
  })
  const rows = createMemo(() => {
    const item = workflow()
    const id = workflowID() ?? "pending"
    const root = liveRootSessionID() ?? "pending"
    const objective = item?.objective ?? stringValue(props.input.objective) ?? "Loop workflow"
    return [
      { label: "workflow", value: item?.name ?? compact(id, 32), color: theme.text },
      { label: "state", value: `${liveState()} / ${livePhase()}`, color: stateColor() },
      { label: "progress", value: progressBar(), color: stateColor() },
      { label: "runtime", value: liveAge(), color: theme.text },
      { label: "next", value: liveNextWakeup(), color: theme.text },
      { label: "runs", value: String(snapshot.latest?.runs?.length ?? 0), color: theme.text },
      { label: "root", value: root, color: liveRootSessionID() ? theme.secondary : theme.textMuted },
      { label: "goal", value: objective, color: theme.text },
    ]
  })
  const liveLabel = createMemo(() => (snapshot.loading ? "refreshing" : "live SSE"))
  const listGroups = createMemo(() => {
    const groups = new Map<string, number>()
    for (const item of workflowList()) groups.set(item.state, (groups.get(item.state) ?? 0) + 1)
    return Array.from(groups.entries())
      .map(([state, count]) => `${state} ${count}`)
      .join(" · ")
  })
  const listRows = createMemo(() =>
    workflowList().slice(0, 8).map((item) => ({
      name: item.name ?? item.workflowID,
      state: `${item.state} / ${item.phase}`,
      progress:
        typeof item.turns === "number" && typeof item.maxTurns === "number"
          ? `${item.turns}/${item.maxTurns}`
          : typeof item.turns === "number"
            ? `${item.turns}/unbounded`
            : "unbounded",
    })),
  )
  const openFirstLoop = () => {
    const sessionID = liveRootSessionID() ?? workflowList().find((item) => item.rootSessionID)?.rootSessionID
    if (sessionID) navigate({ type: "session", sessionID })
  }
  const handleOpenFirstLoop = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    openFirstLoop()
  }

  if (action() === "list" && !workflowID()) {
    return (
      <BlockTool title="# ↻ Loop Workflows" titleColor={theme.secondary} contentGap={0} part={props.part}>
        <box width="100%" alignItems="center">
          <box
            flexDirection="column"
            width={panelWidth()}
            onMouseUp={handleOpenFirstLoop}
            flexShrink={0}
            borderStyle="single"
            borderColor={hover() ? theme.secondary : theme.border}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={0}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
          >
            <box flexDirection="row">
              <text fg={theme.secondary} attributes={TextAttributes.BOLD}>↻ Loop Workflows</text>
              <box flexGrow={1} />
              <text fg={theme.textMuted}>{workflowList().length} total</text>
            </box>
            <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
              <Show when={workflowList().length > 0} fallback={<text fg={theme.textMuted}>No loop workflows found.</text>}>
                <text fg={theme.textMuted}>{listGroups()}</text>
                <box marginTop={1} flexDirection="column">
                  <For each={listRows()}>
                    {(item) => (
                      <box flexDirection="row">
                        <text fg={theme.text} wrapMode="none">{compact(item.name, Math.max(18, panelWidth() - 34))}</text>
                        <box flexGrow={1} />
                        <text fg={theme.textMuted} wrapMode="none">{item.state}</text>
                        <text fg={theme.textMuted} wrapMode="none"> {item.progress}</text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
            <Show when={workflowList().some((item) => item.rootSessionID)}>
              <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="row">
                <text fg={hover() ? theme.secondary : theme.textMuted}>open first loop chat</text>
                <box flexGrow={1} />
                <text fg={theme.textMuted}>click</text>
              </box>
            </Show>
          </box>
        </box>
      </BlockTool>
    )
  }

  return (
    <BlockTool
      title="# ↻ Loop Workflow"
      titleColor={stateColor()}
      contentGap={0}
      part={props.part}
      spinner={props.part.state.status === "running" && !workflowID()}
    >
      <box width="100%" alignItems="center">
        <box
          flexDirection="column"
          width={panelWidth()}
          onMouseUp={handleOpenFirstLoop}
          flexShrink={0}
          borderStyle="single"
          borderColor={hover() ? stateColor() : theme.border}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={0}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          <box flexDirection="row">
            <text fg={stateColor()} attributes={TextAttributes.BOLD}>↻ {compact(workflow()?.name ?? "Loop Workflow", Math.max(18, panelWidth() - 36))}</text>
            <box flexGrow={1} />
            <text fg={theme.textMuted}>{liveLabel()}</text>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="column">
            <For each={rows()}>
              {(row) => (
                <box flexDirection="row">
                  <text fg={theme.textMuted} wrapMode="none">{row.label.padEnd(9)}</text>
                  <text fg={row.color} wrapMode="none">{compact(row.value)}</text>
                </box>
              )}
            </For>
          </box>
          <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} flexDirection="row">
            <text fg={hover() ? stateColor() : theme.textMuted}>open loop chat</text>
            <box flexGrow={1} />
            <text fg={theme.textMuted}>click</text>
          </box>
        </box>
      </box>
    </BlockTool>
  )
}

function Task(props: ToolProps) {
  const sync = useSync()
  const sessionId = createMemo(() => stringValue(props.metadata.sessionId))
  const childMessages = createMemo(() => (sessionId() ? (sync.data.message[sessionId()!] ?? []) : []))
  const childState = createMemo(() => {
    const id = sessionId()
    if (!id) return undefined
    const pendingInputCount =
      (sync.data.permission[id]?.length ?? 0) +
      (sync.data.question[id]?.length ?? 0) +
      (sync.data.plan_review[id]?.length ?? 0)
    return taskSessionState(sync.data.session_status[id], childMessages(), pendingInputCount)
  })
  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return pendingInput(props.part)
    const title = `${Locale.titlecase(stringValue(props.input.subagent_type) ?? "General")} Task — ${description}`
    const state = childState()
    if (!state || (state === "responded" && props.part.state.status === "completed")) return title
    return `${title}\n↳ child ${state}`
  })
  return (
    <InlineTool
      icon="│"
      spinner={props.part.state.status === "running"}
      complete={toolComplete(props.part)}
      pending="Delegating..."
      part={props.part}
    >
      {content()}
    </InlineTool>
  )
}

function taskSessionState(
  status: { type: string; attempt?: number } | undefined,
  messages: Array<{ role: string; time: { created: number; completed?: number } }>,
  pendingInputCount: number,
) {
  if (pendingInputCount > 0) return "needs input"
  if (status?.type === "retry") return status.attempt && status.attempt > 1 ? `retry #${status.attempt}` : "retrying"
  if (status?.type === "busy") return "working"
  const lastUser = messages.findLast((message) => message.role === "user")
  const lastAssistant = messages.findLast((message) => message.role === "assistant")
  if (lastAssistant && !lastAssistant.time.completed) return "working"
  if (lastUser && (!lastAssistant || lastAssistant.time.created < lastUser.time.created)) return "waiting"
  if (lastAssistant) return "responded"
  return "ready"
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    if (!isRecord(props.diagnostics)) return []
    const value = props.diagnostics[normalizePath(props.filePath)] ?? props.diagnostics[props.filePath]
    return arrayValue(value)
      .flatMap((item) => (isRecord(item) ? [item] : []))
      .filter((diagnostic) => diagnostic.severity === 1)
      .slice(0, 3)
  })
  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => <text fg={theme.error}>Error {stringValue(diagnostic.message)}</text>}
        </For>
      </box>
    </Show>
  )
}

function toolOutput(content?: Array<ToolTextContent | ToolFileContent>) {
  return (content ?? [])
    .map((item) => {
      if (item.type === "text") return item.text.trim()
      return `[file ${item.name ?? item.uri}]`
    })
    .filter(Boolean)
    .join("\n")
}

function toolInputRecord(input: string | Record<string, unknown>) {
  if (typeof input === "string") return {}
  return input
}

function pendingInput(part: SessionMessageAssistantTool) {
  if (part.state.status !== "pending") return ""
  return part.state.input.trim()
}

function toolComplete(part: SessionMessageAssistantTool) {
  if (part.state.status === "pending") return pendingInput(part)
  return part.state.status === "completed" || part.state.status === "error" || part.state.status === "running"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function input(input: Record<string, unknown>, omit?: string[]) {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function normalizePath(input?: string) {
  if (!input) return ""
  const absolute = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input)
  const relative = path.relative(process.cwd(), absolute)
  if (!relative) return "."
  if (!relative.startsWith("..")) return relative
  return absolute
}

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function formatAnswer(answer: unknown) {
  if (!Array.isArray(answer)) return "(no answer)"
  if (answer.length === 0) return "(no answer)"
  return answer.filter((item): item is string => typeof item === "string").join(", ")
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: route,
      render(input) {
        const sessionID = input.params?.sessionID
        if (typeof sessionID !== "string") {
          return <text fg={api.theme.current.error}>Missing sessionID</text>
        }
        return <View api={api} sessionID={sessionID} />
      },
    },
  ])

  api.command.register(() => [
    {
      title: "View v2 session messages",
      value: route,
      category: "Debug",
      suggested: api.route.current.name === "session",
      enabled: api.route.current.name === "session",
      onSelect() {
        const sessionID = currentSessionID(api)
        if (!sessionID) return
        api.route.navigate(route, { sessionID })
        api.ui.dialog.clear()
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin

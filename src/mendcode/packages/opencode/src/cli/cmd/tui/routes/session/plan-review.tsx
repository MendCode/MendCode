import { createMemo, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { RGBA, TextAttributes, type TextareaRenderable } from "@opentui/core"
import type { PlanReviewRequest } from "@mendcode/sdk/v2"
import { SplitBorder } from "../../component/border"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useDialog } from "../../ui/dialog"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../context/tui-config"
import { renderPlanMarkdown } from "../../util/plan-markdown"
import { StyledPlanMarkdown } from "../../component/styled-plan-markdown"

type Stage = "preview" | "edit" | "comment" | "reject"

function previewMarkdown(markdown: string) {
  return markdown.replace(/^\s*#\s+[^\n]+\n{1,2}/, "")
}

export function PlanReviewPrompt(props: { request: PlanReviewRequest }) {
  const sdk = useSDK()
  const { theme, syntax } = useTheme()
  const dialog = useDialog()
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const [stage, setStage] = createSignal<Stage>("preview")
  const [markdown, setMarkdown] = createSignal(props.request.markdown)
  const [comments, setComments] = createSignal("")
  const [reason, setReason] = createSignal("")
  const modalWidth = createMemo(() => Math.max(64, Math.min(128, dimensions().width - 10)))
  const modalHeight = createMemo(() => Math.max(24, dimensions().height - 2))
  const modalLeft = createMemo(() => Math.max(2, Math.floor((dimensions().width - modalWidth()) / 2)))
  const modalTop = createMemo(() => Math.max(1, Math.floor((dimensions().height - modalHeight()) / 2)))
  const bodyHeight = createMemo(() => Math.max(9, modalHeight() - 7))
  const [rendered] = createResource(
    () => ({ markdown: previewMarkdown(markdown()), width: Math.max(48, modalWidth() - 10) }),
    (input) => renderPlanMarkdown(input.markdown, input.width, { tableMode: "grid", markdownMode: "tables-only" }),
  )

  let editArea: TextareaRenderable | undefined
  let commentArea: TextareaRenderable | undefined
  let rejectArea: TextareaRenderable | undefined

  const title = createMemo(() => props.request.title?.trim() || "plan.md")
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  function reviewComments(override?: string) {
    const value = (override ?? comments()).trim()
    return value || undefined
  }

  function reply(
    action: "apply" | "edit" | "reject",
    override?: { markdown?: string; reason?: string; comments?: string },
  ) {
    void sdk.client.planReview.reply({
      requestID: props.request.id,
      planReviewReply: {
        action,
        markdown: action === "apply" || action === "edit" ? (override?.markdown ?? markdown()) : undefined,
        reason: action === "reject" ? (override?.reason ?? reason()).trim() : undefined,
        comments: action === "apply" || action === "edit" ? reviewComments(override?.comments) : undefined,
      },
    })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (stage() === "preview") {
      if (evt.name === "return") {
        evt.preventDefault()
        reply("apply")
        return
      }
      if (evt.name === "e") {
        evt.preventDefault()
        setStage("edit")
        setTimeout(() => editArea?.focus(), 1)
        return
      }
      if (evt.name === "c") {
        evt.preventDefault()
        setStage("comment")
        setTimeout(() => commentArea?.focus(), 1)
        return
      }
      if (evt.name === "r") {
        evt.preventDefault()
        setStage("reject")
        setTimeout(() => rejectArea?.focus(), 1)
        return
      }
      return
    }

    if (stage() === "edit") {
      if (evt.name === "escape") {
        evt.preventDefault()
        setStage("preview")
        return
      }
      if (evt.ctrl && evt.name === "o") {
        evt.preventDefault()
        const value = editArea?.plainText ?? markdown()
        setMarkdown(value)
        reply("apply", { markdown: value, comments: comments() })
      }
      return
    }

    if (stage() === "comment") {
      if (evt.name === "escape") {
        evt.preventDefault()
        setComments(commentArea?.plainText ?? comments())
        setStage("preview")
        return
      }
      if (evt.ctrl && evt.name === "o") {
        evt.preventDefault()
        const value = commentArea?.plainText ?? comments()
        setComments(value)
        reply("apply", { comments: value })
      }
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      setStage("preview")
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      const value = rejectArea?.plainText ?? ""
      setReason(value)
      reply("reject", { reason: value })
    }
  })

  return (
    <box
      position="absolute"
      zIndex={2999}
      top={0}
      left={0}
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={RGBA.fromInts(0, 0, 0, 160)}
    >
      <box
        position="absolute"
        zIndex={3000}
        top={modalTop()}
        left={modalLeft()}
        width={modalWidth()}
        height={modalHeight()}
        backgroundColor={theme.backgroundPanel}
        flexDirection="column"
      >
        <box
          height={4}
          flexDirection="row"
          justifyContent="center"
          alignItems="center"
          paddingLeft={2}
          paddingRight={2}
          border={["bottom"]}
          borderColor={theme.border}
          customBorderChars={SplitBorder.customBorderChars}
          flexShrink={0}
        >
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            ◆ {title()}
          </text>
        </box>

        <Switch>
          <Match when={stage() === "preview"}>
            <scrollbox
              height={bodyHeight()}
              paddingTop={1}
              paddingLeft={4}
              paddingRight={4}
              stickyScroll={true}
              stickyStart="top"
              scrollAcceleration={scrollAcceleration()}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme.backgroundPanel,
                  foregroundColor: theme.borderActive,
                },
              }}
            >
              <Show when={rendered()} fallback={<text fg={theme.textMuted}>Rendering plan...</text>}>
                {(content) => (
                  <StyledPlanMarkdown
                    syntaxStyle={syntax()}
                    content={content()}
                    fg={theme.markdownText}
                    bg={theme.backgroundPanel}
                  />
                )}
              </Show>
            </scrollbox>
          </Match>
          <Match when={stage() === "edit"}>
            <box height={bodyHeight()} paddingTop={1} paddingLeft={4} paddingRight={4}>
              <textarea
                height="100%"
                ref={(value: TextareaRenderable) => {
                  editArea = value
                }}
                initialValue={markdown()}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
              />
            </box>
          </Match>
          <Match when={stage() === "comment"}>
            <box height={bodyHeight()} paddingTop={1} paddingLeft={4} paddingRight={4} gap={1}>
              <text fg={theme.textMuted}>Implementation comments for the agent</text>
              <textarea
                height={Math.max(5, bodyHeight() - 2)}
                ref={(value: TextareaRenderable) => {
                  commentArea = value
                }}
                initialValue={comments()}
                placeholder="Notes, constraints, or changes to keep in mind"
                placeholderColor={theme.textMuted}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
              />
            </box>
          </Match>
          <Match when={stage() === "reject"}>
            <box height={bodyHeight()} paddingTop={1} paddingLeft={4} paddingRight={4} gap={1}>
              <text fg={theme.textMuted}>Why reject this plan?</text>
              <textarea
                height={3}
                ref={(value: TextareaRenderable) => {
                  rejectArea = value
                }}
                initialValue={reason()}
                placeholder="Reason for the agent"
                placeholderColor={theme.textMuted}
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
              />
            </box>
          </Match>
        </Switch>

        <box
          height={3}
          flexDirection="row"
          justifyContent="center"
          alignItems="center"
          gap={3}
          paddingLeft={3}
          paddingRight={3}
          border={["top"]}
          borderColor={theme.border}
          customBorderChars={SplitBorder.customBorderChars}
          flexShrink={0}
        >
          <Switch>
            <Match when={stage() === "preview"}>
              <text fg={theme.text}>
                Enter <span style={{ fg: theme.textMuted }}>implement</span>
              </text>
              <text fg={theme.text}>
                e <span style={{ fg: theme.textMuted }}>edit</span>
              </text>
              <text fg={theme.text}>
                c <span style={{ fg: theme.textMuted }}>{comments().trim() ? "comments*" : "comments"}</span>
              </text>
              <text fg={theme.text}>
                r <span style={{ fg: theme.textMuted }}>reject</span>
              </text>
            </Match>
            <Match when={stage() === "edit"}>
              <text fg={theme.text}>
                Ctrl+o <span style={{ fg: theme.textMuted }}>save + implement</span>
              </text>
              <text fg={theme.text}>
                Esc <span style={{ fg: theme.textMuted }}>preview</span>
              </text>
            </Match>
            <Match when={stage() === "comment"}>
              <text fg={theme.text}>
                Ctrl+o <span style={{ fg: theme.textMuted }}>save + implement</span>
              </text>
              <text fg={theme.text}>
                Esc <span style={{ fg: theme.textMuted }}>preview</span>
              </text>
            </Match>
            <Match when={stage() === "reject"}>
              <text fg={theme.text}>
                Enter <span style={{ fg: theme.textMuted }}>send reason</span>
              </text>
              <text fg={theme.text}>
                Esc <span style={{ fg: theme.textMuted }}>preview</span>
              </text>
            </Match>
          </Switch>
        </box>
      </box>
    </box>
  )
}

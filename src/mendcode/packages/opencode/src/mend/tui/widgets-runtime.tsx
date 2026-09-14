import { For, Show } from "solid-js"
import type { QuestionRequest } from "@mendcode/sdk/v2"
import type { TuiThemeCurrent } from "@mendcode/plugin/tui"
import { Locale } from "@/util/locale"

export type AsyncQuestionRequest = QuestionRequest & { async?: boolean }
export type WidgetReasoningState = {
  sessionID: string
  mode: "auto" | "manual"
  effort: string
  reason: string
  modelID: string
  providerID: string
  messageID: string
  requestedAt: number
}

export function widgetReasoningLabel(state: WidgetReasoningState) {
  return `Last request: ${state.mode === "auto" ? "Auto" : "Manual"} ${state.effort}`
}

export type WidgetJob = {
  id: string
  sessionID: string
  kind: "job"
  status: string
  data: { tool?: unknown; error?: unknown }
  timeUpdated: number
}
export const isWidgetJobActive = (job: WidgetJob) => job.status === "queued" || job.status === "running"

export function SessionJobsWidget(props: {
  jobs: readonly WidgetJob[]
  width: number
  height: number
  theme: Pick<TuiThemeCurrent, "text" | "textMuted" | "accent" | "backgroundPanel">
  busyID?: string
  onCancel: (id: string) => void
}) {
  return (
    <box
      width={props.width}
      minWidth={props.width}
      height={props.height}
      flexShrink={0}
      flexDirection="column"
      paddingX={1}
      backgroundColor={props.theme.backgroundPanel}
    >
      <text fg={props.theme.textMuted} wrapMode="none">
        Tools · {props.jobs.filter(isWidgetJobActive).length} active
      </text>
      <scrollbox height={Math.max(1, props.height - 1)} width="100%">
        <For each={props.jobs}>
          {(job) => (
            <box width="100%" flexDirection="row" gap={1}>
              <text fg={props.theme.text} wrapMode="none" flexGrow={1} minWidth={0}>
                {Locale.truncate(
                  `${typeof job.data.tool === "string" ? job.data.tool : "Tool"} · ${job.status}${typeof job.data.error === "string" ? ` · ${job.data.error}` : ""}`.replace(
                    /\s+/g,
                    " ",
                  ),
                  Math.max(1, props.width - (isWidgetJobActive(job) ? 11 : 2)),
                )}
              </text>
              <Show when={isWidgetJobActive(job)}>
                <text
                  id={`async-job-cancel-${job.id}`}
                  fg={props.busyID ? props.theme.textMuted : props.theme.accent}
                  flexShrink={0}
                  wrapMode="none"
                  onMouseUp={() => {
                    if (!props.busyID) props.onCancel(job.id)
                  }}
                >
                  [cancel]
                </text>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}

export function splitWidgetQuestions(requests: readonly AsyncQuestionRequest[]) {
  return {
    blocking: requests.filter((request) => request.async !== true),
    asynchronous: requests.filter((request) => request.async === true),
  }
}

export function SessionQuestionsWidget(props: {
  questions: readonly AsyncQuestionRequest[]
  width: number
  height: number
  theme: Pick<TuiThemeCurrent, "text" | "textMuted" | "accent" | "backgroundPanel">
  onAnswer: (id: string) => void
}) {
  return (
    <box
      width={props.width}
      minWidth={props.width}
      height={props.height}
      flexShrink={0}
      flexDirection="column"
      paddingX={1}
      backgroundColor={props.theme.backgroundPanel}
    >
      <text fg={props.theme.textMuted} wrapMode="none">
        Questions · {props.questions.length} pending
      </text>
      <scrollbox height={Math.max(1, props.height - 1)} width="100%">
        <For each={props.questions}>
          {(request) => (
            <box width="100%" flexDirection="row" gap={1}>
              <text fg={props.theme.text} flexGrow={1} minWidth={0} wrapMode="none">
                {Locale.truncate(
                  (request.questions[0]?.question ?? "Question").replace(/\s+/g, " "),
                  Math.max(1, props.width - 11),
                )}
              </text>
              <text
                id={`async-question-answer-${request.id}`}
                fg={props.theme.accent}
                flexShrink={0}
                wrapMode="none"
                onMouseUp={() => props.onAnswer(request.id)}
              >
                [answer]
              </text>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}

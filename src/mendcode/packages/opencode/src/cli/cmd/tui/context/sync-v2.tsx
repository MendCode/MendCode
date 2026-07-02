import { useEvent } from "@tui/context/event"
import type {
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
} from "@mendcode/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { appendLiveShellOutput } from "./shell-output"

type ShellOutputEvent = {
  id: string
  type: "session.next.shell.output"
  properties: {
    timestamp: number
    sessionID: string
    callID: string
    delta: string
  }
}

const PREVIEW_TEXT_LIMIT = 128 * 1024

function previewText(value: string) {
  if (value.length <= PREVIEW_TEXT_LIMIT) return value
  const marker = `\n[Preview truncated: omitted ${value.length - PREVIEW_TEXT_LIMIT} chars; showing start and latest tail.]\n`
  const budget = Math.max(0, PREVIEW_TEXT_LIMIT - marker.length)
  if (budget <= 0) return value.slice(-PREVIEW_TEXT_LIMIT)
  const head = Math.floor(budget / 3)
  const tail = budget - head
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`
}

function previewToolContent<T>(content: T): T {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    if (!item || typeof item !== "object" || !("type" in item) || item.type !== "text" || typeof item.text !== "string") return item
    return { ...item, text: previewText(item.text) }
  }) as T
}

function previewTool(part: SessionMessageAssistantTool): SessionMessageAssistantTool {
  const state = part.state
  if (state.status === "pending") return part
  return {
    ...part,
    state: {
      ...state,
      content: previewToolContent(state.content),
    },
  } as SessionMessageAssistantTool
}

function previewMessage(message: SessionMessage): SessionMessage {
  if (message.type === "shell") return { ...message, output: previewText(message.output) }
  if (message.type === "user") return { ...message, text: previewText(message.text) }
  if (message.type === "synthetic") return { ...message, text: previewText(message.text) }
  if (message.type === "compaction") {
    return {
      ...message,
      summary: previewText(message.summary),
      include: message.include ? previewText(message.include) : message.include,
    }
  }
  if (message.type !== "assistant") return message
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "text") return { ...part, text: previewText(part.text) }
      if (part.type === "reasoning") return { ...part, text: previewText(part.text) }
      if (part.type === "tool") return previewTool(part)
      return part
    }),
  }
}

function activeAssistant(messages: SessionMessage[]) {
  const index = messages.findIndex((message) => message.type === "assistant" && !message.time.completed)
  if (index < 0) return
  const assistant = messages[index]
  return assistant?.type === "assistant" ? assistant : undefined
}

function activeCompaction(messages: SessionMessage[]) {
  const index = messages.findIndex((message) => message.type === "compaction")
  if (index < 0) return
  const compaction = messages[index]
  return compaction?.type === "compaction" ? compaction : undefined
}

function activeShell(messages: SessionMessage[], callID: string) {
  const index = messages.findIndex((message) => message.type === "shell" && message.callID === callID)
  if (index < 0) return
  const shell = messages[index]
  return shell?.type === "shell" ? shell : undefined
}

function latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantTool => item.type === "tool" && (callID === undefined || item.id === callID),
  )
}

function latestText(assistant: SessionMessageAssistant | undefined) {
  return assistant?.content.findLast((item): item is SessionMessageAssistantText => item.type === "text")
}

function latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
  )
}

export const { use: useSyncV2, provider: SyncProviderV2 } = createSimpleContext({
  name: "SyncV2",
  init: () => {
    const [store, setStore] = createStore<{
      messages: {
        [sessionID: string]: SessionMessage[]
      }
    }>({
      messages: {},
    })

    const event = useEvent()
    const sdk = useSDK()
    const syncedSessions = new Set<string>()
    const syncTimers = new Map<string, Timer>()
    const syncInFlight = new Map<string, Promise<void>>()
    const syncQueued = new Set<string>()

    function update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
      syncedSessions.add(sessionID)
      setStore(
        "messages",
        produce((draft) => {
          fn((draft[sessionID] ??= []))
        }),
      )
    }

    async function syncMessages(sessionID: string, options?: { force?: boolean }) {
      syncedSessions.add(sessionID)
      if (!options?.force && store.messages[sessionID]) return

      const existing = syncInFlight.get(sessionID)
      if (existing) {
        if (options?.force) syncQueued.add(sessionID)
        return existing
      }

      const run = sdk.client.v2.session
        .messages({ sessionID, limit: 5_000, view: "tui" } as Parameters<
          typeof sdk.client.v2.session.messages
        >[0] & { limit: number; view: "tui" })
        .then((response) => {
          setStore("messages", sessionID, reconcile((response.data?.items ?? []).map(previewMessage)))
        })
        .finally(() => {
          syncInFlight.delete(sessionID)
          if (!syncQueued.delete(sessionID)) return
          scheduleSync(sessionID, 0)
        })

      syncInFlight.set(sessionID, run)
      return run
    }

    function scheduleSync(sessionID: string, delay: number) {
      syncedSessions.add(sessionID)
      const existing = syncTimers.get(sessionID)
      if (existing) clearTimeout(existing)
      syncTimers.set(
        sessionID,
        setTimeout(() => {
          syncTimers.delete(sessionID)
          void syncMessages(sessionID, { force: true }).catch(() => undefined)
        }, delay),
      )
    }

    function scheduleKnownSessionSync(delay = 0) {
      for (const sessionID of syncedSessions) scheduleSync(sessionID, delay)
    }

    event.subscribe((event) => {
      const shellOutputEvent = event as typeof event | ShellOutputEvent
      if (shellOutputEvent.type === "session.next.shell.output") {
        update(shellOutputEvent.properties.sessionID, (draft) => {
          const match = activeShell(draft, shellOutputEvent.properties.callID)
          if (!match || match.time.completed) return
          match.output = appendLiveShellOutput(match.output, shellOutputEvent.properties.delta)
        })
        return
      }

      switch (event.type) {
        case "session.next.prompted": {
          update(event.properties.sessionID, (draft) => {
            draft.unshift({
              id: event.id,
              type: "user",
              text: previewText(event.properties.prompt.text),
              files: event.properties.prompt.files,
              agents: event.properties.prompt.agents,
              time: { created: event.properties.timestamp },
            })
          })
          break
        }
        case "session.next.synthetic":
          update(event.properties.sessionID, (draft) => {
            draft.unshift({
              id: event.id,
              type: "synthetic",
              sessionID: event.properties.sessionID,
              text: previewText(event.properties.text),
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.shell.started":
          update(event.properties.sessionID, (draft) => {
            draft.unshift({
              id: event.id,
              type: "shell",
              callID: event.properties.callID,
              command: event.properties.command,
              output: "",
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          update(event.properties.sessionID, (draft) => {
            const match = activeShell(draft, event.properties.callID)
            if (!match) return
            match.output = previewText(event.properties.output)
            match.time.completed = event.properties.timestamp
          })
          scheduleSync(event.properties.sessionID, 50)
          break
        case "session.next.step.started":
          update(event.properties.sessionID, (draft) => {
            const currentAssistant = activeAssistant(draft)
            if (currentAssistant) currentAssistant.time.completed = event.properties.timestamp
            draft.unshift({
              id: event.id,
              type: "assistant",
              agent: event.properties.agent,
              model: event.properties.model,
              content: [],
              snapshot: event.properties.snapshot ? { start: event.properties.snapshot } : undefined,
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          update(event.properties.sessionID, (draft) => {
            const currentAssistant = activeAssistant(draft)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.properties.timestamp
            currentAssistant.finish = event.properties.finish
            currentAssistant.cost = event.properties.cost
            currentAssistant.tokens = event.properties.tokens
            if (event.properties.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.properties.snapshot }
          })
          scheduleSync(event.properties.sessionID, 50)
          break
        case "session.next.step.failed":
          update(event.properties.sessionID, (draft) => {
            const currentAssistant = activeAssistant(draft)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.properties.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.properties.error
          })
          scheduleSync(event.properties.sessionID, 50)
          break
        case "session.next.text.started":
          update(event.properties.sessionID, (draft) => {
            activeAssistant(draft)?.content.push({ type: "text", text: "" })
          })
          break
        case "session.next.text.delta":
          update(event.properties.sessionID, (draft) => {
            const match = latestText(activeAssistant(draft))
            if (match) match.text = previewText(match.text + event.properties.delta)
          })
          break
        case "session.next.text.ended":
          update(event.properties.sessionID, (draft) => {
            const match = latestText(activeAssistant(draft))
            if (match) match.text = previewText(event.properties.text)
          })
          break
        case "session.next.tool.input.started":
          update(event.properties.sessionID, (draft) => {
            activeAssistant(draft)?.content.push({
              type: "tool",
              id: event.properties.callID,
              name: event.properties.name,
              time: { created: event.properties.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(activeAssistant(draft), event.properties.callID)
            if (match?.state.status === "pending") match.state.input += event.properties.delta
          })
          break
        case "session.next.tool.input.ended":
          break
        case "session.next.tool.called":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(activeAssistant(draft), event.properties.callID)
            if (!match) return
            match.time.ran = event.properties.timestamp
            match.provider = event.properties.provider
            match.state = { status: "running", input: event.properties.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(activeAssistant(draft), event.properties.callID)
            if (match?.state.status !== "running") return
            match.state.structured = event.properties.structured
            match.state.content = previewToolContent([...event.properties.content])
          })
          break
        case "session.next.tool.success":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(activeAssistant(draft), event.properties.callID)
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.properties.structured,
              content: previewToolContent([...event.properties.content]),
            }
            match.provider = event.properties.provider
            match.time.completed = event.properties.timestamp
          })
          scheduleSync(event.properties.sessionID, 50)
          break
        case "session.next.tool.failed":
          update(event.properties.sessionID, (draft) => {
            const match = latestTool(activeAssistant(draft), event.properties.callID)
            if (match?.state.status !== "running") return
            match.state = {
              status: "error",
              error: event.properties.error,
              input: match.state.input,
              structured: match.state.structured,
              content: match.state.content,
            }
            match.provider = event.properties.provider
            match.time.completed = event.properties.timestamp
          })
          scheduleSync(event.properties.sessionID, 50)
          break
        case "session.next.reasoning.started":
          update(event.properties.sessionID, (draft) => {
            activeAssistant(draft)?.content.push({
              type: "reasoning",
              id: event.properties.reasoningID,
              text: "",
            })
          })
          break
        case "session.next.reasoning.delta":
          update(event.properties.sessionID, (draft) => {
            const match = latestReasoning(activeAssistant(draft), event.properties.reasoningID)
            if (match) match.text = previewText(match.text + event.properties.delta)
          })
          break
        case "session.next.reasoning.ended":
          update(event.properties.sessionID, (draft) => {
            const match = latestReasoning(activeAssistant(draft), event.properties.reasoningID)
            if (match) match.text = previewText(event.properties.text)
          })
          break
        case "session.next.retried":
          break
        case "session.next.compaction.started":
          update(event.properties.sessionID, (draft) => {
            draft.unshift({
              id: event.id,
              type: "compaction",
              reason: event.properties.reason,
              summary: "",
              time: { created: event.properties.timestamp },
            })
          })
          break
        case "session.next.compaction.delta":
          update(event.properties.sessionID, (draft) => {
            const match = activeCompaction(draft)
            if (match) match.summary = previewText(match.summary + event.properties.text)
          })
          break
        case "session.next.compaction.ended":
          update(event.properties.sessionID, (draft) => {
            const match = activeCompaction(draft)
            if (!match) return
            match.summary = previewText(event.properties.text)
            match.include = event.properties.include ? previewText(event.properties.include) : event.properties.include
          })
          scheduleSync(event.properties.sessionID, 50)
          break
      }
    })

    const unsubscribeConnection = sdk.event.on("event", (event) => {
      const type = event.payload.type
      if (type === "server.connected" || (type === "server.heartbeat" && sdk.connection.recoveringSince))
        scheduleKnownSessionSync(0)
    })

    const result = {
      data: store,
      session: {
        message: {
          async sync(sessionID: string) {
            await syncMessages(sessionID, { force: true })
          },
          fromSession(sessionID: string) {
            const messages = store.messages[sessionID]
            if (!messages) return []
            return messages
          },
        },
      },
    }

    onCleanup(() => {
      unsubscribeConnection()
      for (const timer of syncTimers.values()) clearTimeout(timer)
      syncTimers.clear()
    })

    return result
  },
})

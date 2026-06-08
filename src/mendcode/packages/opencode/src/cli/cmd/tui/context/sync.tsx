import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  PlanReviewRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@mendcode/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@mendcode/core/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import * as Log from "@mendcode/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import path from "path"
import { useKV } from "./kv"

const LIVE_SHELL_OUTPUT_PREVIEW_LIMIT = 30_000

function appendLiveShellOutput(current: unknown, delta: string) {
  const next = String(current ?? "") + delta
  if (next.length <= LIVE_SHELL_OUTPUT_PREVIEW_LIMIT) return next
  return "...\n\n" + next.slice(-LIVE_SHELL_OUTPUT_PREVIEW_LIMIT)
}

type ShellOutputEvent = {
  type: "session.next.shell.output"
  properties: {
    sessionID: string
    callID: string
    delta: string
  }
}

function preserveAppendOnlyPartText(current: Part, incoming: Part): Part {
  if (current.type !== incoming.type) return incoming
  if (current.type !== "text" && current.type !== "reasoning") return incoming
  if (incoming.type !== "text" && incoming.type !== "reasoning") return incoming

  const currentText = current.text
  const incomingText = incoming.text
  if (currentText.length > incomingText.length && currentText.startsWith(incomingText)) {
    return { ...incoming, text: currentText } as Part
  }

  return incoming
}

function mergeFetchedParts(current: Part[] | undefined, incoming: Part[]) {
  if (!current?.length) return incoming

  const currentByID = new Map(current.map((part) => [part.id, part]))
  const seen = new Set<string>()
  const merged = incoming.map((part) => {
    seen.add(part.id)
    const existing = currentByID.get(part.id)
    return existing ? preserveAppendOnlyPartText(existing, part) : part
  })

  for (const part of current) {
    if (seen.has(part.id)) continue
    if ((part.type === "text" || part.type === "reasoning") && part.time.end === undefined) {
      merged.push(part)
    }
  }

  return merged.toSorted((a, b) => a.id.localeCompare(b.id))
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      plan_review: {
        [sessionID: string]: PlanReviewRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      plan_review: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()

    const fullSyncedSessions = new Set<string>()
    let syncedWorkspace = project.workspace.current()
    let pendingInputRefreshTimer: Timer | undefined

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    function groupBySession<T extends { sessionID: string }>(items: ReadonlyArray<T>) {
      const grouped: Record<string, T[]> = {}
      for (const item of items) {
        grouped[item.sessionID] ??= []
        grouped[item.sessionID].push(item)
      }
      return grouped
    }

    async function refreshPendingInput() {
      const workspace = project.workspace.current()
      const [permissions, questions, planReviews] = await Promise.allSettled([
        sdk.client.permission.list({ workspace }),
        sdk.client.question.list({ workspace }),
        sdk.client.planReview.list({ workspace }),
      ])
      batch(() => {
        if (permissions.status === "fulfilled")
          setStore("permission", reconcile(groupBySession(permissions.value.data ?? [])))
        if (questions.status === "fulfilled")
          setStore("question", reconcile(groupBySession(questions.value.data ?? [])))
        if (planReviews.status === "fulfilled")
          setStore("plan_review", reconcile(groupBySession(planReviews.value.data ?? [])))
      })
    }

    function schedulePendingInputRefresh() {
      if (pendingInputRefreshTimer) clearTimeout(pendingInputRefreshTimer)
      pendingInputRefreshTimer = setTimeout(() => {
        pendingInputRefreshTimer = undefined
        void refreshPendingInput().catch(() => undefined)
      }, 25)
    }

    event.subscribe((event) => {
      const shellOutputEvent = event as typeof event | ShellOutputEvent
      if (shellOutputEvent.type === "session.next.shell.output") {
        const messages = store.message[shellOutputEvent.properties.sessionID] ?? []
        for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
          const message = messages[messageIndex]
          const parts = store.part[message.id]
          if (!parts) continue
          const partIndex = parts.findIndex(
            (part) => part.type === "tool" && part.callID === shellOutputEvent.properties.callID,
          )
          if (partIndex < 0) continue
          setStore(
            "part",
            message.id,
            partIndex,
            produce((part) => {
              if (part.type !== "tool" || part.state.status !== "running") return
              part.state.metadata = {
                ...(part.state.metadata ?? {}),
                output: appendLiveShellOutput(part.state.metadata?.output, shellOutputEvent.properties.delta),
              }
            }),
          )
          break
        }
        return
      }

      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) {
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) {
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) {
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) {
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "plan_review.replied": {
          const requests = store.plan_review[event.properties.sessionID]
          if (!requests) {
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) {
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "plan_review",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "plan_review.asked": {
          const request = event.properties
          const requests = store.plan_review[request.sessionID]
          if (!requests) {
            setStore("plan_review", request.sessionID, [request])
            schedulePendingInputRefresh()
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("plan_review", request.sessionID, match.index, reconcile(request))
            schedulePendingInputRefresh()
            break
          }
          setStore(
            "plan_review",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          schedulePendingInputRefresh()
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            const next = preserveAppendOnlyPartText(parts[result.index], event.properties.part)
            setStore("part", event.properties.part.messageID, result.index, reconcile(next))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      if (workspace !== syncedWorkspace) {
        fullSyncedSessions.clear()
        syncedWorkspace = workspace
      }
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            refreshPendingInput(),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            await exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.OPENCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, options?: { force?: boolean }) {
          if (!options?.force && fullSyncedSessions.has(sessionID)) return
          const workspace = project.workspace.current()
          const [session, messages, todo, diff, statuses] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
            sdk.client.session.status({ workspace }),
          ])
          batch(() => {
            setStore(
              "session",
              produce((draft) => {
                const match = Binary.search(draft, sessionID, (s) => s.id)
                if (match.found) draft[match.index] = session.data!
                if (!match.found) draft.splice(match.index, 0, session.data!)
              }),
            )
            setStore("todo", sessionID, reconcile(todo.data ?? []))
            setStore("message", sessionID, reconcile(messages.data!.map((x) => x.info)))
            for (const message of messages.data!) {
              setStore("part", message.info.id, reconcile(mergeFetchedParts(store.part[message.info.id], message.parts)))
            }
            setStore("session_diff", sessionID, reconcile(diff.data ?? []))
            setStore("session_status", reconcile(statuses.data ?? {}))
          })
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})

import path from "path"
import { Global } from "@mendcode/core/global"
import { Filesystem } from "@/util/filesystem"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { appendFile, writeFile } from "fs/promises"
import type { AgentPart, FilePart, TextPart } from "@mendcode/sdk/v2"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export type PromptHistoryScope = string

export type PromptHistoryRecord = {
  scope?: PromptHistoryScope
  prompt: PromptInfo
}

const MAX_HISTORY_ENTRIES = 50
const GLOBAL_SCOPE_KEY = "__global__"

function isPromptInfo(value: unknown): value is PromptInfo {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<PromptInfo>
  return typeof item.input === "string" && Array.isArray(item.parts)
}

export function promptHistoryRecordFromUnknown(value: unknown): PromptHistoryRecord | undefined {
  if (!value || typeof value !== "object") return
  const item = value as { scope?: unknown; prompt?: unknown }
  if (isPromptInfo(item.prompt)) {
    return {
      scope: typeof item.scope === "string" && item.scope.length > 0 ? item.scope : undefined,
      prompt: item.prompt,
    }
  }
  if (isPromptInfo(value)) return { prompt: value }
}

export function promptHistoryRecordsForScope(records: readonly PromptHistoryRecord[], scope?: PromptHistoryScope) {
  return records.filter((record) => (scope ? record.scope === scope : !record.scope))
}

function historyScopeKey(scope?: PromptHistoryScope) {
  return scope || GLOBAL_SCOPE_KEY
}

function serializeHistoryRecord(record: PromptHistoryRecord) {
  if (!record.scope) return JSON.stringify(record.prompt)
  return JSON.stringify(record)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const historyPath = path.join(Global.Path.state, "prompt-history.jsonl")
    onMount(async () => {
      const text = await Filesystem.readText(historyPath).catch(() => "")
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return promptHistoryRecordFromUnknown(JSON.parse(line))
          } catch {
            return undefined
          }
        })
        .filter((line): line is PromptHistoryRecord => line !== undefined)
        .slice(-MAX_HISTORY_ENTRIES)

      setStore("history", lines)

      // Rewrite file with only valid entries to self-heal corruption
      if (lines.length > 0) {
        const content = lines.map(serializeHistoryRecord).join("\n") + "\n"
        writeFile(historyPath, content).catch(() => {})
      }
    })

    const [store, setStore] = createStore({
      indexByScope: {} as Record<string, number>,
      history: [] as PromptHistoryRecord[],
    })

    return {
      move(direction: 1 | -1, input: string, scope?: PromptHistoryScope) {
        const scopeKey = historyScopeKey(scope)
        const scoped = promptHistoryRecordsForScope(store.history, scope)
        if (!scoped.length) return undefined
        const index = store.indexByScope[scopeKey] ?? 0
        const current = scoped.at(index)?.prompt
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const currentIndex = draft.indexByScope[scopeKey] ?? 0
            const next = currentIndex + direction
            if (Math.abs(next) > scoped.length) return
            if (next > 0) return
            draft.indexByScope[scopeKey] = next
          }),
        )
        const nextIndex = store.indexByScope[scopeKey] ?? 0
        if (nextIndex === 0)
          return {
            input: "",
            parts: [],
          }
        return scoped.at(nextIndex)?.prompt
      },
      append(item: PromptInfo, scope?: PromptHistoryScope) {
        const entry = {
          scope,
          prompt: structuredClone(unwrap(item)),
        }
        const scopeKey = historyScopeKey(scope)
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.indexByScope[scopeKey] = 0
          }),
        )

        if (trimmed) {
          const content = store.history.map(serializeHistoryRecord).join("\n") + "\n"
          writeFile(historyPath, content).catch(() => {})
          return
        }

        appendFile(historyPath, serializeHistoryRecord(entry) + "\n").catch(() => {})
      },
    }
  },
})

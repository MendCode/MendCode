import { Locale } from "@/util/locale"
import { Database } from "@/storage/db"
import { SessionID } from "./schema"
import { MessageTable, PartTable } from "./session.sql"
import { and, gte, inArray, lte, sql } from "drizzle-orm"

type TokenBucket = {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export type InsightSession = {
  id: string
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  summary?: {
    files?: number
    additions?: number
    deletions?: number
  }
  time: {
    created: number
    updated: number
  }
}

export type InsightMessage = {
  info: {
    id: string
    role: "user" | "assistant"
    agent?: string
    modelID?: string
    providerID?: string
    cost?: number
    tokens?: TokenBucket
    time: {
      created: number
      completed?: number
    }
  }
  parts: Array<{
    type: string
    text?: string
    tool?: string
    name?: string
    state?: {
      status?: string
      time?: {
        start?: number
        end?: number
      }
    }
  }>
}

export type SessionInsightInput = {
  session: InsightSession
  messages: InsightMessage[]
}

export type DailyUsage = {
  day: string
  time: number
  sessions: number
  messages: number
  userMessages: number
  userWords: number
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheTokens: number
  cost: number
  aiResponseMs: number
  toolMs: number
  changedFiles: number
}

export type UsageInsights = {
  days: DailyUsage[]
  totals: {
    sessions: number
    messages: number
    userMessages: number
    userWords: number
    tokens: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheTokens: number
    cost: number
    aiResponseMs: number
    toolMs: number
    changedFiles: number
    activeDays: number
    currentStreak: number
    longestStreak: number
    peakTokens: number
    longestTaskMs: number
    sessionsWithCodeChanges: number
  }
  topTools: Array<{ name: string; count: number }>
  topAgents: Array<{ name: string; count: number }>
  topModels: Array<{ name: string; count: number; tokens: number; cost: number }>
}

let databaseCache:
  | {
      key: string
      updated: number
      data: UsageInsights
    }
  | undefined

const DATABASE_SESSION_BATCH_SIZE = 50
const DATABASE_MESSAGE_ID_BATCH_SIZE = 5_000
const DATABASE_CACHE_TTL_MS = 60_000

export function buildUsageInsightsFromDatabase(input: {
  sessions: InsightSession[]
  start: number
  end?: number
  messageLimit?: number
}) {
  const start = startOfLocalDay(input.start)
  const end = startOfLocalDay(input.end ?? Date.now())
  const messageLimit = Math.max(1, Math.min(500, input.messageLimit ?? 500))
  if (input.sessions.length === 0) return buildUsageInsights([], { start, end })
  const cacheKey = `${start}:${end}:${messageLimit}:${input.sessions.map((session) => `${session.id}:${session.time.updated}:${session.agent ?? ""}:${session.summary?.files ?? 0}`).join(",")}`
  if (databaseCache?.key === cacheKey && Date.now() - databaseCache.updated < DATABASE_CACHE_TTL_MS)
    return databaseCache.data
  const partType = sql<string>`json_extract(${PartTable.data}, '$.type')`
  const messageRole = sql<string>`json_extract(${MessageTable.data}, '$.role')`
  let data: UsageInsights | undefined

  for (let offset = 0; offset < input.sessions.length; offset += DATABASE_SESSION_BATCH_SIZE) {
    const sessions = input.sessions.slice(offset, offset + DATABASE_SESSION_BATCH_SIZE)
    const sessionIDs = sessions.map((session) => SessionID.make(session.id))
    const messages = Database.use((db) => {
      const ranked = db
        .select({
          id: MessageTable.id,
          sessionID: MessageTable.session_id,
          created: MessageTable.time_created,
          role: sql<string>`json_extract(${MessageTable.data}, '$.role')`.as("role"),
          agent: sql<string | null>`json_extract(${MessageTable.data}, '$.agent')`.as("agent"),
          modelID: sql<string | null>`json_extract(${MessageTable.data}, '$.modelID')`.as("model_id"),
          providerID: sql<string | null>`json_extract(${MessageTable.data}, '$.providerID')`.as("provider_id"),
          cost: sql<number | null>`json_extract(${MessageTable.data}, '$.cost')`.as("cost"),
          completed: sql<number | null>`json_extract(${MessageTable.data}, '$.time.completed')`.as("completed"),
          total: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.total')`.as("total_tokens"),
          input: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.input')`.as("input_tokens"),
          output: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.output')`.as("output_tokens"),
          reasoning: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.reasoning')`.as("reasoning_tokens"),
          cacheRead: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.read')`.as("cache_read"),
          cacheWrite: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.write')`.as("cache_write"),
          rank: sql<number>`row_number() over (partition by ${MessageTable.session_id} order by ${MessageTable.time_created} desc, ${MessageTable.id} desc)`.as(
            "rank",
          ),
        })
        .from(MessageTable)
        .where(
          and(
            inArray(MessageTable.session_id, sessionIDs),
            gte(MessageTable.time_created, start),
            sql`${messageRole} in ('user', 'assistant')`,
          ),
        )
        .as("ranked_usage_messages")
      return db.select().from(ranked).where(lte(ranked.rank, messageLimit)).all()
    })
    const byMessage = new Map<string, InsightMessage["parts"]>()
    for (let offset = 0; offset < messages.length; offset += DATABASE_MESSAGE_ID_BATCH_SIZE) {
      const messageIDs = messages.slice(offset, offset + DATABASE_MESSAGE_ID_BATCH_SIZE).map((message) => message.id)
      const parts = Database.use((db) =>
        db
          .select({
            messageID: PartTable.message_id,
            type: partType,
            text: sql<string | null>`json_extract(${PartTable.data}, '$.text')`,
            tool: sql<string | null>`json_extract(${PartTable.data}, '$.tool')`,
            name: sql<string | null>`json_extract(${PartTable.data}, '$.name')`,
            status: sql<string | null>`json_extract(${PartTable.data}, '$.state.status')`,
            start: sql<number | null>`json_extract(${PartTable.data}, '$.state.time.start')`,
            end: sql<number | null>`json_extract(${PartTable.data}, '$.state.time.end')`,
          })
          .from(PartTable)
          .innerJoin(MessageTable, sql`${MessageTable.id} = ${PartTable.message_id}`)
          .where(
            and(
              inArray(PartTable.message_id, messageIDs),
              sql`(${partType} in ('tool', 'agent') or (${partType} = 'text' and ${messageRole} = 'user'))`,
            ),
          )
          .all(),
      )
      for (const part of parts) {
        const items = byMessage.get(part.messageID) ?? []
        items.push({
          type: part.type,
          ...(part.text === null ? {} : { text: part.text }),
          ...(part.tool === null ? {} : { tool: part.tool }),
          ...(part.name === null ? {} : { name: part.name }),
          ...(part.status === null && part.start === null && part.end === null
            ? {}
            : {
                state: {
                  ...(part.status === null ? {} : { status: part.status }),
                  ...(part.start === null && part.end === null
                    ? {}
                    : {
                        time: {
                          ...(part.start === null ? {} : { start: part.start }),
                          ...(part.end === null ? {} : { end: part.end }),
                        },
                      }),
                },
              }),
        })
        byMessage.set(part.messageID, items)
      }
    }
    const bySession = new Map(
      sessions.map((session) => [session.id, { session, messages: [] as InsightMessage[] }]),
    )
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue
      bySession.get(message.sessionID)?.messages.push({
        info: {
          id: message.id,
          role: message.role,
          ...(message.agent === null ? {} : { agent: message.agent }),
          ...(message.modelID === null ? {} : { modelID: message.modelID }),
          ...(message.providerID === null ? {} : { providerID: message.providerID }),
          ...(message.cost === null ? {} : { cost: message.cost }),
          tokens: {
            ...(message.total === null ? {} : { total: message.total }),
            input: message.input ?? 0,
            output: message.output ?? 0,
            reasoning: message.reasoning ?? 0,
            cache: { read: message.cacheRead ?? 0, write: message.cacheWrite ?? 0 },
          },
          time: { created: message.created, ...(message.completed === null ? {} : { completed: message.completed }) },
        },
        parts: byMessage.get(message.id) ?? [],
      })
    }
    data = mergeUsageInsights(
      data,
      buildUsageInsights([...bySession.values()], { start, end, topLimit: Number.MAX_SAFE_INTEGER }),
      Number.MAX_SAFE_INTEGER,
    )
  }

  const result = data
    ? {
        ...data,
        topTools: data.topTools.slice(0, 8),
        topAgents: data.topAgents.slice(0, 8),
        topModels: data.topModels.slice(0, 8),
      }
    : buildUsageInsights([], { start, end })
  databaseCache = { key: cacheKey, updated: Date.now(), data: result }
  return result
}

function startOfLocalDay(input: number) {
  const date = new Date(input)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayKey(input: number) {
  const date = new Date(startOfLocalDay(input))
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function safe(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function tokenTotal(tokens: TokenBucket | undefined) {
  if (typeof tokens?.total === "number" && Number.isFinite(tokens.total)) return tokens.total
  return (
    safe(tokens?.input) +
    safe(tokens?.output) +
    safe(tokens?.reasoning) +
    safe(tokens?.cache?.read) +
    safe(tokens?.cache?.write)
  )
}

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function messageText(message: InsightMessage) {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function increment(map: Map<string, number>, key: string | undefined, count = 1) {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + count)
}

function topCounts(map: Map<string, number>, limit: number) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

function streak(days: DailyUsage[]) {
  const active = new Set(days.filter((day) => day.tokens > 0 || day.userMessages > 0).map((day) => day.day))
  let current = 0
  let longest = 0
  let run = 0

  for (const day of days) {
    if (active.has(day.day)) {
      run++
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
  }

  for (let index = days.length - 1; index >= 0; index--) {
    const day = days[index]
    if (!day || !active.has(day.day)) break
    current++
  }

  return { current, longest, activeDays: active.size }
}

function mergeUsageInsights(left: UsageInsights | undefined, right: UsageInsights, topLimit = 8): UsageInsights {
  if (!left) return right

  const days = left.days.map((day, index) => {
    const next = right.days[index]
    if (!next || next.day !== day.day) return day
    return {
      ...day,
      sessions: day.sessions + next.sessions,
      messages: day.messages + next.messages,
      userMessages: day.userMessages + next.userMessages,
      userWords: day.userWords + next.userWords,
      tokens: day.tokens + next.tokens,
      inputTokens: day.inputTokens + next.inputTokens,
      outputTokens: day.outputTokens + next.outputTokens,
      reasoningTokens: day.reasoningTokens + next.reasoningTokens,
      cacheTokens: day.cacheTokens + next.cacheTokens,
      cost: day.cost + next.cost,
      aiResponseMs: day.aiResponseMs + next.aiResponseMs,
      toolMs: day.toolMs + next.toolMs,
      changedFiles: day.changedFiles + next.changedFiles,
    }
  })
  const streaks = streak(days)

  return {
    days,
    totals: {
      sessions: left.totals.sessions + right.totals.sessions,
      messages: left.totals.messages + right.totals.messages,
      userMessages: left.totals.userMessages + right.totals.userMessages,
      userWords: left.totals.userWords + right.totals.userWords,
      tokens: left.totals.tokens + right.totals.tokens,
      inputTokens: left.totals.inputTokens + right.totals.inputTokens,
      outputTokens: left.totals.outputTokens + right.totals.outputTokens,
      reasoningTokens: left.totals.reasoningTokens + right.totals.reasoningTokens,
      cacheTokens: left.totals.cacheTokens + right.totals.cacheTokens,
      cost: left.totals.cost + right.totals.cost,
      aiResponseMs: left.totals.aiResponseMs + right.totals.aiResponseMs,
      toolMs: left.totals.toolMs + right.totals.toolMs,
      changedFiles: left.totals.changedFiles + right.totals.changedFiles,
      activeDays: streaks.activeDays,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      peakTokens: Math.max(left.totals.peakTokens, right.totals.peakTokens),
      longestTaskMs: Math.max(left.totals.longestTaskMs, right.totals.longestTaskMs),
      sessionsWithCodeChanges: left.totals.sessionsWithCodeChanges + right.totals.sessionsWithCodeChanges,
    },
    topTools: mergeTopCounts(left.topTools, right.topTools, topLimit),
    topAgents: mergeTopCounts(left.topAgents, right.topAgents, topLimit),
    topModels: mergeTopModels(left.topModels, right.topModels, topLimit),
  }
}

function mergeTopCounts(
  left: Array<{ name: string; count: number }>,
  right: Array<{ name: string; count: number }>,
  limit: number,
) {
  const counts = new Map<string, number>()
  for (const item of [...left, ...right]) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  return topCounts(counts, limit)
}

function mergeTopModels(
  left: Array<{ name: string; count: number; tokens: number; cost: number }>,
  right: Array<{ name: string; count: number; tokens: number; cost: number }>,
  limit: number,
) {
  const models = new Map<string, { count: number; tokens: number; cost: number }>()
  for (const item of [...left, ...right]) {
    const current = models.get(item.name) ?? { count: 0, tokens: 0, cost: 0 }
    current.count += item.count
    current.tokens += item.tokens
    current.cost += item.cost
    models.set(item.name, current)
  }
  return [...models.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, value]) => ({ name, count: value.count, tokens: value.tokens, cost: value.cost }))
}

export function buildUsageInsights(
  input: SessionInsightInput[],
  options: { start?: number; end?: number; topLimit?: number } = {},
) {
  const end = startOfLocalDay(options.end ?? Date.now())
  const oldestSession = input.reduce((min, item) => Math.min(min, item.session.time.created), end)
  const start = startOfLocalDay(options.start ?? oldestSession)
  const days: DailyUsage[] = []
  const byDay = new Map<string, DailyUsage>()
  const seenSessionDay = new Set<string>()
  const tools = new Map<string, number>()
  const agents = new Map<string, number>()
  const models = new Map<string, { count: number; tokens: number; cost: number }>()

  for (let time = start; time <= end; time += 24 * 60 * 60 * 1000) {
    const day: DailyUsage = {
      day: dayKey(time),
      time,
      sessions: 0,
      messages: 0,
      userMessages: 0,
      userWords: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      cost: 0,
      aiResponseMs: 0,
      toolMs: 0,
      changedFiles: 0,
    }
    days.push(day)
    byDay.set(day.day, day)
  }

  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cacheTokens = 0
  let longestTaskMs = 0
  let sessionsWithCodeChanges = 0

  for (const item of input) {
    const sessionChangedFiles = safe(item.session.summary?.files)
    if (sessionChangedFiles > 0) sessionsWithCodeChanges++
    increment(agents, item.session.agent)

    for (const message of item.messages) {
      const day = byDay.get(dayKey(message.info.time.created))
      if (!day) continue

      const sessionDayKey = `${item.session.id}:${day.day}`
      if (!seenSessionDay.has(sessionDayKey)) {
        seenSessionDay.add(sessionDayKey)
        day.sessions++
      }
      day.messages++

      if (message.info.role === "user") {
        day.userMessages++
        day.userWords += wordCount(messageText(message))
        increment(agents, message.info.agent)
      }

      if (message.info.role === "assistant") {
        const tokens = message.info.tokens
        const messageTokens = tokenTotal(tokens)
        const cost = safe(message.info.cost)
        const responseMs = message.info.time.completed
          ? Math.max(0, message.info.time.completed - message.info.time.created)
          : 0
        const modelName =
          message.info.providerID && message.info.modelID
            ? `${message.info.providerID}/${message.info.modelID}`
            : undefined

        day.tokens += messageTokens
        day.inputTokens += safe(tokens?.input)
        day.outputTokens += safe(tokens?.output)
        day.reasoningTokens += safe(tokens?.reasoning)
        day.cacheTokens += safe(tokens?.cache?.read) + safe(tokens?.cache?.write)
        day.cost += cost
        day.aiResponseMs += responseMs
        inputTokens += safe(tokens?.input)
        outputTokens += safe(tokens?.output)
        reasoningTokens += safe(tokens?.reasoning)
        cacheTokens += safe(tokens?.cache?.read) + safe(tokens?.cache?.write)
        longestTaskMs = Math.max(longestTaskMs, responseMs)
        increment(agents, message.info.agent)
        if (modelName) {
          const current = models.get(modelName) ?? { count: 0, tokens: 0, cost: 0 }
          current.count++
          current.tokens += messageTokens
          current.cost += cost
          models.set(modelName, current)
        }
      }

      for (const part of message.parts) {
        if (part.type === "tool") {
          increment(tools, part.tool)
          const start = part.state?.time?.start
          const end = part.state?.time?.end
          if (start && end && end >= start) day.toolMs += end - start
        } else if (part.type === "agent") {
          increment(agents, part.name)
        }
      }
    }

    const sessionDay = byDay.get(dayKey(item.session.time.updated))
    if (sessionDay) sessionDay.changedFiles += sessionChangedFiles
  }

  const streaks = streak(days)
  const total = days.reduce(
    (sum, day) => {
      sum.sessions += day.sessions
      sum.messages += day.messages
      sum.userMessages += day.userMessages
      sum.userWords += day.userWords
      sum.tokens += day.tokens
      sum.cost += day.cost
      sum.aiResponseMs += day.aiResponseMs
      sum.toolMs += day.toolMs
      sum.changedFiles += day.changedFiles
      sum.peakTokens = Math.max(sum.peakTokens, day.tokens)
      return sum
    },
    {
      sessions: 0,
      messages: 0,
      userMessages: 0,
      userWords: 0,
      tokens: 0,
      cost: 0,
      aiResponseMs: 0,
      toolMs: 0,
      changedFiles: 0,
      peakTokens: 0,
    },
  )

  return {
    days,
    totals: {
      ...total,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheTokens,
      activeDays: streaks.activeDays,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      longestTaskMs,
      sessionsWithCodeChanges,
    },
    topTools: topCounts(tools, options.topLimit ?? 8),
    topAgents: topCounts(agents, options.topLimit ?? 8),
    topModels: [...models.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
      .slice(0, options.topLimit ?? 8)
      .map(([name, value]) => ({ name, count: value.count, tokens: value.tokens, cost: value.cost })),
  } satisfies UsageInsights
}

export function normalizeUsageInsights(input: UsageInsights | undefined) {
  if (!input) return undefined
  return {
    ...input,
    days: input.days.map((day) => ({
      ...day,
      sessions: safe(day.sessions),
      messages: safe(day.messages),
      userMessages: safe(day.userMessages),
      userWords: safe(day.userWords),
      tokens: safe(day.tokens),
      inputTokens: safe(day.inputTokens),
      outputTokens: safe(day.outputTokens),
      reasoningTokens: safe(day.reasoningTokens),
      cacheTokens: safe(day.cacheTokens),
      cost: safe(day.cost),
      aiResponseMs: safe(day.aiResponseMs),
      toolMs: safe(day.toolMs),
      changedFiles: safe(day.changedFiles),
    })),
    totals: {
      ...input.totals,
      sessions: safe(input.totals.sessions),
      messages: safe(input.totals.messages),
      userMessages: safe(input.totals.userMessages),
      userWords: safe(input.totals.userWords),
      tokens: safe(input.totals.tokens),
      inputTokens: safe(input.totals.inputTokens),
      outputTokens: safe(input.totals.outputTokens),
      reasoningTokens: safe(input.totals.reasoningTokens),
      cacheTokens: safe(input.totals.cacheTokens),
      cost: safe(input.totals.cost),
      aiResponseMs: safe(input.totals.aiResponseMs),
      toolMs: safe(input.totals.toolMs),
      changedFiles: safe(input.totals.changedFiles),
      activeDays: safe(input.totals.activeDays),
      currentStreak: safe(input.totals.currentStreak),
      longestStreak: safe(input.totals.longestStreak),
      peakTokens: safe(input.totals.peakTokens),
      longestTaskMs: safe(input.totals.longestTaskMs),
      sessionsWithCodeChanges: safe(input.totals.sessionsWithCodeChanges),
    },
  } satisfies UsageInsights
}

export function formatInsightDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 24 * 60 * 60 * 1000) return Locale.duration(ms)
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

export function formatInsightNumber(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0
  const absolute = Math.abs(safeValue)
  const compact = (divisor: number, suffix: string) =>
    `${(Math.trunc((safeValue / divisor) * 10) / 10).toFixed(1)}${suffix}`

  if (absolute >= 1_000_000_000) return compact(1_000_000_000, "B")
  if (absolute >= 1_000_000) return compact(1_000_000, "M")
  if (absolute >= 1_000) return compact(1_000, "K")
  return safeValue.toString()
}

export function formatMoney(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

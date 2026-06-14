import { Locale } from "@/util/locale"

type TokenBucket = {
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
    if (!active.has(days[index].day)) break
    current++
  }

  return { current, longest, activeDays: active.size }
}

export function buildUsageInsights(input: SessionInsightInput[], options: { start?: number; end?: number } = {}) {
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
    topTools: topCounts(tools, 8),
    topAgents: topCounts(agents, 8),
    topModels: [...models.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name, value]) => ({ name, count: value.count, tokens: value.tokens, cost: value.cost })),
  } satisfies UsageInsights
}

export function formatInsightDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 24 * 60 * 60 * 1000) return Locale.duration(ms)
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

export function formatMoney(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

import os from "os"
import path from "path"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Auth } from "@/auth"
import type { Provider } from "./provider"
import { ModelID, ProviderID } from "./schema"

export const ID = ProviderID.make("claude-code")
export const NPM = "mendcode/claude-code"
export const AUTH_KEY = "__mendcode_claude_code__"

export type Settings = {
  binaryPath: string
  homePath: string
  launchArgs: string
  workingDirectory: string
}

type ClaudeQueryFactory = typeof query

type CreateOptions = Partial<Settings> & {
  createQuery?: ClaudeQueryFactory
}

const DEFAULT_SETTINGS: Settings = {
  binaryPath: "claude",
  homePath: "",
  launchArgs: "",
  workingDirectory: "",
}

const usage = (raw?: Record<string, unknown>): LanguageModelV3Usage => ({
  inputTokens: {
    total: numberOrUndefined(raw?.input_tokens ?? raw?.inputTokens),
    noCache: undefined,
    cacheRead: numberOrUndefined(raw?.cache_read_input_tokens ?? raw?.cacheReadInputTokens),
    cacheWrite: numberOrUndefined(raw?.cache_creation_input_tokens ?? raw?.cacheCreationInputTokens),
  },
  outputTokens: {
    total: numberOrUndefined(raw?.output_tokens ?? raw?.outputTokens),
    text: undefined,
    reasoning: undefined,
  },
  raw: raw as any,
})

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeSettings(input?: Partial<Settings>): Settings {
  return {
    binaryPath: input?.binaryPath?.trim() || DEFAULT_SETTINGS.binaryPath,
    homePath: input?.homePath?.trim() || DEFAULT_SETTINGS.homePath,
    launchArgs: input?.launchArgs?.trim() || DEFAULT_SETTINGS.launchArgs,
    workingDirectory: input?.workingDirectory?.trim() || DEFAULT_SETTINGS.workingDirectory,
  }
}

function stringOption(input: Record<string, unknown> | undefined, key: keyof Settings) {
  const value = input?.[key]
  return typeof value === "string" ? value : undefined
}

export function settingsFromInputs(input?: Record<string, string>): Settings {
  return normalizeSettings({
    binaryPath: input?.binaryPath,
    homePath: input?.homePath,
    launchArgs: input?.launchArgs,
  })
}

export function settingsFromAuth(auth?: Auth.Info): Settings {
  if (auth?.type !== "api") return DEFAULT_SETTINGS
  return normalizeSettings({
    binaryPath: auth.metadata?.binaryPath,
    homePath: auth.metadata?.homePath,
    launchArgs: auth.metadata?.launchArgs,
  })
}

export function settingsFromConfig(input?: Record<string, unknown>, fallback?: Partial<Settings>): Settings {
  return normalizeSettings({
    ...fallback,
    binaryPath: stringOption(input, "binaryPath") ?? fallback?.binaryPath,
    homePath: stringOption(input, "homePath") ?? fallback?.homePath,
    launchArgs: stringOption(input, "launchArgs") ?? fallback?.launchArgs,
  })
}

export function metadata(settings: Partial<Settings>): Record<string, string> {
  const normalized = normalizeSettings(settings)
  return {
    binaryPath: normalized.binaryPath,
    homePath: normalized.homePath,
    launchArgs: normalized.launchArgs,
  }
}

const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169"
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154"
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111"

function parseVersion(input?: string) {
  return input?.match(/\d+\.\d+\.\d+/)?.[0]
}

function compareSemver(a: string, b: string) {
  const left = a.split(".").map((part) => Number(part) || 0)
  const right = b.split(".").map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function supportsVersion(version: string | undefined, minimum: string) {
  return version ? compareSemver(version, minimum) >= 0 : true
}

export function providerInfo(settings: Settings = DEFAULT_SETTINGS, versionOutput?: string): Provider.Info {
  const version = parseVersion(versionOutput)
  const model = (id: string, name: string, family: string, reasoning = true): Provider.Model => ({
    id: ModelID.make(id),
    providerID: ID,
    name,
    family,
    api: {
      id,
      npm: NPM,
      url: "",
    },
    status: "active",
    headers: {},
    options: {},
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 200_000,
      output: 64_000,
    },
    capabilities: {
      temperature: false,
      reasoning,
      attachment: false,
      toolcall: false,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  })

  const models: Record<string, Provider.Model> = {}
  const addModel = (id: string, name: string, family: string, reasoning = true) => {
    models[id] = model(id, name, family, reasoning)
  }

  if (supportsVersion(version, MINIMUM_CLAUDE_FABLE_5_VERSION)) {
    addModel("claude-fable-5", "Claude Fable 5", "claude-fable")
  }
  if (supportsVersion(version, MINIMUM_CLAUDE_OPUS_4_8_VERSION)) {
    addModel("claude-opus-4-8", "Claude Opus 4.8", "claude-opus")
  }
  if (supportsVersion(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION)) {
    addModel("claude-opus-4-7", "Claude Opus 4.7", "claude-opus")
  }
  addModel("claude-opus-4-6", "Claude Opus 4.6", "claude-opus")
  addModel("claude-opus-4-5", "Claude Opus 4.5", "claude-opus")
  addModel("claude-sonnet-4-6", "Claude Sonnet 4.6", "claude-sonnet")
  addModel("claude-haiku-4-5", "Claude Haiku 4.5", "claude-haiku")

  return {
    id: ID,
    name: "Claude Code",
    source: "custom",
    env: [],
    options: metadata(settings),
    models,
  }
}

export function env(settings: Settings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!settings.homePath) return base
  return {
    ...base,
    HOME: resolveHome(settings.homePath),
  }
}

function resolveHome(homePath: string) {
  if (!homePath) return os.homedir()
  if (homePath === "~") return os.homedir()
  if (homePath.startsWith("~/")) return path.join(os.homedir(), homePath.slice(2))
  return path.resolve(homePath)
}

export async function probe(settings: Settings): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([settings.binaryPath, "--version"], {
      env: env(settings),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  if (code !== 0) {
    return {
      ok: false,
      error: (stderr || stdout || `Claude Code exited with ${code}`).trim(),
    }
  }
  const version = stdout.trim()
  if (!version.toLowerCase().includes("claude")) {
    return {
      ok: false,
      error: `Expected Claude Code, got: ${version || "empty version output"}`,
    }
  }
  return { ok: true, version }
}

type AuthStatus = {
  loggedIn?: boolean
  authMethod?: string
  subscriptionType?: string
  apiProvider?: string
  email?: string
}

export async function authStatus(
  settings: Settings,
): Promise<{ ok: true; status: AuthStatus } | { ok: false; error: string }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([settings.binaryPath, "auth", "status", "--json"], {
      env: env(settings),
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  if (code !== 0) {
    return {
      ok: false,
      error: (stderr || stdout || `Claude Code auth status exited with ${code}`).trim(),
    }
  }
  try {
    const status = JSON.parse(stdout) as AuthStatus
    if (status.loggedIn !== true) {
      return {
        ok: false,
        error: "Claude Code is installed but not authenticated. Run `claude auth login` first.",
      }
    }
    if (status.apiProvider && status.apiProvider !== "firstParty") {
      return {
        ok: false,
        error: `Claude Code is authenticated with ${status.apiProvider}, but this provider requires a Claude subscription login.`,
      }
    }
    return { ok: true, status }
  } catch {
    return {
      ok: false,
      error: "Claude Code auth status returned invalid JSON.",
    }
  }
}

export async function validate(
  settings: Settings,
): Promise<{ ok: true; version: string; status: AuthStatus } | { ok: false; error: string }> {
  const version = await probe(settings)
  if (!version.ok) return version
  const status = await authStatus(settings)
  if (!status.ok) return status
  return { ok: true, version: version.version, status: status.status }
}

function splitArgs(input: string): string[] {
  const args: string[] = []
  let cur = ""
  let quote: "'" | '"' | undefined
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur)
        cur = ""
      }
      continue
    }
    cur += ch
  }
  if (cur) args.push(cur)
  return args
}

function launchArgsToExtraArgs(input: string): Record<string, string | null> | undefined {
  const tokens = splitArgs(input)
  const extra: Record<string, string | null> = {}
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith("-")) continue
    const normalized = token.replace(/^-+/, "")
    if (!normalized) continue
    const equals = normalized.indexOf("=")
    const key = equals >= 0 ? normalized.slice(0, equals) : normalized
    if (!key) continue
    if (equals >= 0) {
      extra[key] = normalized.slice(equals + 1)
      continue
    }
    const next = tokens[i + 1]
    if (next && !next.startsWith("-")) {
      extra[key] = next
      i++
      continue
    }
    extra[key] = null
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

function promptToText(prompt: LanguageModelV3Prompt): string {
  return prompt
    .map((message) => {
      if (message.role === "system") return `<system>\n${message.content}\n</system>`
      const content = message.content
        .map((part) => {
          if (part.type === "text") return part.text
          if (part.type === "reasoning") return part.text
          if (part.type === "tool-result") return `[tool result ${part.toolName}] ${JSON.stringify(part.output)}`
          if (part.type === "tool-call") return `[tool call ${part.toolName}] ${JSON.stringify(part.input)}`
          if (part.type === "file") return `[file ${part.filename ?? part.mediaType}]`
          return ""
        })
        .filter(Boolean)
        .join("\n")
      return `<${message.role}>\n${content}\n</${message.role}>`
    })
    .join("\n\n")
}

function extractText(value: any): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  if (typeof value.result === "string") return value.result
  if (typeof value.text === "string") return value.text
  if (typeof value.delta === "string") return value.delta
  const content = value.message?.content ?? value.content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part?.type === "text" && typeof part.text === "string") return part.text
        return ""
      })
      .join("")
  }
  return ""
}

function finishUsage(value: any): LanguageModelV3Usage {
  return usage(value?.usage ?? value?.message?.usage)
}

function streamEventDelta(message: SDKMessage): { kind: "text" | "reasoning"; text: string } | undefined {
  if (message.type !== "stream_event") return undefined
  const event = message.event as unknown as Record<string, unknown>
  if (event.type !== "content_block_delta") return undefined
  const delta = event.delta as Record<string, unknown> | undefined
  if (!delta) return undefined
  if (delta.type === "text_delta" && typeof delta.text === "string") return { kind: "text", text: delta.text }
  if (typeof delta.text === "string") return { kind: "text", text: delta.text }
  if (typeof delta.thinking === "string") return { kind: "reasoning", text: delta.thinking }
  return undefined
}

function resultErrorText(message: SDKResultMessage) {
  if (message.subtype === "success") return undefined
  const joined = Array.isArray(message.errors) ? message.errors.filter(Boolean).join("\n") : ""
  return joined || message.stop_reason || message.subtype
}

async function* streamClaude(options: {
  settings: Settings
  modelId: string
  prompt: string
  call: LanguageModelV3CallOptions
  createQuery: ClaudeQueryFactory
}): AsyncGenerator<LanguageModelV3StreamPart> {
  const warnings: SharedV3Warning[] = []
  if (options.call.tools?.length) {
    warnings.push({
      type: "unsupported",
      feature: "tools",
      details: "Claude Code provider support for MendCode tool calls is not implemented yet.",
    })
  }
  yield { type: "stream-start", warnings }

  const textID = "claude-code-text"
  const reasoningID = "claude-code-reasoning"
  let started = false
  let reasoningStarted = false
  let finalUsage = usage()
  let finishReason: LanguageModelV3FinishReason = {
    unified: "stop",
    raw: "stop",
  }
  let finalText = ""
  const abortController = new AbortController()
  const onAbort = () => abortController.abort(options.call.abortSignal?.reason)
  if (options.call.abortSignal?.aborted) onAbort()
  else options.call.abortSignal?.addEventListener("abort", onAbort, { once: true })
  const extraArgs = launchArgsToExtraArgs(options.settings.launchArgs)
  let queryRuntime: ReturnType<ClaudeQueryFactory> | undefined

  try {
    queryRuntime = options.createQuery({
      prompt: options.prompt,
      options: {
        abortController,
        cwd: options.settings.workingDirectory || process.cwd(),
        env: env(options.settings),
        model: options.modelId,
        pathToClaudeCodeExecutable: options.settings.binaryPath,
        includePartialMessages: true,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        ...(extraArgs ? { extraArgs } : {}),
      },
    })
    for await (const message of queryRuntime) {
      if (options.call.includeRawChunks) yield { type: "raw", rawValue: message }
      const delta = streamEventDelta(message)
      if (delta?.kind === "text" && delta.text) {
        if (!started) {
          started = true
          yield { type: "text-start", id: textID }
        }
        yield { type: "text-delta", id: textID, delta: delta.text }
        continue
      }
      if (delta?.kind === "reasoning" && delta.text) {
        if (!reasoningStarted) {
          reasoningStarted = true
          yield { type: "reasoning-start", id: reasoningID }
        }
        yield { type: "reasoning-delta", id: reasoningID, delta: delta.text }
        continue
      }
      const text = extractText(message)
      if (text && message.type === "assistant" && !started) {
        finalText += text
      }
      if (message.type === "result") {
        finalUsage = finishUsage(message)
        finishReason = { unified: message.subtype === "success" ? "stop" : "error", raw: message.stop_reason ?? message.subtype }
        const errorText = resultErrorText(message)
        if (errorText) yield { type: "error", error: new Error(errorText) }
        if (message.subtype === "success" && message.result && !started && !finalText) finalText += message.result
      }
    }
  } catch (e) {
    yield { type: "error", error: e }
    if (reasoningStarted) yield { type: "reasoning-end", id: reasoningID }
    if (started) yield { type: "text-end", id: textID }
    yield { type: "finish", usage: finalUsage, finishReason: { unified: "error", raw: e instanceof Error ? e.message : String(e) } }
    return
  } finally {
    options.call.abortSignal?.removeEventListener("abort", onAbort)
    queryRuntime?.close()
  }

  if (finalText && !started) {
    started = true
    yield { type: "text-start", id: textID }
    yield { type: "text-delta", id: textID, delta: finalText }
  }
  if (reasoningStarted) yield { type: "reasoning-end", id: reasoningID }
  if (started) yield { type: "text-end", id: textID }
  yield { type: "finish", usage: finalUsage, finishReason }
}

function streamFromAsyncGenerator<T>(generator: AsyncGenerator<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      const next = await generator.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await generator.return(undefined)
    },
  })
}

class ClaudeCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = "claude-code"
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    private readonly settings: Settings,
    private readonly createQuery: ClaudeQueryFactory,
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const stream = await this.doStream(options)
    const blocks: Record<string, { type: "text" | "reasoning"; text: string }> = {}
    const order: string[] = []
    let finalUsage = usage()
    let finishReason: LanguageModelV3GenerateResult["finishReason"] = { unified: "stop", raw: "stop" }
    let warnings: SharedV3Warning[] = []
    const reader = stream.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value
      if (part.type === "stream-start") warnings = part.warnings
      if (part.type === "text-start") {
        blocks[part.id] = { type: "text", text: "" }
        order.push(part.id)
      }
      if (part.type === "reasoning-start") {
        blocks[part.id] = { type: "reasoning", text: "" }
        order.push(part.id)
      }
      if ((part.type === "text-delta" || part.type === "reasoning-delta") && blocks[part.id]) {
        blocks[part.id].text += part.delta
      }
      if (part.type === "finish") {
        finalUsage = part.usage
        finishReason = part.finishReason
      }
      if (part.type === "error") throw part.error
    }
    const content: LanguageModelV3Content[] = order.flatMap((id) => {
      const block = blocks[id]
      if (!block?.text) return []
      return [{ type: block.type, text: block.text }]
    })
    return {
      content,
      finishReason,
      usage: finalUsage,
      warnings,
    }
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const prompt = promptToText(options.prompt)
    return {
      stream: streamFromAsyncGenerator(
        streamClaude({
          settings: this.settings,
          modelId: this.modelId,
          prompt,
          call: options,
          createQuery: this.createQuery,
        }),
      ),
    }
  }
}

export function createClaudeCode(options: CreateOptions = {}) {
  const settings = normalizeSettings(options)
  return {
    languageModel(modelId: string) {
      return new ClaudeCodeLanguageModel(modelId, settings, options.createQuery ?? query)
    },
  }
}

export * as ClaudeCode from "./claude-code"

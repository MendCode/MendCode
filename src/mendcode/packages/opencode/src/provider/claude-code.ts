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
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
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
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
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

async function* streamClaude(options: {
  settings: Settings
  modelId: string
  prompt: string
  call: LanguageModelV3CallOptions
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

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.modelId,
    ...splitArgs(options.settings.launchArgs),
  ]
  const proc = Bun.spawn([options.settings.binaryPath, ...args], {
    cwd: options.settings.workingDirectory || process.cwd(),
    env: env(options.settings),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  options.call.abortSignal?.addEventListener("abort", () => proc.kill(), { once: true })
  proc.stdin.write(options.prompt)
  proc.stdin.end()

  const textID = "claude-code-text"
  let started = false
  let finalUsage = usage()
  let finishReason: LanguageModelV3FinishReason = {
    unified: "stop",
    raw: "stop",
  }
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  let buffer = ""

  while (true) {
    const part = await reader.read()
    if (part.done) break
    buffer += decoder.decode(part.value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let raw: unknown = trimmed
      try {
        raw = JSON.parse(trimmed)
      } catch {}
      if (options.call.includeRawChunks) yield { type: "raw", rawValue: raw }
      const text = extractText(raw)
      if (text) {
        if (!started) {
          started = true
          yield { type: "text-start", id: textID }
        }
        yield { type: "text-delta", id: textID, delta: text }
      }
      if (raw && typeof raw === "object" && (raw as any).type === "result") {
        finalUsage = finishUsage(raw)
        finishReason = { unified: "stop", raw: (raw as any).subtype ?? "result" }
      }
    }
  }

  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (started) yield { type: "text-end", id: textID }
  if (code !== 0) {
    yield { type: "error", error: new Error(stderr.trim() || `Claude Code exited with ${code}`) }
    yield { type: "finish", usage: finalUsage, finishReason: { unified: "error", raw: String(code) } }
    return
  }
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
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const stream = await this.doStream(options)
    let text = ""
    let finalUsage = usage()
    let finishReason: LanguageModelV3GenerateResult["finishReason"] = { unified: "stop", raw: "stop" }
    const reader = stream.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value
      if (part.type === "text-delta") text += part.delta
      if (part.type === "finish") {
        finalUsage = part.usage
        finishReason = part.finishReason
      }
      if (part.type === "error") throw part.error
    }
    const content: LanguageModelV3Content[] = text ? [{ type: "text", text }] : []
    return {
      content,
      finishReason,
      usage: finalUsage,
      warnings: [],
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
        }),
      ),
    }
  }
}

export function createClaudeCode(options: Partial<Settings> = {}) {
  const settings = normalizeSettings(options)
  return {
    languageModel(modelId: string) {
      return new ClaudeCodeLanguageModel(modelId, settings)
    },
  }
}

export * as ClaudeCode from "./claude-code"

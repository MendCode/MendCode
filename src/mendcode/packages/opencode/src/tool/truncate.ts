import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import * as Log from "@mendcode/core/util/log"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(1)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const MAX_SAVED_BYTES = 8 * 1024 * 1024
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }
export type SavedOutput = { path: string; complete: boolean }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

function savedExcerpt(text: string) {
  const buffer = Buffer.from(text, "utf8")
  if (buffer.byteLength <= MAX_SAVED_BYTES) return text

  const marker = Buffer.from(
    `\n\n[Saved output capped for disk safety: omitted ${buffer.byteLength - MAX_SAVED_BYTES} bytes]\n\n`,
    "utf8",
  )
  const budget = Math.max(0, MAX_SAVED_BYTES - marker.byteLength)
  const head = Math.floor(budget / 2)
  const tail = budget - head
  return Buffer.concat([buffer.subarray(0, head), marker, buffer.subarray(buffer.byteLength - tail)]).toString("utf8")
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  readonly writeOutput: (text: string, options?: { complete?: boolean }) => Effect.Effect<SavedOutput>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const now = Date.now()
      const cutoff = now - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      const remaining: { file: string; size: number; time: number }[] = []
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        if (!stat || stat.type !== "File") continue
        // Missing metadata is not evidence that a fresh tool output is stale.
        const time = Option.getOrElse(stat.mtime, () => new Date(now)).getTime()
        if (time < cutoff) {
          yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
          continue
        }
        const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
        remaining.push({ file, size, time })
      }

      let total = remaining.reduce((sum, entry) => sum + entry.size, 0)
      for (const entry of remaining.toSorted((a, b) => a.time - b.time)) {
        if (total <= MAX_TOTAL_BYTES) break
        yield* fs.remove(entry.file).pipe(Effect.catch(() => Effect.void))
        total -= entry.size
      }
    })

    const writeOutput = Effect.fn("Truncate.writeOutput")(function* (text: string, options?: { complete?: boolean }) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      const complete = (options?.complete ?? true) && Buffer.byteLength(text, "utf8") <= MAX_SAVED_BYTES
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, complete ? text : savedExcerpt(text)).pipe(Effect.orDie)
      yield* cleanup()
      return { path: file, complete }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      return (yield* writeOutput(text)).path
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const saved = yield* writeOutput(text)
      const savedLine = saved.complete
        ? `Full output saved to: ${saved.path}`
        : `Output excerpt saved to: ${saved.path}`

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. ${savedLine}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. ${savedLine}\nUse Grep to search the saved content or Read with offset/limit to view specific sections.`

      return {
        content:
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
        truncated: true,
        outputPath: saved.path,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, writeOutput, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

export * as Truncate from "./truncate"

import { readFile, writeFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { runManaged } from "@mendcode/tools"
import type { FormatterFileReport, FormatterStatusReport } from "../../protocol/src/formatter"
import { formatterCommand, formatterDirectories, loadFormatterRegistry, type FormatterRegistry } from "./formatter-registry"

export const DEFAULT_FORMATTER_TIMEOUT_MS = 4_000
export interface FormatterManager {
  status(input: { cwd: string }): Promise<FormatterStatusReport>
  file(input: { cwd: string; path: string; signal?: AbortSignal; timeoutMs?: number }): Promise<FormatterFileReport>
  stop(): Promise<void>
}

export function createFormatterManager({ which = Bun.which, registryLoader = loadFormatterRegistry, run = runManaged }: {
  which?: (binary: string) => string | null
  registryLoader?: (input: { directory: string }) => Promise<FormatterRegistry> | FormatterRegistry
  run?: typeof runManaged
} = {}): FormatterManager {
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const files = new Map<string, Promise<FormatterFileReport>>()

  async function format(input: Parameters<FormatterManager["file"]>[0]): Promise<FormatterFileReport> {
    const file = resolve(input.cwd, input.path)
    const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])])
    const report: FormatterFileReport = { file, formatted: false, results: [], issues: [] }
    if (signal.aborted) return { ...report, unavailable: "cancelled" }
    const registry = await registryLoader({ directory: resolve(input.cwd) })
    report.issues = registry.issues
    const matching = registry.formatters.filter((spec) => spec.extensions.includes(extname(file)))
    if (!matching.length) return report
    const before = await readFile(file).catch(() => undefined)
    if (!before) return { ...report, unavailable: "cannot read file" }
    const bom = before.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    const directories = await formatterDirectories(input.cwd)
    const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_FORMATTER_TIMEOUT_MS)
    for (const spec of matching) {
      if (signal.aborted) return { ...report, unavailable: "cancelled" }
      const resolved = await formatterCommand(spec, directories, which, { run, signal, deadline })
      if (!resolved.command) {
        if (!resolved.skipped) report.results.push({ name: spec.name, ok: false, message: resolved.reason! })
        if (signal.aborted) return { ...report, unavailable: "cancelled" }
        continue
      }
      if (signal.aborted) return { ...report, unavailable: "cancelled" }
      const remaining = deadline - Date.now()
      if (remaining <= 0) { report.results.push({ name: spec.name, ok: false, message: "timed out" }); break }
      const result = await run({ argv: resolved.command.map((arg) => arg.replaceAll("$FILE", file)), cwd: resolve(input.cwd), env: { ...process.env, ...spec.environment }, timeoutMs: remaining, signal })
      // Formatter output can contain arbitrary source text or env values; only safe outcomes travel to clients.
      const message = result.cancelled ? "cancelled" : result.timedOut ? "timed out" : result.spawnError ? "could not start" : result.exitCode !== 0 ? `exit ${result.exitCode}` : undefined
      report.results.push({ name: spec.name, ok: message === undefined, ...(message ? { message } : {}) })
      if (message === undefined) report.formatted = true
      if (bom) {
        const after = await readFile(file).catch(() => undefined)
        if (after && !after.subarray(0, 3).equals(before.subarray(0, 3))) await writeFile(file, Buffer.concat([before.subarray(0, 3), after]))
      }
      if (result.cancelled || signal.aborted) return { ...report, unavailable: "cancelled" }
      if (result.timedOut) break
    }
    return report
  }

  return {
    async status({ cwd }) {
      const task = status(cwd)
      pending.add(task)
      try { return await task }
      finally { pending.delete(task) }
    },
    file(input) {
      const key = resolve(input.cwd, input.path)
      const previous = files.get(key)
      // Two turns may write the same path; each invocation formats the latest disk content in order.
      const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => format(input))
      files.set(key, task)
      pending.add(task)
      void task.finally(() => { pending.delete(task); if (files.get(key) === task) files.delete(key) }).catch(() => undefined)
      return task
    },
    async stop() {
      lifetime.abort()
      await Promise.allSettled([...pending])
    },
  }

  async function status(cwd: string): Promise<FormatterStatusReport> {
    const registry = await registryLoader({ directory: resolve(cwd) })
    const directories = await formatterDirectories(cwd)
    const deadline = Date.now() + DEFAULT_FORMATTER_TIMEOUT_MS
    const formatters = await Promise.all(registry.formatters.map(async (spec) => {
      const resolved = await formatterCommand(spec, directories, which, { run, signal: lifetime.signal, deadline })
      return { name: spec.name, extensions: [...spec.extensions], enabled: !!resolved.command, ...(resolved.reason ? { reason: resolved.reason } : {}) }
    }))
    return { formatters, issues: registry.issues }
  }
}

import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@mendcode/core/flag/flag"
import { Global } from "@mendcode/core/global"
import * as Log from "@mendcode/core/util/log"
import { MEMORY_CRITICAL_RSS_BYTES, MEMORY_WARN_RSS_BYTES } from "@/util/process-memory"

const log = Log.create({ service: "heap" })
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024
const TELEMETRY_MIN_INTERVAL = 10_000

let timer: Timer | undefined
let lock = false
let armed = true

function telemetryInterval() {
  const value = Number(process.env.MENDCODE_MEMORY_TELEMETRY_INTERVAL_MS)
  if (!Number.isFinite(value) || value <= 0) return MINUTE
  return Math.max(TELEMETRY_MIN_INTERVAL, value)
}

export function start() {
  const snapshotsEnabled = Flag.OPENCODE_AUTO_HEAP_SNAPSHOT
  const telemetryEnabled = process.env.MENDCODE_MEMORY_TELEMETRY === "1"
  const guardrailEnabled = process.env.MENDCODE_MEMORY_GUARDRAIL !== "0"
  if (!snapshotsEnabled && !telemetryEnabled && !guardrailEnabled) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (telemetryEnabled || stat.rss >= MEMORY_WARN_RSS_BYTES) {
      log.info("memory telemetry", {
        pid: process.pid,
        process_role: process.env.OPENCODE_PROCESS_ROLE ?? "main",
        rss: stat.rss,
        heap_total: stat.heapTotal,
        heap_used: stat.heapUsed,
        external: stat.external,
        array_buffers: stat.arrayBuffers,
        guardrail:
          stat.rss >= MEMORY_CRITICAL_RSS_BYTES
            ? "critical"
            : stat.rss >= MEMORY_WARN_RSS_BYTES
              ? "warning"
              : "ok",
      })
    }

    if (!snapshotsEnabled) return
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    log.warn("heap usage exceeded limit", {
      rss: stat.rss,
      heap: stat.heapUsed,
      file,
    })

    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .catch((err) => {
        log.error("failed to write heap snapshot", {
          error: err instanceof Error ? err.message : String(err),
          file,
        })
      })

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, telemetryEnabled ? telemetryInterval() : MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
